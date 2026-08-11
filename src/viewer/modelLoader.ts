import * as THREE from 'three'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { computeViewerMetadataAsync } from './metadata'
import { parseObjDocumentAsync, type ObjDocumentBounds, type ObjDocumentSourceCounts, type ParsedObjDocument } from './objParser'
import { disposeViewerObject } from './renderMode'
import type { LoadedViewerModel } from './internalTypes'
import type { ViewerLoadPhase, ViewerLoadProgress, ViewerModelSource, ViewerModelUpAxis, ViewerResource, ViewerSourceMetadata } from './types'

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

const AUTO_UP_AXIS_RATIO = 0.6

const canonicalCoordinate = (value: number): number => Object.is(value, -0) ? 0 : value

const axisExtent = (bounds: ObjDocumentBounds, axis: 'y' | 'z'): number => Math.max(0, bounds.max[axis] - bounds.min[axis])

/**
 * Resolve the source vertical axis without making ambiguous OBJ files rotate.
 * Photogrammetry site models have a much smaller height extent than either
 * horizontal extent: WebODM writes that height to Z, while conventional Three
 * content writes it to Y.
 */
export function resolveViewerModelUpAxis(upAxis: ViewerModelUpAxis | undefined, bounds: ObjDocumentBounds): Exclude<ViewerModelUpAxis, 'auto'> {
  if (upAxis === 'y' || upAxis === 'z') return upAxis
  const yExtent = axisExtent(bounds, 'y')
  const zExtent = axisExtent(bounds, 'z')
  if (zExtent > 0 && zExtent < yExtent * AUTO_UP_AXIS_RATIO) return 'z'
  return 'y'
}

const transformUpAxisPoint = (point: ObjDocumentBounds['min'], upAxis: 'y' | 'z'): ObjDocumentBounds['min'] => upAxis === 'z'
  ? { x: point.x, y: point.z, z: canonicalCoordinate(-point.y) }
  : { x: point.x, y: point.y, z: point.z }

/** Convert an OBJ-local box to the viewer's canonical Y-up coordinate space. */
export function transformViewerBounds(bounds: ObjDocumentBounds, upAxis: 'y' | 'z'): ObjDocumentBounds {
  const corners = [
    { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
    { x: bounds.min.x, y: bounds.min.y, z: bounds.max.z },
    { x: bounds.min.x, y: bounds.max.y, z: bounds.min.z },
    { x: bounds.min.x, y: bounds.max.y, z: bounds.max.z },
    { x: bounds.max.x, y: bounds.min.y, z: bounds.min.z },
    { x: bounds.max.x, y: bounds.min.y, z: bounds.max.z },
    { x: bounds.max.x, y: bounds.max.y, z: bounds.min.z },
    { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
  ].map((corner) => transformUpAxisPoint(corner, upAxis))
  return {
    min: {
      x: Math.min(...corners.map((corner) => corner.x)),
      y: Math.min(...corners.map((corner) => corner.y)),
      z: Math.min(...corners.map((corner) => corner.z)),
    },
    max: {
      x: Math.max(...corners.map((corner) => corner.x)),
      y: Math.max(...corners.map((corner) => corner.y)),
      z: Math.max(...corners.map((corner) => corner.z)),
    },
  }
}

/** Apply the resolved source axis to a built object before metadata or picking. */
export function applyViewerModelUpAxis(object: THREE.Group, upAxis: 'y' | 'z'): void {
  if (upAxis === 'z') {
    // Surface indexing intentionally removes the model root's matrix so an
    // external normalisation parent cannot change model-local placement DTOs.
    // Keeping the WebODM correction on that root would therefore rotate the
    // visible meshes but be cancelled from surface normals and boundaries.
    // Premultiply each top-level content transform instead: rendering,
    // raycasting, metadata, and surface analysis then share one Y-up frame.
    const zUpToYUp = new THREE.Matrix4().makeRotationX(-Math.PI / 2)
    for (const child of object.children) child.applyMatrix4(zUpToYUp)
  }
  object.updateMatrixWorld(true)
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

function isGzipResource(resource: ViewerResource): boolean {
  if (isFileResource(resource)) return resource.name.toLowerCase().endsWith('.gz')
  if (isInlineDocument(resource, '.obj')) return false
  try {
    return new URL(resource, browserDocumentBaseUrl()).pathname.toLowerCase().endsWith('.gz')
  } catch {
    return resource.split(/[?#]/, 1)[0]?.toLowerCase().endsWith('.gz') ?? false
  }
}

function hasGzipMagic(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 2) return false
  const header = new Uint8Array(bytes, 0, 2)
  return header[0] === 0x1f && header[1] === 0x8b
}

/**
 * Expand gzip-compressed model bytes while retaining the byte-oriented parser
 * path. HTTP clients transparently decode responses carrying
 * `Content-Encoding: gzip`, even when the URL still ends in `.gz`, so plain
 * bytes are intentionally returned unchanged.
 */
export async function decompressGzipBytes(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  if (!hasGzipMagic(bytes)) return bytes
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the bundled sample model')
  }
  const compressedStream = new Response(bytes).body
  if (compressedStream === null) throw new Error('Unable to read the compressed sample model')
  const stream = compressedStream.pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

/** Reads OBJ bytes without first materialising a duplicate JavaScript string. */
async function readResourceBytes(resource: ViewerResource, options: ViewerLoadOptions, extension: string): Promise<ArrayBuffer> {
  if (options.signal?.aborted) throw new DOMException('Model loading was cancelled', 'AbortError')
  if (isFileResource(resource)) {
    const bytes = await resource.arrayBuffer()
    return isGzipResource(resource) ? decompressGzipBytes(bytes) : bytes
  }
  if (isInlineDocument(resource, extension)) {
    const encoded = new TextEncoder().encode(resource)
    return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
  }
  const response = await fetch(resource, { signal: options.signal })
  if (!response.ok) throw new Error(`Unable to read model resource (${String(response.status)} ${response.statusText})`)
  const bytes = await response.arrayBuffer()
  if (options.signal?.aborted) throw new DOMException('Model loading was cancelled', 'AbortError')
  return isGzipResource(resource) ? decompressGzipBytes(bytes) : bytes
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

interface ValidatedWorkerGroup {
  readonly name: string
  readonly materialName: string | null
  readonly indices: Uint32Array
  readonly uvIndices: Int32Array
  readonly normalIndices: Int32Array
}

interface TypedWorkerBuffer {
  readonly buffer: ArrayBuffer
  readonly length: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateWorkerBuffer(value: unknown, requestedLength: unknown, bytesPerElement: number): TypedWorkerBuffer | null {
  if (!(value instanceof ArrayBuffer)) return null
  if (value.byteLength % bytesPerElement !== 0) return null
  const capacity = value.byteLength / bytesPerElement
  if (requestedLength === undefined) return { buffer: value, length: capacity }
  if (typeof requestedLength !== 'number' || !Number.isSafeInteger(requestedLength) || requestedLength < 0 || requestedLength > capacity) return null
  return { buffer: value, length: requestedLength }
}

function validateWorkerBounds(value: unknown): ObjDocumentBounds | null {
  if (!isRecord(value) || !isRecord(value.min) || !isRecord(value.max)) return null
  const min = value.min
  const max = value.max
  if (![min.x, min.y, min.z, max.x, max.y, max.z].every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null
  return {
    min: { x: min.x as number, y: min.y as number, z: min.z as number },
    max: { x: max.x as number, y: max.y as number, z: max.z as number },
  }
}

function validateWorkerSourceCounts(value: unknown): ObjDocumentSourceCounts | null {
  if (!isRecord(value)) return null
  const fields = [value.vertexCount, value.texcoordCount, value.normalCount, value.polygonCount, value.cornerCount]
  if (!fields.every((entry) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0)) return null
  return {
    vertexCount: value.vertexCount as number,
    texcoordCount: value.texcoordCount as number,
    normalCount: value.normalCount as number,
    polygonCount: value.polygonCount as number,
    cornerCount: value.cornerCount as number,
  }
}

function sourceCountsFromWorkerStreams(
  positionsLength: number,
  texcoordsLength: number,
  normalsLength: number,
  groups: readonly ValidatedWorkerGroup[],
): ObjDocumentSourceCounts {
  let cornerCount = 0
  let polygonCount = 0
  for (const group of groups) {
    cornerCount += group.indices.length
    polygonCount += Math.floor(group.indices.length / 3)
  }
  return {
    vertexCount: Math.floor(positionsLength / 3),
    texcoordCount: Math.floor(texcoordsLength / 2),
    normalCount: Math.floor(normalsLength / 3),
    polygonCount,
    cornerCount,
  }
}

function sourceCountsForParsed(parsed: ParsedObjDocument): ObjDocumentSourceCounts {
  return parsed.sourceCounts ?? sourceCountsFromWorkerStreams(parsed.positions.length, parsed.texcoords.length, parsed.normals.length, parsed.groups)
}

function zeroObjBounds(): ObjDocumentBounds {
  return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
}

function boundsFromPositions(positions: Float32Array): ObjDocumentBounds {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    const x = positions[offset] ?? 0
    const y = positions[offset + 1] ?? 0
    const z = positions[offset + 2] ?? 0
    if (![x, y, z].every((value) => Number.isFinite(value))) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
  }
  return Number.isFinite(minX) && Number.isFinite(maxX)
    ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
    : zeroObjBounds()
}

function boundsFromReferencedPositions(positions: Float32Array, groups: readonly ValidatedWorkerGroup[]): ObjDocumentBounds {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const group of groups) {
    for (const positionIndex of group.indices) {
      const offset = positionIndex * 3
      const x = positions[offset] ?? 0
      const y = positions[offset + 1] ?? 0
      const z = positions[offset + 2] ?? 0
      if (![x, y, z].every((value) => Number.isFinite(value))) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      minZ = Math.min(minZ, z)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      maxZ = Math.max(maxZ, z)
    }
  }
  return Number.isFinite(minX) && Number.isFinite(maxX)
    ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
    : zeroObjBounds()
}

function workerGroupsReferenceValidPositions(groups: readonly ValidatedWorkerGroup[], positionsLength: number): boolean {
  const vertexCount = Math.floor(positionsLength / 3)
  for (const group of groups) {
    for (const positionIndex of group.indices) {
      if (positionIndex >= vertexCount) return false
    }
  }
  return true
}

function sourceMetadataForParsed(parsed: ParsedObjDocument): ViewerSourceMetadata {
  const { min, max } = parsed.bounds
  const referenced = parsed.referencedBounds ?? parsed.bounds
  const sourceCounts = sourceCountsForParsed(parsed)
  return {
    vertexCount: sourceCounts.vertexCount,
    polygonCount: sourceCounts.polygonCount,
    bounds: {
      min,
      max,
      size: {
        x: max.x - min.x,
        y: max.y - min.y,
        z: max.z - min.z,
      },
    },
    renderedBounds: {
      min: referenced.min,
      max: referenced.max,
      size: {
        x: referenced.max.x - referenced.min.x,
        y: referenced.max.y - referenced.min.y,
        z: referenced.max.z - referenced.min.z,
      },
    },
  }
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
      try {
        worker.terminate()
      } catch {
        // A worker may already have terminated itself after posting a result.
      }
    }
    const finishError = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const abort = (): void => {
      finishError(new DOMException('Model loading was cancelled', 'AbortError'))
    }
    worker.onmessage = (event: MessageEvent<unknown>): void => {
      if (settled) return
      try {
        if (!isRecord(event.data)) {
          throw new Error('OBJ worker returned an invalid response')
        }
        const value = event.data
        if (value.type === 'error') {
          finishError(new Error(typeof value.message === 'string' ? value.message : 'OBJ worker failed'))
          return
        }
        if (value.type !== 'result') throw new Error('OBJ worker returned an invalid response type')
        const positions = validateWorkerBuffer(value.positions, value.positionsLength, 4)
        const texcoords = validateWorkerBuffer(value.texcoords, value.texcoordsLength, 4)
        const normals = validateWorkerBuffer(value.normals, value.normalsLength, 4)
        if (positions === null || texcoords === null || normals === null) throw new Error('OBJ worker returned malformed attribute buffers')
        if (!Array.isArray(value.groups)) throw new Error('OBJ worker returned malformed groups')
        const groups: ValidatedWorkerGroup[] = []
        for (const rawGroup of value.groups) {
          if (!isRecord(rawGroup)) throw new Error('OBJ worker returned a malformed group')
          const indices = validateWorkerBuffer(rawGroup.indices, rawGroup.indicesLength, 4)
          const uvIndices = validateWorkerBuffer(rawGroup.uvIndices, rawGroup.uvIndicesLength, 4)
          const normalIndices = validateWorkerBuffer(rawGroup.normalIndices, rawGroup.normalIndicesLength, 4)
          if (indices === null || uvIndices === null || normalIndices === null) throw new Error('OBJ worker returned malformed group buffers')
          const materialName = rawGroup.materialName === undefined || rawGroup.materialName === null
            ? null
            : typeof rawGroup.materialName === 'string' ? rawGroup.materialName : null
          const name = typeof rawGroup.name === 'string' ? rawGroup.name : 'default'
          groups.push({
            name,
            materialName,
            indices: new Uint32Array(indices.buffer, 0, indices.length),
            uvIndices: new Int32Array(uvIndices.buffer, 0, uvIndices.length),
            normalIndices: new Int32Array(normalIndices.buffer, 0, normalIndices.length),
          })
        }
        if (!workerGroupsReferenceValidPositions(groups, positions.length)) throw new Error('OBJ worker returned malformed position indices')
        const sourceCounts = value.sourceCounts === undefined
          ? sourceCountsFromWorkerStreams(positions.length, texcoords.length, normals.length, groups)
          : validateWorkerSourceCounts(value.sourceCounts)
        if (sourceCounts === null) throw new Error('OBJ worker returned malformed source counts')
        const positionValues = new Float32Array(positions.buffer, 0, positions.length)
        const bounds = value.bounds === undefined ? boundsFromPositions(positionValues) : validateWorkerBounds(value.bounds)
        if (bounds === null) throw new Error('OBJ worker returned malformed bounds')
        const referencedBounds = value.referencedBounds === undefined
          ? boundsFromReferencedPositions(positionValues, groups)
          : validateWorkerBounds(value.referencedBounds)
        if (referencedBounds === null) throw new Error('OBJ worker returned malformed referenced bounds')
        settled = true
        cleanup()
        resolve({
          positions: positionValues,
          texcoords: new Float32Array(texcoords.buffer, 0, texcoords.length),
          normals: new Float32Array(normals.buffer, 0, normals.length),
          bounds,
          referencedBounds,
          sourceCounts,
          groups,
        })
      } catch (error) {
        finishError(error)
      }
    }
    worker.onerror = (event): void => {
      finishError(new Error(event.message || 'OBJ worker failed'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    try {
      worker.postMessage({ type: 'parse', buffer }, [buffer])
    } catch (error) {
      finishError(error)
    }
  })
}

interface SourceMaterialOwnership {
  readonly detachedMaterials: Set<THREE.Material>
  readonly sharedTextures: Set<THREE.Texture>
  disposed: boolean
}

const materialCreatorOwnership = new WeakMap<object, SourceMaterialOwnership>()
const objectMaterialOwnership = new WeakMap<THREE.Object3D, SourceMaterialOwnership>()

function materialOwnershipFor(materials: ReturnType<MTLLoader['parse']>): SourceMaterialOwnership {
  const key = materials as unknown as object
  const existing = materialCreatorOwnership.get(key)
  if (existing !== undefined) return existing
  const created: SourceMaterialOwnership = {
    detachedMaterials: new Set(Object.values(materials.materials)),
    sharedTextures: new Set(),
    disposed: false,
  }
  materialCreatorOwnership.set(key, created)
  return created
}

function materialTextures(material: THREE.Material): Set<THREE.Texture> {
  const textures = new Set<THREE.Texture>()
  const properties = material as unknown as Record<string, unknown>
  for (const value of Object.values(properties)) {
    if (value instanceof THREE.Texture) textures.add(value)
  }
  return textures
}

/** Disposes only source materials that were not retained by a rendered mesh. */
function disposeMaterialOwnership(ownership: SourceMaterialOwnership): void {
  if (ownership.disposed) return
  ownership.disposed = true
  const textures = new Set<THREE.Texture>()
  for (const material of ownership.detachedMaterials) {
    for (const texture of materialTextures(material)) {
      if (!ownership.sharedTextures.has(texture)) textures.add(texture)
    }
    try {
      material.dispose()
    } catch {
      // Cleanup must not mask the load error or prevent the remaining resources.
    }
  }
  for (const texture of textures) {
    try {
      texture.dispose()
    } catch {
      // A user-provided texture implementation may throw while being released.
    }
  }
  ownership.detachedMaterials.clear()
  ownership.sharedTextures.clear()
}

function disposeMaterialCreator(materials: ReturnType<MTLLoader['parse']> | undefined): void {
  if (materials === undefined) return
  disposeMaterialOwnership(materialOwnershipFor(materials))
}

function disposeObjectMaterials(object: THREE.Object3D): void {
  const ownership = objectMaterialOwnership.get(object)
  if (ownership === undefined) return
  disposeMaterialOwnership(ownership)
  objectMaterialOwnership.delete(object)
}

interface ViewerMaterialCreator {
  readonly materials: Readonly<Record<string, THREE.Material>>
  readonly preload: () => unknown
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
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

/** Small typed builders avoid allocating corner-sized JS number arrays. */
class Float32AttributeBuilder {
  private buffer = new Float32Array(256)
  public length = 0

  private ensure(extra: number): void {
    const required = this.length + extra
    if (required <= this.buffer.length) return
    let capacity = this.buffer.length
    while (capacity < required) capacity = Math.min(Math.max(required, capacity * 2), 0x3fffffff)
    const next = new Float32Array(capacity)
    next.set(this.buffer)
    this.buffer = next
  }

  public push2(first: number, second: number): void {
    this.ensure(2)
    this.buffer[this.length] = first
    this.buffer[this.length + 1] = second
    this.length += 2
  }

  public push3(first: number, second: number, third: number): void {
    this.ensure(3)
    this.buffer[this.length] = first
    this.buffer[this.length + 1] = second
    this.buffer[this.length + 2] = third
    this.length += 3
  }

  public toArray(): Float32Array {
    return this.length === this.buffer.length ? this.buffer : this.buffer.slice(0, this.length)
  }
}

class Uint32IndexBuilder {
  private buffer = new Uint32Array(256)
  public length = 0

  private ensure(extra: number): void {
    const required = this.length + extra
    if (required <= this.buffer.length) return
    let capacity = this.buffer.length
    while (capacity < required) capacity = Math.min(Math.max(required, capacity * 2), 0x3fffffff)
    const next = new Uint32Array(capacity)
    next.set(this.buffer)
    this.buffer = next
  }

  public push(value: number): void {
    this.ensure(1)
    this.buffer[this.length] = value
    this.length += 1
  }

  public toArray(): Uint32Array {
    return this.length === this.buffer.length ? this.buffer : this.buffer.slice(0, this.length)
  }
}

interface IndexedTupleGeometry {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  readonly uvs?: Float32Array
  readonly normals?: Float32Array
  readonly missingNormal: boolean
}

/**
 * Builds one indexed vertex for each distinct OBJ position/UV/normal tuple.
 * OBJ streams have independent indices, so position indices alone are not
 * sufficient to share a Three.js vertex without changing seams. The tuple key
 * uses source indices (rather than rounded attribute values) and therefore
 * remains deterministic even when two source records happen to have equal
 * values.
 */
function buildIndexedTupleGeometry(
  parsed: ParsedObjDocument,
  group: ParsedObjDocument['groups'][number],
  hasUv: boolean,
  hasNormal: boolean,
): IndexedTupleGeometry {
  const positions = new Float32AttributeBuilder()
  const uvs = hasUv ? new Float32AttributeBuilder() : undefined
  const normals = hasNormal ? new Float32AttributeBuilder() : undefined
  const indices = new Uint32IndexBuilder()
  const tupleToVertex = new Map<string, number>()
  const missingNormalVertices = new Set<number>()
  let missingNormal = false
  for (let corner = 0; corner < group.indices.length; corner += 1) {
    const positionIndex = group.indices[corner] ?? -1
    const uvIndex = hasUv ? (group.uvIndices[corner] ?? -1) : -1
    const normalIndex = hasNormal ? (group.normalIndices[corner] ?? -1) : -1
    if (normalIndex < 0 && hasNormal) missingNormal = true
    const key = `${String(positionIndex)}/${String(uvIndex)}/${String(normalIndex)}`
    const cached = tupleToVertex.get(key)
    if (cached !== undefined) {
      indices.push(cached)
      continue
    }
    const vertex = positions.length / 3
    tupleToVertex.set(key, vertex)
    const positionOffset = positionIndex * 3
    positions.push3(
      parsed.positions[positionOffset] ?? 0,
      parsed.positions[positionOffset + 1] ?? 0,
      parsed.positions[positionOffset + 2] ?? 0,
    )
    if (uvs !== undefined) {
      const uvOffset = uvIndex * 2
      uvs.push2(parsed.texcoords[uvOffset] ?? 0, parsed.texcoords[uvOffset + 1] ?? 0)
    }
    if (normals !== undefined) {
      const normalOffset = normalIndex * 3
      if (normalIndex >= 0) normals.push3(parsed.normals[normalOffset] ?? 0, parsed.normals[normalOffset + 1] ?? 0, parsed.normals[normalOffset + 2] ?? 0)
      else {
        normals.push3(0, 1, 0)
        missingNormalVertices.add(vertex)
      }
    }
    indices.push(vertex)
  }
  const positionArray = positions.toArray()
  const indexArray = indices.toArray()
  const normalArray = normals?.toArray()
  if (normalArray !== undefined && missingNormalVertices.size > 0) {
    const sums = new Float32Array(normalArray.length)
    const addFaceNormal = (vertex: number, normalX: number, normalY: number, normalZ: number): void => {
      if (!missingNormalVertices.has(vertex)) return
      const offset = vertex * 3
      sums[offset] = (sums[offset] ?? 0) + normalX
      sums[offset + 1] = (sums[offset + 1] ?? 0) + normalY
      sums[offset + 2] = (sums[offset + 2] ?? 0) + normalZ
    }
    for (let corner = 0; corner + 2 < indexArray.length; corner += 3) {
      const first = (indexArray[corner] ?? 0) * 3
      const second = (indexArray[corner + 1] ?? 0) * 3
      const third = (indexArray[corner + 2] ?? 0) * 3
      const ax = (positionArray[second] ?? 0) - (positionArray[first] ?? 0)
      const ay = (positionArray[second + 1] ?? 0) - (positionArray[first + 1] ?? 0)
      const az = (positionArray[second + 2] ?? 0) - (positionArray[first + 2] ?? 0)
      const bx = (positionArray[third] ?? 0) - (positionArray[first] ?? 0)
      const by = (positionArray[third + 1] ?? 0) - (positionArray[first + 1] ?? 0)
      const bz = (positionArray[third + 2] ?? 0) - (positionArray[first + 2] ?? 0)
      const normalX = ay * bz - az * by
      const normalY = az * bx - ax * bz
      const normalZ = ax * by - ay * bx
      addFaceNormal(indexArray[corner] ?? 0, normalX, normalY, normalZ)
      addFaceNormal(indexArray[corner + 1] ?? 0, normalX, normalY, normalZ)
      addFaceNormal(indexArray[corner + 2] ?? 0, normalX, normalY, normalZ)
    }
    for (const vertex of missingNormalVertices) {
      const offset = vertex * 3
      const length = Math.hypot(sums[offset] ?? 0, sums[offset + 1] ?? 0, sums[offset + 2] ?? 0)
      if (length > Number.EPSILON) {
        normalArray[offset] = (sums[offset] ?? 0) / length
        normalArray[offset + 1] = (sums[offset + 1] ?? 0) / length
        normalArray[offset + 2] = (sums[offset + 2] ?? 0) / length
      } else {
        normalArray[offset] = 0
        normalArray[offset + 1] = 1
        normalArray[offset + 2] = 0
      }
    }
  }
  return {
    positions: positionArray,
    indices: indexArray,
    ...(uvs === undefined ? {} : { uvs: uvs.toArray() }),
    ...(normalArray === undefined ? {} : { normals: normalArray }),
    missingNormal,
  }
}

/** Waits for MTL-managed maps before returning ownership to the viewer. */
export async function waitForMaterialTextures(materials: ViewerMaterialCreator, manager: THREE.LoadingManager, signal?: AbortSignal): Promise<void> {
  let resolveReady: (() => void) | undefined
  let rejectReady: ((error: unknown) => void) | undefined
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
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
    try {
      if (typeof previousLoad === 'function') previousLoad()
    } finally {
      resolveReady?.()
    }
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
  const abort = (): void => {
    rejectReady?.(new DOMException('Model loading was cancelled', 'AbortError'))
  }
  manager.onStart = onStart
  manager.onLoad = onLoad
  manager.itemStart = itemStart
  manager.itemEnd = itemEnd
  manager.itemError = itemError
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) {
      abort()
      await ready
      return
    }
    const preloadResult = materials.preload()
    const preloadDone = isPromiseLike(preloadResult) ? Promise.resolve(preloadResult) : undefined
    // LoadingManager does not expose its pending count. The wrappers above
    // let us distinguish an asynchronous texture lifecycle from a creator
    // whose materials were already populated (or have no maps at all).
    if (!lifecycle.started && lifecycle.pending === 0) {
      if (preloadDone === undefined) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      } else {
        await Promise.race([preloadDone, ready])
      }
      if (!lifecycle.completed) resolveReady?.()
      await ready
    } else {
      await ready
    }
  } finally {
    signal?.removeEventListener('abort', abort)
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
  const sourceOwnership = materials === undefined ? undefined : materialOwnershipFor(materials)
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
    sourceOwnership?.detachedMaterials.add(material)
    // Photogrammetry OBJ winding is not reliable. Keep imported surfaces
    // visible and raycastable from above regardless of winding direction.
    material.side = THREE.DoubleSide
    if (!preferFlat) {
      for (const texture of materialTextures(material)) sourceOwnership?.sharedTextures.add(texture)
      sourceOwnership?.detachedMaterials.delete(material)
      materialCache.set(materialName, material)
      return material
    }
    const flat = flatMaterialFromImported(material)
    // Only maps carried by the unlit clone remain attached to the rendered
    // object. Other source maps (normal/roughness/env/etc.) stay detached so
    // their GPU resources are released by the source-material owner.
    for (const texture of materialTextures(flat)) sourceOwnership?.sharedTextures.add(texture)
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
        // OBJ position, UV, and normal streams may use different indices. Build
        // a deterministic indexed tuple table instead of expanding every face
        // corner into a unique BufferGeometry vertex.
        const tupleGeometry = buildIndexedTupleGeometry(parsed, group, hasUv, hasNormal)
        geometry.setAttribute('position', new THREE.BufferAttribute(tupleGeometry.positions, 3))
        geometry.setIndex(new THREE.BufferAttribute(tupleGeometry.indices, 1))
        // Tuple indices preserve render seams, not OBJ position identity: the
        // same physical endpoint can occur more than once when UVs or normals
        // split across adjacent faces. Surface grouping must therefore join
        // endpoints by coordinate instead of treating tuple indices as unique
        // positions. Keep that distinction explicit on the geometry so normal
        // indexed meshes retain the faster source-index path.
        geometry.userData.surfaceVertexIdentity = 'coordinate'
        if (tupleGeometry.uvs !== undefined) geometry.setAttribute('uv', new THREE.BufferAttribute(tupleGeometry.uvs, 2))
        if (tupleGeometry.normals !== undefined) geometry.setAttribute('normal', new THREE.BufferAttribute(tupleGeometry.normals, 3))
        if (tupleGeometry.normals === undefined && faceCount <= MAX_SYNC_NORMAL_FACES) geometry.computeVertexNormals()
      }
      const mesh = new THREE.Mesh(geometry, materialFor(group.materialName, !hasNormal && faceCount > MAX_SYNC_NORMAL_FACES))
      mesh.receiveShadow = true
      mesh.name = group.name
      object.add(mesh)
    }
  } catch (error) {
    disposeViewerObject(object)
    if (sourceOwnership !== undefined) disposeMaterialOwnership(sourceOwnership)
    throw error
  }
  if (sourceOwnership !== undefined) objectMaterialOwnership.set(object, sourceOwnership)
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
      await waitForMaterialTextures(materials, manager, options.signal)
    }

    if (options.signal?.aborted) throw new DOMException('Model loading was cancelled', 'AbortError')
    report('parsing', 0.62, 1, 1, resourceName(source.obj, 'model.obj'))
    const parsed = await parseObjOffThread(inlineObj ?? objBytes ?? new ArrayBuffer(0), options.signal)
    const parsedCounts = sourceCountsForParsed(parsed)
    const renderableTriangleCount = parsed.groups.reduce(
      (count, group) => count + Math.floor(group.indices.length / 3),
      0,
    )
    if (parsedCounts.vertexCount < 3 || parsedCounts.polygonCount < 1 || renderableTriangleCount < 1) {
      throw new Error('OBJ contains no renderable triangle geometry')
    }
    const object = buildViewerObject(parsed, materials, source.name ?? resourceName(source.obj, 'Site model'))
    builtObject = object
    const resolvedUpAxis = resolveViewerModelUpAxis(source.upAxis, parsed.referencedBounds ?? parsed.bounds)
    applyViewerModelUpAxis(object, resolvedUpAxis)
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      try {
        disposeViewerObject(object)
      } finally {
        disposeObjectMaterials(object)
        registry.dispose()
      }
    }
    disposeBuiltObject = dispose
    report('finalising', 0.94, 1, 1)
    if (options.signal?.aborted) throw new DOMException('Model loading was cancelled', 'AbortError')
    options.onObjectReady?.(object, dispose, transformViewerBounds(parsed.referencedBounds ?? parsed.bounds, resolvedUpAxis))
    const metadata = await computeViewerMetadataAsync(object, source.name ?? resourceName(source.obj, 'Site model'), false, {
      signal: options.signal,
      chunkSize: 4_096,
      source: sourceMetadataForParsed(parsed),
    })
    report('complete', 1, 1, 1)
    return { object, metadata, dispose }
  } catch (error) {
    if (disposeBuiltObject !== undefined) disposeBuiltObject()
    else if (builtObject !== undefined) {
      try {
        disposeViewerObject(builtObject)
      } finally {
        disposeObjectMaterials(builtObject)
      }
    }
    else disposeMaterialCreator(materials)
    registry.dispose()
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) throw error
    throw error instanceof Error ? error : new Error(String(error))
  }
}
