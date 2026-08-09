import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { TextureLoader } from 'three'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { buildViewerObject, createViewerResourceRegistry, loadViewerModel, resourceBaseUrl, waitForMaterialTextures } from './modelLoader'
import type { ParsedObjDocument } from './objParser'
import { disposeViewerObject } from './renderMode'

describe('viewer resource mapping and model loading', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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
})
