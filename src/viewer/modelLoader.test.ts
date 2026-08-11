import { afterEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import * as THREE from 'three'
import { TextureLoader } from 'three'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { buildViewerObject, createViewerResourceRegistry, decompressGzipBytes, loadViewerModel, resolveViewerModelUpAxis, resourceBaseUrl, transformViewerBounds, waitForMaterialTextures } from './modelLoader'
import type { ObjDocumentBounds, ParsedObjDocument } from './objParser'
import { disposeViewerObject } from './renderMode'

describe('viewer resource mapping and model loading', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('decompresses gzip model bytes without converting through a string', async () => {
    const source = new TextEncoder().encode('v 0 0 0\nf 1 1 1\n')
    const compressedBuffer = gzipSync(source)
    const compressed = compressedBuffer.buffer.slice(compressedBuffer.byteOffset, compressedBuffer.byteOffset + compressedBuffer.byteLength)

    const decompressed = await decompressGzipBytes(compressed)

    expect(new TextDecoder().decode(decompressed)).toBe('v 0 0 0\nf 1 1 1\n')
  })

  it('accepts model bytes already decoded from an HTTP gzip response', async () => {
    const decoded = new TextEncoder().encode('v 0 0 0\nf 1 1 1\n')
    const decodedBuffer = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength)

    const result = await decompressGzipBytes(decodedBuffer)

    expect(result).toBe(decodedBuffer)
    expect(new TextDecoder().decode(result)).toBe('v 0 0 0\nf 1 1 1\n')
  })

  it('detects WebODM Z-up bounds while preserving conventional and ambiguous Y-up models', () => {
    const webOdmBounds = { min: { x: -50, y: -45, z: -24 }, max: { x: 65, y: 55, z: -8 } }
    const conventionalBounds = { min: { x: -20, y: 0, z: -15 }, max: { x: 20, y: 8, z: 15 } }
    const ambiguousBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 8, z: 9 } }

    expect(resolveViewerModelUpAxis('auto', webOdmBounds)).toBe('z')
    expect(resolveViewerModelUpAxis(undefined, conventionalBounds)).toBe('y')
    expect(resolveViewerModelUpAxis('auto', ambiguousBounds)).toBe('y')
    expect(resolveViewerModelUpAxis('y', webOdmBounds)).toBe('y')
    expect(resolveViewerModelUpAxis('z', conventionalBounds)).toBe('z')
  })

  it('maps Z-up source bounds to canonical Y-up viewer bounds', () => {
    expect(transformViewerBounds(
      { min: { x: -3, y: -8, z: -2 }, max: { x: 7, y: 12, z: 4 } },
      'z',
    )).toEqual({ min: { x: -3, y: -2, z: -12 }, max: { x: 7, y: 4, z: 8 } })
  })

  it('normalises an auto-detected Z-up site before provisional and final framing', async () => {
    let provisionalBounds: ObjDocumentBounds | undefined
    const loaded = await loadViewerModel({
      name: 'Z-up photogrammetry fixture',
      upAxis: 'auto',
      obj: [
        'v 0 0 0',
        'v 10 0 0',
        'v 0 20 0',
        'v 0 0 2',
        'f 1 2 3',
        'f 1 2 4',
      ].join('\n'),
    }, { onObjectReady: (_object, _dispose, bounds) => { provisionalBounds = bounds } })

    expect(provisionalBounds).toEqual({ min: { x: 0, y: 0, z: -20 }, max: { x: 10, y: 2, z: 0 } })
    expect(loaded.metadata.boundingBox.size.x).toBeCloseTo(10)
    expect(loaded.metadata.boundingBox.size.y).toBeCloseTo(2)
    expect(loaded.metadata.boundingBox.size.z).toBeCloseTo(20)
    expect(loaded.object.rotation.x).toBeCloseTo(0)
    const firstMesh = loaded.object.children.find((child) => child instanceof THREE.Mesh)
    expect(firstMesh?.rotation.x).toBeCloseTo(-Math.PI / 2)
    loaded.dispose()
  })

  it('maps local texture basenames to object URLs and revokes them once', () => {
    const createObjectUrl = vi.fn(() => 'blob:roof-texture')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })

    const file = new File(['image'], 'assets/Roof.JPG', { type: 'image/jpeg' })
    const registry = createViewerResourceRegistry([file])
    expect(registry.resolve('Roof.JPG')).toBe('blob:roof-texture')
    expect(registry.resolve('textures/roof.jpg')).toBe('blob:roof-texture')
    registry.dispose()
    registry.dispose()

    expect(createObjectUrl).toHaveBeenCalledWith(file)
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1)
    expect(registry.resolve('Roof.JPG')).toBe('Roof.JPG')
  })

  it('resolves root-relative MTL texture maps against the browser document origin', () => {
    const previousBase = document.baseURI
    Object.defineProperty(document, 'baseURI', { configurable: true, value: 'https://studio.example.test/pvstudio/' })
    const textureUrls: string[] = []
    const textures: THREE.Texture[] = []
    const textureLoad = vi.spyOn(TextureLoader.prototype, 'load').mockImplementation((url: string) => {
      textureUrls.push(url)
      const texture = new THREE.Texture()
      textures.push(texture)
      return texture
    })
    try {
      const baseUrl = resourceBaseUrl('/test-data/synthetic-webodm-house/synthetic-webodm-house.mtl')
      const materials = new MTLLoader().parse('newmtl Roof\nmap_Kd roof-texture.jpg', baseUrl)
      materials.preload()

      expect(baseUrl).toBe('https://studio.example.test/test-data/synthetic-webodm-house/')
      expect(textureUrls).toEqual(['https://studio.example.test/test-data/synthetic-webodm-house/roof-texture.jpg'])
    } finally {
      textureLoad.mockRestore()
      for (const texture of textures) texture.dispose()
      Object.defineProperty(document, 'baseURI', { configurable: true, value: previousBase })
    }
  })

  it('keeps configured app-subpath MTL texture maps under that subpath', () => {
    const previousBase = document.baseURI
    Object.defineProperty(document, 'baseURI', { configurable: true, value: 'https://studio.example.test/' })
    const textureUrls: string[] = []
    const textures: THREE.Texture[] = []
    const textureLoad = vi.spyOn(TextureLoader.prototype, 'load').mockImplementation((url: string) => {
      textureUrls.push(url)
      const texture = new THREE.Texture()
      textures.push(texture)
      return texture
    })
    try {
      const baseUrl = resourceBaseUrl('/pvstudio/test-data/synthetic-webodm-house/synthetic-webodm-house.mtl')
      const materials = new MTLLoader().parse('newmtl Roof\nmap_Kd roof-texture.jpg', baseUrl)
      materials.preload()

      expect(baseUrl).toBe('https://studio.example.test/pvstudio/test-data/synthetic-webodm-house/')
      expect(textureUrls).toEqual(['https://studio.example.test/pvstudio/test-data/synthetic-webodm-house/roof-texture.jpg'])
    } finally {
      textureLoad.mockRestore()
      for (const texture of textures) texture.dispose()
      Object.defineProperty(document, 'baseURI', { configurable: true, value: previousBase })
    }
  })

  it('parses inline OBJ/MTL input and reports progressive completion', async () => {
    const progress: number[] = []
    const loaded = await loadViewerModel({
      name: 'Inline roof',
      obj: [
        'mtllib roof.mtl',
        'o Roof',
        'v 0 0 0',
        'v 2 0 0',
        'v 0 0 2',
        'usemtl Roof',
        'f 1 2 3',
      ].join('\n'),
      mtl: ['newmtl Roof', 'Kd 0.5 0.5 0.5'].join('\n'),
    }, { onProgress: (next) => progress.push(next.progress) })

    expect(loaded.metadata.name).toBe('Inline roof')
    expect(loaded.metadata.meshCount).toBe(1)
    expect(loaded.metadata.polygonCount).toBe(1)
    expect(progress.at(-1)).toBe(1)
    expect(progress.every((value, index) => index === 0 || value >= (progress[index - 1] ?? Number.NEGATIVE_INFINITY))).toBe(true)
    loaded.dispose()
    loaded.dispose()
  })

  it('publishes the built object before asynchronous metadata completes', async () => {
    const events: string[] = []
    let readyObject: THREE.Group | undefined
    const loaded = await loadViewerModel({
      name: 'Ready ordering fixture',
      obj: 'v 0 0 0\nv 2 0 0\nv 0 0 2\nf 1 2 3',
    }, {
      onObjectReady: (object) => {
        events.push('object')
        readyObject = object
      },
      onProgress: (progress) => {
        if (progress.phase === 'complete') events.push('complete')
      },
    })

    expect(readyObject).toBe(loaded.object)
    expect(events).toEqual(['object', 'complete'])
    expect(loaded.metadata.polygonCount).toBe(1)
    loaded.dispose()
  })

  it('uses referenced bounds for provisional and final frames when source vertices are unused', async () => {
    let provisionalBounds: ObjDocumentBounds | undefined
    const loaded = await loadViewerModel({
      name: 'Outlier bounds fixture',
      obj: [
        'v 0 0 0',
        'v 1 0 0',
        'v 0 0 1',
        'v 1000 1000 1000',
        'f 1 2 3',
      ].join('\n'),
    }, {
      onObjectReady: (_object, _dispose, bounds) => { provisionalBounds = bounds },
    })

    expect(provisionalBounds).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 1 } })
    expect(loaded.metadata.boundingBox.max).toEqual({ x: 1, y: 0, z: 1 })
    expect(loaded.metadata.sourceBounds?.max).toEqual({ x: 1000, y: 1000, z: 1000 })
    loaded.dispose()
  })

  it('disposes the object when metadata aborts after object publication', async () => {
    const controller = new AbortController()
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
    try {
      await expect(loadViewerModel({
        name: 'Ready abort fixture',
        obj: 'v 0 0 0\nv 1 0 0\nv 0 0 1\nf 1 2 3',
      }, {
        signal: controller.signal,
        onObjectReady: () => { controller.abort() },
      })).rejects.toMatchObject({ name: 'AbortError' })
      expect(geometryDispose).toHaveBeenCalled()
    } finally {
      geometryDispose.mockRestore()
    }
  })

  it('keeps OBJ UVs aligned with the generated mesh geometry', async () => {
    const loaded = await loadViewerModel({
      name: 'Textured roof fixture',
      obj: [
        'v 0 0 0',
        'v 2 0 0',
        'v 0 0 2',
        'vt 0 0',
        'vt 1 0',
        'vt 0 1',
        'usemtl Roof',
        'f 1/1 2/2 3/3',
      ].join('\n'),
      mtl: 'newmtl Roof\nKd 0.5 0.5 0.5',
    })
    const mesh = loaded.object.children[0]
    expect(mesh).toBeDefined()
    if (mesh instanceof THREE.Mesh) {
      const geometry = mesh.geometry as THREE.BufferGeometry
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
      expect(Array.from(uv.array)).toEqual([0, 0, 1, 0, 0, 1])
      expect((mesh.material as THREE.Material).side).toBe(THREE.DoubleSide)
    }
    loaded.dispose()
  })

  it('deduplicates repeated textured OBJ tuples into indexed geometry', () => {
    const triangleCount = 50_001
    const corners = triangleCount * 3
    const indices = new Uint32Array(corners)
    const uvIndices = new Int32Array(corners)
    for (let corner = 0; corner < corners; corner += 3) {
      indices[corner] = 0
      indices[corner + 1] = 1
      indices[corner + 2] = 2
      uvIndices[corner] = 0
      uvIndices[corner + 1] = 1
      uvIndices[corner + 2] = 2
    }
    const parsed: ParsedObjDocument = {
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, 2]),
      texcoords: new Float32Array([0, 0, 1, 0, 0, 1]),
      normals: new Float32Array(),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 2 } },
      groups: [{ name: 'roof', materialName: null, indices, uvIndices, normalIndices: new Int32Array() }],
    }
    const object = buildViewerObject(parsed, undefined, 'indexed-textured')
    try {
      const mesh = object.children[0]
      expect(mesh).toBeInstanceOf(THREE.Mesh)
      if (!(mesh instanceof THREE.Mesh)) return
      const geometry = mesh.geometry as THREE.BufferGeometry
      const position = geometry.getAttribute('position') as THREE.BufferAttribute
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
      const index = geometry.getIndex()
      expect(position.count).toBe(3)
      expect(uv.count).toBe(3)
      expect(index?.count).toBe(corners)
      // Telemetry-style regression: repeated tuples avoid one vertex per face
      // corner, while the index stream still represents every source triangle.
      expect(position.count).toBeLessThan(corners)
      expect(corners - position.count).toBe(corners - 3)
      expect(Array.from(uv.array)).toEqual([0, 0, 1, 0, 0, 1])
      expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial)
    } finally {
      disposeViewerObject(object)
    }
  })

  it('keeps UV and normal seams distinct while sharing exact repeated tuples', () => {
    const parsed: ParsedObjDocument = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]),
      texcoords: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5]),
      normals: new Float32Array([0, 1, 0, 0, 0, 1]),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 1 } },
      sourceCounts: { vertexCount: 4, texcoordCount: 5, normalCount: 2, polygonCount: 2, cornerCount: 6 },
      groups: [{
        name: 'roof',
        materialName: null,
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        uvIndices: new Int32Array([0, 1, 2, 4, 2, 3]),
        normalIndices: new Int32Array([0, 0, 0, 1, 1, 1]),
      }],
    }
    const object = buildViewerObject(parsed, undefined, 'seamed-texture')
    try {
      const mesh = object.children[0]
      expect(mesh).toBeInstanceOf(THREE.Mesh)
      if (!(mesh instanceof THREE.Mesh)) return
      const geometry = mesh.geometry as THREE.BufferGeometry
      const position = geometry.getAttribute('position') as THREE.BufferAttribute
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
      const normal = geometry.getAttribute('normal') as THREE.BufferAttribute
      expect(position.count).toBe(6)
      expect(uv.count).toBe(position.count)
      expect(normal.count).toBe(position.count)
      expect(geometry.userData.surfaceVertexIdentity).toBe('coordinate')
      expect(Array.from(normal.array)).toEqual([
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
        0, 0, 1,
        0, 0, 1,
        0, 0, 1,
      ])
      expect(geometry.getIndex()?.count).toBe(6)
    } finally {
      disposeViewerObject(object)
    }
  })

  it('preserves explicit normals while filling missing corners consistently for small and large groups', () => {
    const triangleCount = 50_001
    const createParsed = (count: number): ParsedObjDocument => {
      const indices = new Uint32Array(count * 3)
      const normalIndices = new Int32Array(count * 3)
      for (let corner = 0; corner < indices.length; corner += 3) {
        indices[corner] = 0
        indices[corner + 1] = 1
        indices[corner + 2] = 2
        normalIndices[corner] = 0
        normalIndices[corner + 1] = -1
        normalIndices[corner + 2] = 1
      }
      return {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
        texcoords: new Float32Array(),
        normals: new Float32Array([1, 0, 0, 0, 0, 1]),
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 1 } },
        groups: [{ name: 'mixed', materialName: null, indices, uvIndices: new Int32Array(), normalIndices }],
      }
    }
    const small = buildViewerObject(createParsed(1), undefined, 'mixed-small')
    const large = buildViewerObject(createParsed(triangleCount), undefined, 'mixed-large')
    try {
      const smallMesh = small.children[0]
      const largeMesh = large.children[0]
      expect(smallMesh).toBeInstanceOf(THREE.Mesh)
      expect(largeMesh).toBeInstanceOf(THREE.Mesh)
      if (!(smallMesh instanceof THREE.Mesh) || !(largeMesh instanceof THREE.Mesh)) return
      const smallGeometry = smallMesh.geometry as THREE.BufferGeometry
      const largeGeometry = largeMesh.geometry as THREE.BufferGeometry
      const smallNormal = smallGeometry.getAttribute('normal') as THREE.BufferAttribute
      const largeNormal = largeGeometry.getAttribute('normal') as THREE.BufferAttribute
      expect(Array.from(smallNormal.array).slice(0, 9)).toEqual([1, 0, 0, 0, -1, 0, 0, 0, 1])
      expect(Array.from(largeNormal.array).slice(0, 9)).toEqual(Array.from(smallNormal.array).slice(0, 9))
      expect(largeGeometry.getIndex()?.count).toBe(triangleCount * 3)
    } finally {
      disposeViewerObject(small)
      disposeViewerObject(large)
    }
  })

  it('uses a double-sided flat fallback for large no-normal OBJ faces', () => {
    const triangleCount = 50_001
    const indices = new Uint32Array(triangleCount * 3)
    for (let offset = 0; offset < indices.length; offset += 3) {
      // Deliberately downward winding; this must still be visible/raycastable
      // from a camera above the model.
      indices[offset] = 0
      indices[offset + 1] = 2
      indices[offset + 2] = 1
    }
    const parsed: ParsedObjDocument = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
      texcoords: new Float32Array(),
      normals: new Float32Array(),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 1 } },
      sourceCounts: { vertexCount: 3, texcoordCount: 0, normalCount: 0, polygonCount: triangleCount, cornerCount: triangleCount * 3 },
      groups: [{ name: 'roof', materialName: null, indices, uvIndices: new Int32Array(), normalIndices: new Int32Array() }],
    }
    const object = buildViewerObject(parsed, undefined, 'large-no-normal')
    try {
      const mesh = object.children[0]
      expect(mesh).toBeInstanceOf(THREE.Mesh)
      if (!(mesh instanceof THREE.Mesh)) return
      expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial)
      expect((mesh.material as THREE.Material).side).toBe(THREE.DoubleSide)
      expect(mesh.receiveShadow).toBe(true)
      object.updateMatrixWorld(true)
      const raycaster = new THREE.Raycaster(new THREE.Vector3(0.2, 1, 0.2), new THREE.Vector3(0, -1, 0))
      expect(raycaster.intersectObject(mesh, false)).not.toHaveLength(0)
    } finally {
      // The loader owns all resources created for this object.
      object.traverse((child) => {
        if (child instanceof THREE.Mesh) (child.geometry as THREE.BufferGeometry).dispose()
      })
      const material = (object.children[0] as THREE.Mesh | undefined)?.material
      if (material instanceof THREE.Material) material.dispose()
    }
  })

  it('keeps large no-normal MTL meshes visible while preserving the imported map', () => {
    const triangleCount = 50_001
    const indices = new Uint32Array(triangleCount * 3)
    for (let offset = 0; offset < indices.length; offset += 3) {
      indices[offset] = 0
      indices[offset + 1] = 2
      indices[offset + 2] = 1
    }
    const parsed: ParsedObjDocument = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
      texcoords: new Float32Array(),
      normals: new Float32Array(),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 1 } },
      sourceCounts: { vertexCount: 3, texcoordCount: 0, normalCount: 0, polygonCount: triangleCount, cornerCount: triangleCount * 3 },
      groups: [{ name: 'roof', materialName: 'Roof', indices, uvIndices: new Int32Array(), normalIndices: new Int32Array() }],
    }
    const map = new THREE.Texture()
    const imported = new THREE.MeshPhongMaterial({ color: 0x496b61, map, side: THREE.FrontSide })
    const materials = { materials: { Roof: imported }, create: vi.fn(() => imported) } as unknown as ReturnType<MTLLoader['parse']>
    const object = buildViewerObject(parsed, materials, 'large-mtl-no-normal')
    try {
      const mesh = object.children[0]
      expect(mesh).toBeInstanceOf(THREE.Mesh)
      if (!(mesh instanceof THREE.Mesh)) return
      expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial)
      const flat = mesh.material as THREE.MeshBasicMaterial
      expect(flat.side).toBe(THREE.DoubleSide)
      expect(flat.map).toBe(map)
      expect(mesh.receiveShadow).toBe(true)
      expect(flat.color.getHex()).toBe(imported.color.getHex())
      object.updateMatrixWorld(true)
      const raycaster = new THREE.Raycaster(new THREE.Vector3(0.2, 1, 0.2), new THREE.Vector3(0, -1, 0))
      expect(raycaster.intersectObject(mesh, false)).not.toHaveLength(0)
    } finally {
      disposeViewerObject(object)
      imported.dispose()
    }
  })

  it('disposes detached large-model MTL materials and shared maps exactly once', async () => {
    const triangleCount = 50_001
    const faces = Array.from({ length: triangleCount }, () => 'f 1 3 2').join('\n')
    const map = new THREE.Texture()
    const imported = new THREE.MeshPhongMaterial({ map })
    const materialDispose = vi.spyOn(imported, 'dispose')
    const textureDispose = vi.spyOn(map, 'dispose')
    vi.spyOn(MTLLoader.prototype, 'parse').mockReturnValue({
      materials: { Roof: imported },
      preload: (): void => undefined,
      create: vi.fn(() => imported),
    } as unknown as ReturnType<MTLLoader['parse']>)

    try {
      const loaded = await loadViewerModel({
        name: 'Large MTL ownership',
        obj: ['v 0 0 0', 'v 1 0 0', 'v 0 0 1', 'usemtl Roof', faces].join('\n'),
        mtl: 'newmtl Roof',
      })
      loaded.dispose()
      loaded.dispose()
      expect(materialDispose).toHaveBeenCalledTimes(1)
      expect(textureDispose).toHaveBeenCalledTimes(1)
    } finally {
      materialDispose.mockRestore()
      textureDispose.mockRestore()
      map.dispose()
    }
  })

  it('disposes detached normal maps when the large flat clone carries only color maps', async () => {
    const triangleCount = 50_001
    const faces = Array.from({ length: triangleCount }, () => 'f 1 3 2').join('\n')
    const map = new THREE.Texture()
    const normalMap = new THREE.Texture()
    const imported = new THREE.MeshPhongMaterial({ map, normalMap })
    const materialDispose = vi.spyOn(imported, 'dispose')
    const mapDispose = vi.spyOn(map, 'dispose')
    const normalMapDispose = vi.spyOn(normalMap, 'dispose')
    vi.spyOn(MTLLoader.prototype, 'parse').mockReturnValue({
      materials: { Roof: imported },
      preload: (): void => undefined,
      create: vi.fn(() => imported),
    } as unknown as ReturnType<MTLLoader['parse']>)

    try {
      const loaded = await loadViewerModel({
        name: 'Large MTL normal-map ownership',
        obj: ['v 0 0 0', 'v 1 0 0', 'v 0 0 1', 'usemtl Roof', faces].join('\n'),
        mtl: 'newmtl Roof',
      })
      loaded.dispose()
      loaded.dispose()
      expect(materialDispose).toHaveBeenCalledTimes(1)
      expect(mapDispose).toHaveBeenCalledTimes(1)
      expect(normalMapDispose).toHaveBeenCalledTimes(1)
    } finally {
      materialDispose.mockRestore()
      mapDispose.mockRestore()
      normalMapDispose.mockRestore()
      map.dispose()
      normalMap.dispose()
    }
  })

  it('waits for material completion without assuming an existing onLoad callback', async () => {
    const manager = new THREE.LoadingManager()
    const texture = new THREE.Texture()
    const material = new THREE.MeshBasicMaterial({ map: texture })
    const creator = {
      materials: { Roof: material },
      preload: (): void => {
        setTimeout(() => { manager.onLoad() }, 0)
      },
    }
    const managerWithOptionalLoad = manager as unknown as { onLoad: (() => void) | undefined }
    managerWithOptionalLoad.onLoad = undefined

    await expect(waitForMaterialTextures(creator, manager)).resolves.toBeUndefined()
    expect(managerWithOptionalLoad.onLoad).toBeUndefined()
    material.dispose()
    texture.dispose()
  })

  it('does not finish before a LoadingManager item completes', async () => {
    const manager = new THREE.LoadingManager()
    let finished = false
    const creator = {
      materials: {},
      preload: (): void => {
        manager.itemStart('roof.jpg')
        setTimeout(() => {
          finished = true
          manager.itemEnd('roof.jpg')
        }, 5)
      },
    }

    await waitForMaterialTextures(creator, manager)
    expect(finished).toBe(true)
  })

  it('aborts a hanging material preload and restores manager callbacks', async () => {
    const manager = new THREE.LoadingManager()
    const previousLoad = manager.onLoad
    const previousStart = manager.onStart
    const previousItemStart = manager.itemStart
    const previousItemEnd = manager.itemEnd
    const previousItemError = manager.itemError
    const controller = new AbortController()
    const creator = {
      materials: {},
      preload: (): void => { manager.itemStart('never-completes.jpg') },
    }
    const pending = waitForMaterialTextures(creator, manager, controller.signal)
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(manager.onLoad).toBe(previousLoad)
    expect(manager.onStart).toBe(previousStart)
    expect(manager.itemStart).toBe(previousItemStart)
    expect(manager.itemEnd).toBe(previousItemEnd)
    expect(manager.itemError).toBe(previousItemError)
  })

  it('disposes a built object when metadata aborts after finalising', async () => {
    const controller = new AbortController()
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
    try {
      await expect(loadViewerModel({
        name: 'Abort fixture',
        obj: [
          'v 0 0 0',
          'v 1 0 0',
          'v 0 0 1',
          'f 1 2 3',
        ].join('\n'),
      }, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === 'finalising') controller.abort()
        },
      })).rejects.toMatchObject({ name: 'AbortError' })
      expect(geometryDispose).toHaveBeenCalled()
    } finally {
      geometryDispose.mockRestore()
    }
  })

  it('disposes parsed MTL materials and maps when texture preload fails', async () => {
    const texture = new THREE.Texture()
    const material = new THREE.MeshBasicMaterial({ map: texture })
    const materialDispose = vi.spyOn(material, 'dispose')
    const textureDispose = vi.spyOn(texture, 'dispose')
    vi.spyOn(MTLLoader.prototype, 'parse').mockReturnValue({
      materials: { Roof: material },
      preload: (): void => { throw new Error('preload failed') },
    } as unknown as ReturnType<MTLLoader['parse']>)

    await expect(loadViewerModel({
      obj: 'v 0 0 0\nv 1 0 0\nv 0 0 1\nf 1 2 3',
      mtl: 'newmtl Roof',
    })).rejects.toThrow('preload failed')
    expect(materialDispose).toHaveBeenCalledTimes(1)
    expect(textureDispose).toHaveBeenCalledTimes(1)
  })

  it('accepts legacy worker responses with omitted lengths, counts, and bounds', async () => {
    class LegacyWorker {
      public static latest: LegacyWorker | undefined
      public onmessage: ((event: MessageEvent<unknown>) => void) | null = null
      public onerror: ((event: ErrorEvent) => void) | null = null
      public terminated = false

      public constructor() {
        LegacyWorker.latest = this
      }

      public postMessage(): void {
        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]).buffer
        const texcoords = new Float32Array().buffer
        const normals = new Float32Array().buffer
        const indices = new Uint32Array([0, 1, 2]).buffer
        const empty = new Int32Array().buffer
        this.onmessage?.({
          data: {
            type: 'result',
            positions,
            texcoords,
            normals,
            groups: [{ name: 'Roof', materialName: null, indices, uvIndices: empty, normalIndices: empty }],
          },
        } as MessageEvent<unknown>)
      }

      public terminate(): void {
        this.terminated = true
      }
    }

    vi.stubGlobal('Worker', LegacyWorker)
    try {
      const loaded = await loadViewerModel({ obj: 'v 0 0 0\nv 1 0 0\nv 0 0 1\nf 1 2 3' })
      expect(loaded.metadata.sourceVertexCount).toBe(3)
      expect(loaded.metadata.sourcePolygonCount).toBe(1)
      expect(loaded.metadata.boundingBox.max).toEqual({ x: 1, y: 0, z: 1 })
      expect(loaded.metadata.boundingBox.size).toEqual({ x: 1, y: 0, z: 1 })
      expect(LegacyWorker.latest?.terminated).toBe(true)
      loaded.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects malformed worker lengths and always terminates the worker', async () => {
    class MalformedWorker {
      public static latest: MalformedWorker | undefined
      public onmessage: ((event: MessageEvent<unknown>) => void) | null = null
      public onerror: ((event: ErrorEvent) => void) | null = null
      public terminated = false

      public constructor() {
        MalformedWorker.latest = this
      }

      public postMessage(): void {
        this.onmessage?.({
          data: {
            type: 'result',
            positions: new Float32Array([0, 0, 0]).buffer,
            positionsLength: 10,
            texcoords: new ArrayBuffer(0),
            normals: new ArrayBuffer(0),
            groups: [],
          },
        } as MessageEvent<unknown>)
      }

      public terminate(): void {
        this.terminated = true
      }
    }

    vi.stubGlobal('Worker', MalformedWorker)
    try {
      await expect(loadViewerModel({ obj: 'v 0 0 0\nv 1 0 0\nv 0 0 1\nf 1 2 3' })).rejects.toThrow('malformed attribute buffers')
      expect(MalformedWorker.latest?.terminated).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a worker postMessage throw and terminates the worker', async () => {
    class ThrowingWorker {
      public static latest: ThrowingWorker | undefined
      public onmessage: ((event: MessageEvent<unknown>) => void) | null = null
      public onerror: ((event: ErrorEvent) => void) | null = null
      public terminated = false

      public constructor() {
        ThrowingWorker.latest = this
      }

      public postMessage(): void {
        throw new Error('postMessage failed')
      }

      public terminate(): void {
        this.terminated = true
      }
    }

    vi.stubGlobal('Worker', ThrowingWorker)
    try {
      await expect(loadViewerModel({ obj: 'v 0 0 0\nv 1 0 0\nv 0 0 1\nf 1 2 3' })).rejects.toThrow('postMessage failed')
      expect(ThrowingWorker.latest?.terminated).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
