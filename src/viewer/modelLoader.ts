import * as THREE from 'three'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { computeViewerMetadataAsync } from './metadata'
import { parseObjDocumentAsync, type ObjDocumentBounds, type ParsedObjDocument } from './objParser'
import { disposeViewerObject } from './renderMode'
import type { LoadedViewerModel } from './internalTypes'
import type { ViewerLoadPhase, ViewerLoadProgress, ViewerModelSource, ViewerResource } from './types'

export interface ViewerLoadOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: ViewerLoadProgress) => void
  /**
   * Called once the parsed object has been built, before asynchronous metadata
   * collection starts. The loader retains ownership until the returned model
   * resolves (or fails), so consumers must not dispose it from this callback.
   */
  readonly onObjectReady?: (object: THREE.Group, dispose: () => void, bounds: ObjDocumentBounds) => void
}

export interface ViewerResourceRegistry {
  readonly resolve: (url: string) => string
  readonly dispose: () => void
}

function isFileResource(resource: ViewerResource): resource is File {
  return typeof File !== 'undefined' && resource instanceof File
}

function resourceName(resource: ViewerResource, fallback: string): string {
  if (isFileResource(resource)) return resource.name
  // Never feed a multi-megabyte inline OBJ/MTL document to URL parsing. Apart
  // from producing a useless basename, URL's parser may retain a second large
  // string and monopolise the main thread while reporting progress.
  if (typeof resource === 'string' && (resource.length > 4096 || resource.includes('\n') || resource.includes('\r'))) return fallback
  try {
    const url = new URL(resource, typeof window === 'undefined' ? 'http://localhost/' : window.location.href)
    const pathname = url.pathname.split('/').filter(Boolean).pop()
    return pathname === undefined || pathname.length === 0 ? fallback : decodeURIComponent(pathname)
  } catch {
    const parts = resource.replaceAll('\\', '/').split('/')
    return parts.at(-1) || fallback
  }
}

function normalisePath(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value
  try {
    return decodeURIComponent(withoutQuery).replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase()
  } catch {
    return withoutQuery.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase()
  }
}

function aliasesForResource(resource: ViewerResource): readonly string[] {
  const name = resourceName(resource, '')
  const normalised = normalisePath(name)
  const aliases = new Set<string>([normalised])
  const basename = normalised.split('/').at(-1)
  if (basename !== undefined) aliases.add(basename)
  if (typeof resource === 'string') {
    aliases.add(normalisePath(resource))
    try {
      aliases.add(normalisePath(new URL(resource, typeof window === 'undefined' ? 'http://localhost/' : window.location.href).pathname))
    } catch {
      // A string can be an inline OBJ/MTL document; no URL alias is needed.
    }
  }
  return [...aliases].filter((alias) => alias.length > 0)
}

function canCreateObjectUrl(): boolean {
  return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
}

/** Creates a basename-aware URL map for local texture files and revokes it safely. */
export function createViewerResourceRegistry(resources: readonly ViewerResource[] = []): ViewerResourceRegistry {
  const aliases = new Map<string, string>()
  const objectUrls: string[] = []
  for (const resource of resources) {
    if (!isFileResource(resource) || !canCreateObjectUrl()) continue
    const objectUrl = URL.createObjectURL(resource)
    objectUrls.push(objectUrl)
    for (const alias of aliasesForResource(resource)) aliases.set(alias, objectUrl)
  }
  let disposed = false
  return {
    resolve: (url) => {
      if (disposed) return url
      if (url.startsWith('data:') || url.startsWith('blob:')) return url
      return aliases.get(normalisePath(url)) ?? aliases.get(normalisePath(resourceName(url, ''))) ?? url
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl)
      objectUrls.length = 0
      aliases.clear()
    },
  }
}

function isInlineDocument(value: string, extension: string): boolean {
  if (value.includes('\n') || value.includes('\r')) return true
  if (extension === '.obj') return /^\s*(?:v|#|mtllib)\s/m.test(value)
  if (extension === '.mtl') return /^\s*(?:newmtl|#)\s/m.test(value)
  return false
}

async function readResource(resource: ViewerResource, options: ViewerLoadOptions, extension: string): Promise<string> {
  if (options.signal?.aborted) throw new DOMException('Model loading was cancelled', 'AbortError')
  if (isFileResource(resource)) return resource.text()
  if (isInlineDocument(resource, extension)) return resource
  const response = await fetch(resource, { signal: options.signal })
  if (!response.ok) throw new Error(`Unable to read model resource (${String(response.status)} ${response.statusText})`)
  return response.text()
}

/** Reads OBJ bytes without first materialising a duplicate JavaScript string. */
async function readResourceBytes(resource: ViewerResource, options: ViewerLoadOptions, extension: string): Promise<ArrayBuffer> {
  if (options.signal?.aborted) throw new DOMException('Model loading was cancelled', 'AbortError')
  if (isFileResource(resource)) return resource.arrayBuffer()
  if (isInlineDocument(resource, extension)) {
    const encoded = new TextEncoder().encode(resource)
    return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
  }
  const response = await fetch(resource, { signal: options.signal })
  if (!response.ok) throw new Error(`Unable to read model resource (${String(response.status)} ${response.statusText})`)
  return response.arrayBuffer()
}

function progressReporter(options: ViewerLoadOptions): (phase: ViewerLoadPhase, progress: number, itemsLoaded?: number, itemsTotal?: number, url?: string) => void {
  const started = typeof performance === 'undefined' ? Date.now() : performance.now()
  let lastProgress = 0
  return (phase, progress, itemsLoaded = 0, itemsTotal = 0, url) => {
    const bounded = Math.max(lastProgress, Math.min(1, Number.isFinite(progress) ? progress : lastProgress))
    lastProgress = bounded
    const elapsedMs = (typeof performance === 'undefined' ? Date.now() : performance.now()) - started
    const etaMs = bounded > 0.01 && bounded < 1 ? Math.max(0, (elapsedMs / bounded) * (1 - bounded)) : undefined
    options.onProgress?.({ progress: bounded, itemsLoaded, itemsTotal, phase, elapsedMs, ...(etaMs === undefined ? {} : { etaMs }), ...(url === undefined ? {} : { url }) })
  }
}

function browserDocumentBaseUrl(): string {
  const documentBase = typeof document === 'undefined' ? '' : document.baseURI
  if (documentBase.length > 0 && documentBase !== 'about:blank') return documentBase
  const locationBase = typeof window === 'undefined' ? '' : window.location.href
  if (locationBase.length > 0 && locationBase !== 'about:blank') return locationBase
  return 'http://localhost/'
}

/**
 * Resolve an MTL directory against the browser document when the source is a
 * root-relative or app-subpath URL. MTLLoader concatenates map_Kd values onto
 * this directory, so it must retain the fixture's public path. Absolute HTTP
 * URLs keep their own origin; local File and inline-document resources remain
 * URL-less because their texture aliases are handled by the registry.
 */
export function resourceBaseUrl(resource: ViewerResource): string {
  if (isFileResource(resource)) return ''
  if (isInlineDocument(resource, '.mtl')) return ''
  const documentBase = browserDocumentBaseUrl()
  try {
    const resolvedResource = new URL(resource, documentBase)
    return new URL('.', resolvedResource).href
  } catch {
    return ''
  }
}

interface ObjWorkerGroup {
  readonly name: string
  readonly materialName: string | null
  readonly indices: ArrayBuffer
  readonly indicesLength: number
  readonly uvIndices: ArrayBuffer
  readonly uvIndicesLength: number
  readonly normalIndices: ArrayBuffer
  readonly normalIndicesLength: number
}

interface ObjWorkerMessage {
  readonly type: 'result' | 'error'
  readonly positions?: ArrayBuffer
  readonly positionsLength?: number
  readonly texcoords?: ArrayBuffer
  readonly texcoordsLength?: number
  readonly normals?: ArrayBuffer
  readonly normalsLength?: number
  readonly bounds?: ObjDocumentBounds
  readonly groups?: readonly ObjWorkerGroup[]
  readonly message?: string
}

function parseObjOffThread(input: ArrayBuffer | string, signal?: AbortSignal): Promise<ParsedObjDocument> {
  const hasWorker = typeof Worker !== 'undefined' && typeof window !== 'undefined'
  // Keep fallback slices short enough for pointer/render work to run while a
  // large inline document is parsed. The worker path remains the preferred
  // route in browsers; these bounds apply to jsdom/SSR and strict-CSP hosts.
  const fallbackOptions = { signal, chunkSize: 4_096, timeBudgetMs: 4, deriveNormals: false }
  if (!hasWorker && typeof input === 'string') {
    // Inline documents already exist as text. Keep them on the direct async
    // parser path instead of creating an encoded byte buffer only to decode it
    // again in jsdom/SSR where a worker cannot be constructed.
    return parseObjDocumentAsync(input, fallbackOptions)
  }
  const buffer = typeof input === 'string'
    ? (() => {
      const encoded = new TextEncoder().encode(input)
      return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
    })()
    : input
  if (!hasWorker) {
    const text = new TextDecoder().decode(buffer)
    return parseObjDocumentAsync(text, fallbackOptions)
  }
  let worker: Worker
  try {
    worker = new Worker(new URL('./viewerModelWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    const text = new TextDecoder().decode(buffer)
    return parseObjDocumentAsync(text, fallbackOptions)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      worker.onmessage = null
      worker.onerror = null
      signal?.removeEventListener('abort', abort)
      worker.terminate()
    }
    const finishError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = (): void => {
      finishError(new DOMException('Model loading was cancelled', 'AbortError'))
    }
    worker.onmessage = (event: MessageEvent<ObjWorkerMessage>): void => {
      const value = event.data
      if (value.type === 'error') {
        finishError(new Error(value.message ?? 'OBJ worker failed'))
        return
      }
      if (value.positions === undefined || value.texcoords === undefined || value.normals === undefined || value.groups === undefined) {
        finishError(new Error('OBJ worker returned an incomplete result'))
        return
      }
      if (settled) return
      settled = true
      cleanup()
      resolve({
        positions: new Float32Array(value.positions, 0, value.positionsLength),
        texcoords: new Float32Array(value.texcoords, 0, value.texcoordsLength),
        normals: new Float32Array(value.normals, 0, value.normalsLength),
        bounds: value.bounds ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        groups: value.groups.map((group) => ({
          name: group.name,
          materialName: group.materialName,
          indices: new Uint32Array(group.indices, 0, group.indicesLength),
          uvIndices: new Int32Array(group.uvIndices, 0, group.uvIndicesLength),
          normalIndices: new Int32Array(group.normalIndices, 0, group.normalIndicesLength),
        })),
      })
    }
    worker.onerror = (event): void => {
      finishError(new Error(event.message || 'OBJ worker failed'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    worker.postMessage({ type: 'parse', buffer }, [buffer])
  })
}

function disposeMaterialCreator(materials: ReturnType<MTLLoader['parse']> | undefined): void {
  if (materials === undefined) return
  const disposedMaterials = new Set<THREE.Material>()
  const disposedTextures = new Set<THREE.Texture>()
  for (const material of Object.values(materials.materials)) {
    if (disposedMaterials.has(material)) continue
    disposedMaterials.add(material)
    const properties = material as unknown as Record<string, unknown>
    for (const value of Object.values(properties)) {
      if (value instanceof THREE.Texture && !disposedTextures.has(value)) {
        disposedTextures.add(value)
        value.dispose()
      }
    }
    material.dispose()
  }
}

interface ViewerMaterialCreator {
  readonly materials: Readonly<Record<string, THREE.Material>>
  readonly preload: () => unknown
}

/** Avoid a multi-million-vertex synchronous normal pass on the UI thread. */
const MAX_SYNC_NORMAL_FACES = 50_000

interface MaterialWithMap extends THREE.Material {
  map: THREE.Texture | null
}

function hasMaterialMap(material: THREE.Material): material is MaterialWithMap {
  return 'map' in material
}

function materialColor(material: THREE.Material): THREE.Color {
  if ('color' in material && material.color instanceof THREE.Color) return material.color.clone()
  return new THREE.Color(0xa7b8b2)
}

/**
 * Large OBJ streams intentionally skip a synchronous normal derivation. An
 * imported MTL material may therefore be a lighting-dependent Phong/Standard
 * material with no normal attribute, which renders black (and can be
 * back-face culled) while the model is still usable. Keep its texture and
 * appearance parameters, but use an unlit material until worker normals are
 * available. The clone owns the shared map through disposeViewerObject.
 */
function flatMaterialFromImported(source: THREE.Material): THREE.MeshBasicMaterial {
  const map = hasMaterialMap(source) ? source.map : null
  const parameters: THREE.MeshBasicMaterialParameters = {
    color: materialColor(source),
    map,
    side: THREE.DoubleSide,
    transparent: source.transparent,
    opacity: source.opacity,
    alphaTest: source.alphaTest,
    depthTest: source.depthTest,
    depthWrite: source.depthWrite,
  }
  const flat = new THREE.MeshBasicMaterial(parameters)
  flat.name = source.name
  return flat
}

/** Waits for MTL-managed maps before returning ownership to the viewer. */
export async function waitForMaterialTextures(materials: ViewerMaterialCreator, manager: THREE.LoadingManager): Promise<void> {
  let resolveReady: (() => void) | undefined
  const ready = new Promise<void>((resolve) => { resolveReady = resolve })
  const previousStart = manager.onStart
  const previousLoad = manager.onLoad
  const previousItemStart = manager.itemStart
  const previousItemEnd = manager.itemEnd
  const previousItemError = manager.itemError
  const lifecycle = { completed: false, started: false, pending: 0 }
  const onStart = (url: string, loaded: number, total: number): void => {
    previousStart?.(url, loaded, total)
  }
  const onLoad = (): void => {
    if (lifecycle.completed) return
    lifecycle.completed = true
    if (typeof previousLoad === 'function') previousLoad()
    resolveReady?.()
  }
  const itemStart = (url: string): void => {
    lifecycle.started = true
    lifecycle.pending += 1
    previousItemStart.call(manager, url)
  }
  const itemEnd = (url: string): void => {
    lifecycle.pending = Math.max(0, lifecycle.pending - 1)
    previousItemEnd.call(manager, url)
  }
  const itemError = (url: string): void => {
    previousItemError.call(manager, url)
  }
  manager.onStart = onStart
  manager.onLoad = onLoad
  manager.itemStart = itemStart
  manager.itemEnd = itemEnd
  manager.itemError = itemError
  try {
    materials.preload()
    // LoadingManager does not expose its pending count. The wrappers above
    // let us distinguish an asynchronous texture lifecycle from a creator
    // whose materials were already populated (or have no maps at all).
    if (!lifecycle.started && lifecycle.pending === 0) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      if (!lifecycle.completed) resolveReady?.()
    } else {
      await ready
    }
  } finally {
    if (manager.onStart === onStart) manager.onStart = previousStart
    if (manager.onLoad === onLoad) manager.onLoad = previousLoad
    if (manager.itemStart === itemStart) manager.itemStart = previousItemStart
    if (manager.itemEnd === itemEnd) manager.itemEnd = previousItemEnd
    if (manager.itemError === itemError) manager.itemError = previousItemError
  }
}

export function buildViewerObject(parsed: ParsedObjDocument, materials: ReturnType<MTLLoader['parse']> | undefined, name: string): THREE.Group {
  const object = new THREE.Group()
  object.name = name
  let fallbackStandard: THREE.MeshStandardMaterial | undefined
  let fallbackFlat: THREE.MeshBasicMaterial | undefined
  const materialCache = new Map<string, THREE.Material>()
  const flatMaterialCache = new Map<string, THREE.MeshBasicMaterial>()
  const materialFor = (materialName: string | null, preferFlat = false): THREE.Material => {
    if (materialName === null || materials === undefined) {
      const fallback = preferFlat
        ? (fallbackFlat ??= new THREE.MeshBasicMaterial({ color: 0xa7b8b2, side: THREE.DoubleSide }))
        : (fallbackStandard ??= new THREE.MeshStandardMaterial({ color: 0xa7b8b2, roughness: 0.84, metalness: 0.02, side: THREE.DoubleSide }))
      fallback.side = THREE.DoubleSide
      return fallback
    }
    if (preferFlat) {
      const cachedFlat = flatMaterialCache.get(materialName)
      if (cachedFlat !== undefined) {
        cachedFlat.side = THREE.DoubleSide
        return cachedFlat
      }
    } else {
      const cached = materialCache.get(materialName)
      if (cached !== undefined) {
        cached.side = THREE.DoubleSide
        return cached
      }
    }
    const existing = materials.materials[materialName]
    const material = existing ?? materials.create(materialName)
    // Photogrammetry OBJ winding is not reliable. Keep imported surfaces
    // visible and raycastable from above regardless of winding direction.
    material.side = THREE.DoubleSide
    if (!preferFlat) {
      materialCache.set(materialName, material)
      return material
    }
    const flat = flatMaterialFromImported(material)
    flatMaterialCache.set(materialName, flat)
    return flat
  }
  try {
    for (const group of parsed.groups) {
      const geometry = new THREE.BufferGeometry()
      const cornerCount = group.indices.length
      const faceCount = Math.floor(cornerCount / 3)
      const hasUv = group.uvIndices.length === cornerCount && group.uvIndices.some((index) => index >= 0)
      const hasNormal = group.normalIndices.length === cornerCount && group.normalIndices.some((index) => index >= 0)
      const indexedNormals = hasNormal && !hasUv && parsed.normals.length === parsed.positions.length && group.normalIndices.every((index, corner) => index === (group.indices[corner] ?? -1))
      if (!hasUv && (!hasNormal || indexedNormals)) {
        // Worker-generated normals use the position index and keep large OBJ
        // meshes indexed. A fallback parse may omit normals; leave that large
        // stream unexpanded rather than blocking the UI on a normal pass.
        geometry.setAttribute('position', new THREE.BufferAttribute(parsed.positions, 3))
        geometry.setIndex(new THREE.BufferAttribute(group.indices, 1))
        if (indexedNormals) geometry.setAttribute('normal', new THREE.BufferAttribute(parsed.normals, 3))
        else if (faceCount <= MAX_SYNC_NORMAL_FACES) geometry.computeVertexNormals()
      } else {
        // OBJ position, UV, and normal streams may use different indices. Expand
        // corners when needed so each BufferGeometry attribute remains aligned.
        const positions = new Float32Array(cornerCount * 3)
        const uvs = hasUv ? new Float32Array(cornerCount * 2) : undefined
        const normals = hasNormal ? new Float32Array(cornerCount * 3) : undefined
        const missingNormal = hasNormal && group.normalIndices.some((index) => index < 0)
        for (let corner = 0; corner < cornerCount; corner += 1) {
          const positionIndex = group.indices[corner] ?? 0
          const positionOffset = positionIndex * 3
          const destinationOffset = corner * 3
          positions[destinationOffset] = parsed.positions[positionOffset] ?? 0
          positions[destinationOffset + 1] = parsed.positions[positionOffset + 1] ?? 0
          positions[destinationOffset + 2] = parsed.positions[positionOffset + 2] ?? 0
          if (uvs !== undefined) {
            const uvIndex = group.uvIndices[corner] ?? -1
            if (uvIndex >= 0) {
              const uvOffset = uvIndex * 2
              uvs[corner * 2] = parsed.texcoords[uvOffset] ?? 0
              uvs[corner * 2 + 1] = parsed.texcoords[uvOffset + 1] ?? 0
            }
          }
          if (normals !== undefined) {
            const normalIndex = group.normalIndices[corner] ?? -1
            if (normalIndex >= 0) {
              const normalOffset = normalIndex * 3
              normals[destinationOffset] = parsed.normals[normalOffset] ?? 0
              normals[destinationOffset + 1] = parsed.normals[normalOffset + 1] ?? 0
              normals[destinationOffset + 2] = parsed.normals[normalOffset + 2] ?? 0
            } else {
              normals[destinationOffset + 1] = 1
            }
          }
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        if (uvs !== undefined) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
        if (normals !== undefined) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
        if ((normals === undefined || missingNormal) && faceCount <= MAX_SYNC_NORMAL_FACES) geometry.computeVertexNormals()
      }
      const mesh = new THREE.Mesh(geometry, materialFor(group.materialName, !hasNormal && faceCount > MAX_SYNC_NORMAL_FACES))
      mesh.receiveShadow = true
      mesh.name = group.name
      object.add(mesh)
    }
  } catch (error) {
    disposeViewerObject(object)
    throw error
  }
  return object
}

/**
 * Reads and parses an OBJ with optional MTL/textures. All local files stay in
 * memory; object URLs are revoked by the returned model's idempotent dispose.
 */
export async function loadViewerModel(source: ViewerModelSource, options: ViewerLoadOptions = {}): Promise<LoadedViewerModel> {
  const report = progressReporter(options)
  const registry = createViewerResourceRegistry(source.textures ?? [])
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => registry.resolve(url))
  manager.onProgress = (url, loaded, total) => {
    const textureProgress = total > 0 ? loaded / total : 0
    report('textures', 0.68 + textureProgress * 0.22, loaded, total, url)
  }
  manager.onError = (url) => { report('textures', 0.68, 0, 0, url) }

  let materials: ReturnType<MTLLoader['parse']> | undefined
  let builtObject: THREE.Group | undefined
  let disposeBuiltObject: (() => void) | undefined
  try {
    report('reading', 0.02, 0, 1)
    // Keep inline text in its original representation on the no-worker
    // fallback path. Encoding then decoding a large string briefly retains
    // both a 50MB UTF-8 buffer and the original text on the UI thread.
    const inlineObj = typeof source.obj === 'string' && isInlineDocument(source.obj, '.obj') ? source.obj : undefined
    const objBytes = inlineObj === undefined ? await readResourceBytes(source.obj, options, '.obj') : undefined
    report('reading', source.mtl === undefined ? 0.5 : 0.3, 1, source.mtl === undefined ? 1 : 2, resourceName(source.obj, 'model.obj'))

    if (source.mtl !== undefined) {
      const mtlText = await readResource(source.mtl, options, '.mtl')
      report('parsing', 0.45, 2, 2, resourceName(source.mtl, 'materials.mtl'))
      const mtlLoader = new MTLLoader(manager)
      materials = mtlLoader.parse(mtlText, resourceBaseUrl(source.mtl))
      report('materials', 0.58, 2, 2)
      await waitForMaterialTextures(materials, manager)
    }

    if (options.signal?.aborted) throw new DOMException('Model loading was cancelled', 'AbortError')
    report('parsing', 0.62, 1, 1, resourceName(source.obj, 'model.obj'))
    const parsed = await parseObjOffThread(inlineObj ?? objBytes ?? new ArrayBuffer(0), options.signal)
    const object = buildViewerObject(parsed, materials, source.name ?? resourceName(source.obj, 'Site model'))
    builtObject = object
    object.updateMatrixWorld(true)
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      disposeViewerObject(object)
      registry.dispose()
    }
    disposeBuiltObject = dispose
    report('finalising', 0.94, 1, 1)
    if (options.signal?.aborted) throw new DOMException('Model loading was cancelled', 'AbortError')
    options.onObjectReady?.(object, dispose, parsed.bounds)
    const metadata = await computeViewerMetadataAsync(object, source.name ?? resourceName(source.obj, 'Site model'), false, { signal: options.signal, chunkSize: 4_096 })
    report('complete', 1, 1, 1)
    return { object, metadata, dispose }
  } catch (error) {
    if (disposeBuiltObject !== undefined) disposeBuiltObject()
    else if (builtObject !== undefined) disposeViewerObject(builtObject)
    else disposeMaterialCreator(materials)
    registry.dispose()
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) throw error
    throw error instanceof Error ? error : new Error(String(error))
  }
}
