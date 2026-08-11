import * as THREE from 'three'
import { createSurfaceDescriptor, type Point2, type Point3, type SurfaceDescriptor, type SurfaceFrame, type SurfaceRegion } from '../core'
import type { ViewerSurfaceSelection } from './types'

interface ViewerMesh extends THREE.Object3D {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
}

/** Internal renderer representation. This module is not part of the public viewer barrel. */
export interface ViewerSurfaceGroup {
  readonly id: string
  readonly mesh: ViewerMesh
  /**
   * Small groups expose the historical plain array shape. Large groups keep
   * the packed typed slice so grouping does not eagerly duplicate hundreds of
   * thousands of face ids on the main thread; both forms are iterable.
   */
  readonly faceIndices: readonly number[] | Uint32Array
  readonly normal: THREE.Vector3
  readonly center: THREE.Vector3
  /** Model-root-space centroid used to orient frames toward the exterior. */
  readonly exteriorCenter: THREE.Vector3
  /** Mesh transform expressed in the analysed model-root coordinate space. */
  readonly analysisMatrix: THREE.Matrix4
  readonly area: number
  readonly positionTolerance: number
  /** Compact boundary references retained during indexing; vertices are read lazily. */
  readonly boundaryFaces: Uint32Array
  readonly boundaryLocals: Uint8Array
}

export interface ViewerSurfaceHit {
  readonly selection: ViewerSurfaceSelection
  readonly mesh: ViewerMesh
  readonly group: ViewerSurfaceGroup
}

/**
 * Lightweight result returned by the packed picker. The point is always in
 * model-root/analysis coordinates (the same space used by SurfaceSelection).
 * A selection DTO is deliberately not created here: copying a cached
 * descriptor's faceRefs for every pointer move would be O(faceCount). Callers
 * that need a public selection resolve this hit once through
 * `selectionForIntersection`.
 */
export interface ViewerSurfaceRaycastHit {
  readonly mesh: ViewerMesh
  readonly group: ViewerSurfaceGroup
  readonly faceIndex: number
  readonly point: THREE.Vector3
  readonly distance: number
}

export interface ViewerSurfaceIndexOptions {
  readonly signal?: AbortSignal
  /** Faces processed between macrotask yields. */
  readonly chunkSize?: number
  /**
   * Excludes microscopic photogrammetry fragments from the interactive
   * design index without removing them from the rendered model. Low-level
   * grouping callers retain every surface when this option is omitted.
   */
  readonly minimumSurfaceAreaM2?: number
  /**
   * Publishes the selectable surface index before constructing optional
   * raycast acceleration grids. Picking remains correct through the packed
   * face fallback while the grids are prepared cooperatively in the
   * background.
   */
  readonly deferRaycastGrids?: boolean
}

interface IndexedMesh {
  readonly mesh: ViewerMesh
  readonly packed: PackedSurfaceMesh
  /** Original packed group numbers retained as selectable design surfaces. */
  readonly groupNumbers: Uint32Array
  /** O(1) face-group eligibility check for intersection resolution. */
  readonly groupMask: Uint8Array
}

/** A model-scoped, immutable surface index. It owns no public Three.js DTOs. */
export interface ViewerSurfaceIndex {
  readonly modelId: string
  readonly meshes: readonly IndexedMesh[]
  readonly groupsFor: (mesh: ViewerMesh) => readonly ViewerSurfaceGroup[]
  /** Plain descriptors for every selectable group, cached per model index. */
  readonly surfaceDescriptors: () => readonly SurfaceDescriptor[]
  /** Cooperative descriptor materialisation for large models. */
  readonly surfaceDescriptorsAsync: (options?: ViewerSurfaceIndexOptions) => Promise<readonly SurfaceDescriptor[]>
  /** Cooperatively prepares optional picking acceleration after publication. */
  readonly prepareRaycastGridsAsync: (options?: ViewerSurfaceIndexOptions) => Promise<void>
  readonly selectionForIntersection: (intersection: ViewerIntersectionLike) => ViewerSurfaceHit | null
  /** Fast raw model-space picking path used by the R3F event proxy. */
  readonly raycastRawRay: (ray: THREE.Ray) => ViewerSurfaceRaycastHit | null
}

/** The small subset of a Three.js intersection needed by the index. */
export interface ViewerIntersectionLike {
  readonly object: THREE.Object3D
  readonly faceIndex?: number | null
  readonly point: THREE.Vector3
}

/**
 * Prevents Three's default triangle-by-triangle Mesh.raycast from competing
 * with the packed model picker. The returned disposer restores each method so
 * model replacement/render-mode changes retain normal Three ownership.
 */
export function disableViewerModelRaycasts(root: THREE.Object3D): () => void {
  type RaycastFunction = (raycaster: THREE.Raycaster, intersections: THREE.Intersection[]) => void
  const previous: Array<{ readonly mesh: THREE.Object3D; readonly raycast: RaycastFunction }> = []
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const raycast: RaycastFunction = child.raycast.bind(child)
    previous.push({ mesh: child, raycast })
    child.raycast = () => {}
  })
  return () => {
    for (const entry of previous) entry.mesh.raycast = entry.raycast
  }
}

const DEFAULT_TOLERANCE = 0.035
const POSITION_TOLERANCE = 1e-5
const MAX_EDGE_ADJACENCY = 8
const EDGE_LOAD_FACTOR = 0.82

interface SurfaceTolerance {
  readonly normal: number
  readonly plane: number
  readonly position: number
}

/**
 * Packed face/index storage. For F valid faces this is O(F) typed memory:
 * normals/centres/areas/planes, one face-to-group lookup, and one packed list
 * of face ids. No per-face JS objects, tuples, or duplicated vertex positions
 * survive indexing. Group boundary geometry is reconstructed lazily from the
 * source mesh only when a selection is made.
 */
interface PackedSurfaceMesh {
  readonly mesh: ViewerMesh
  readonly faceCount: number
  readonly faceIndices: Uint32Array
  readonly normals: Float32Array
  readonly centers: Float32Array
  readonly areas: Float64Array
  readonly planeOffsets: Float64Array
  readonly faceToGroup: Int32Array
  readonly groupOffsets: Uint32Array
  readonly groupFaces: Uint32Array
  readonly groupNormals: Float32Array
  readonly groupCenters: Float64Array
  readonly groupAreas: Float64Array
  readonly boundaryOffsets: Uint32Array
  readonly boundaryFaces: Uint32Array
  readonly boundaryLocals: Uint8Array
  readonly positionTolerance: number
  readonly exteriorCenter: THREE.Vector3
  readonly analysisMatrix: THREE.Matrix4
  readonly groups: Array<ViewerSurfaceGroup | undefined>
  /** Per-large-group 2D bins; built once and queried without face scans. */
  raycastGrids?: Array<GroupRaycastGrid | null>
  raycastStamps?: Uint32Array
  raycastStamp?: number
  allGroups?: readonly ViewerSurfaceGroup[]
}

interface GroupRaycastGrid {
  readonly minX: number
  readonly minY: number
  readonly width: number
  readonly height: number
  readonly columns: number
  readonly rows: number
  readonly frame: SurfaceFrame
  readonly offsets: Uint32Array
  readonly faces: Uint32Array
}

interface FaceComputationScratch {
  ax: number
  ay: number
  az: number
  bx: number
  by: number
  bz: number
  cx: number
  cy: number
  cz: number
  normalX: number
  normalY: number
  normalZ: number
  doubleArea: number
  centerX: number
  centerY: number
  centerZ: number
  planeOffset: number
  positionIndexA: number
  positionIndexB: number
  positionIndexC: number
  vertexIdA: number
  vertexIdB: number
  vertexIdC: number
  edgeVertexA: number
  edgeVertexB: number
}

interface EdgeTable {
  /** Exact canonical endpoint ids for every occupied open-addressed slot. */
  readonly firstVertices: Uint32Array
  readonly secondVertices: Uint32Array
  readonly heads: Int32Array
  readonly mask: number
}

/**
 * Exact quantised vertex identity table. Hashes choose a probe start only;
 * equality is checked against the representative source position, so hash
 * collisions can never merge different vertices. Representative indices keep
 * this table compact (12 bytes per unique vertex rather than copied vectors).
 */
interface VertexTable {
  readonly slots: Int32Array
  /** Canonical id for each source position, avoiding repeated hash/equality
   * work when indexed geometry references the same vertex across faces. */
  readonly sourceVertexIds: Int32Array | null
  readonly representativeIndices: Uint32Array
  readonly position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
  readonly matrix: THREE.Matrix4
  readonly tolerance: number
  readonly mask: number
  count: number
}

function isViewerMesh(object: THREE.Object3D): object is ViewerMesh {
  return object instanceof THREE.Mesh
}

function abortSurfaceIndex(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Surface indexing was cancelled', 'AbortError')
}

function yieldSurfaceIndexTask(): Promise<void> {
  // Nested zero-delay timers are clamped by browsers.  A large photogrammetry
  // model can need thousands of cooperative slices, turning a few seconds of
  // numeric work into minutes before its selectable surfaces are published.
  // MessageChannel still yields to rendering and pointer work, but schedules
  // the continuation as an unclamped task.  The timer fallback keeps this
  // usable in runtimes without MessageChannel.
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => { setTimeout(resolve, 0) })
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(undefined)
  })
}

function chunkSizeFor(options: ViewerSurfaceIndexOptions): number {
  // Four thousand faces keeps the longest synchronous slice comfortably below
  // a frame on large photogrammetry meshes while retaining a bounded number of
  // macrotask hand-offs for the 500k-face path.
  return Math.max(1, Math.floor(options.chunkSize ?? 4_096))
}

function positionAt(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number): [number, number, number] {
  if (attribute instanceof THREE.BufferAttribute) {
    const offset = index * attribute.itemSize
    const values = attribute.array as ArrayLike<number>
    return [values[offset] ?? 0, values[offset + 1] ?? 0, values[offset + 2] ?? 0]
  }
  return [attribute.getX(index), attribute.getY(index), attribute.getZ(index)]
}

/** Reads a scalar without the virtual getX/getY/getZ call on packed buffers. */
function attributeComponent(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
  component: number,
): number {
  if (attribute instanceof THREE.BufferAttribute) {
    const offset = index * attribute.itemSize + component
    return (attribute.array as ArrayLike<number>)[offset] ?? 0
  }
  if (component === 0) return attribute.getX(index)
  if (component === 1) return attribute.getY(index)
  return attribute.getZ(index)
}

function matrixIsIdentity(matrix: THREE.Matrix4): boolean {
  const elements = matrix.elements
  return elements[0] === 1 && elements[1] === 0 && elements[2] === 0 && elements[3] === 0
    && elements[4] === 0 && elements[5] === 1 && elements[6] === 0 && elements[7] === 0
    && elements[8] === 0 && elements[9] === 0 && elements[10] === 1 && elements[11] === 0
    && elements[12] === 0 && elements[13] === 0 && elements[14] === 0 && elements[15] === 1
}

/** Most indexed geometry has exact endpoint identity; imported tuple seams opt into coordinate identity. */
function assignFaceVertexIds(scratch: FaceComputationScratch, table: VertexTable | null): void {
  if (table === null) {
    scratch.vertexIdA = scratch.positionIndexA
    scratch.vertexIdB = scratch.positionIndexB
    scratch.vertexIdC = scratch.positionIndexC
    return
  }
  scratch.vertexIdA = internVertex(table, scratch.ax, scratch.ay, scratch.az, scratch.positionIndexA)
  scratch.vertexIdB = internVertex(table, scratch.bx, scratch.by, scratch.bz, scratch.positionIndexB)
  scratch.vertexIdC = internVertex(table, scratch.cx, scratch.cy, scratch.cz, scratch.positionIndexC)
}

function coordinateVertexIdentityRequired(geometry: THREE.BufferGeometry): boolean {
  return geometry.index === null || geometry.userData.surfaceVertexIdentity === 'coordinate'
}

function transformPoint(point: readonly [number, number, number], matrix: THREE.Matrix4): [number, number, number] {
  const elements = matrix.elements
  const x = point[0]
  const y = point[1]
  const z = point[2]
  const divisor = elements[3] * x + elements[7] * y + elements[11] * z + elements[15]
  const inverseDivisor = divisor === 0 ? 1 : 1 / divisor
  return [
    (elements[0] * x + elements[4] * y + elements[8] * z + elements[12]) * inverseDivisor,
    (elements[1] * x + elements[5] * y + elements[9] * z + elements[13]) * inverseDivisor,
    (elements[2] * x + elements[6] * y + elements[10] * z + elements[14]) * inverseDivisor,
  ]
}

function dot(firstX: number, firstY: number, firstZ: number, secondX: number, secondY: number, secondZ: number): number {
  return firstX * secondX + firstY * secondY + firstZ * secondZ
}

function analysisBounds(mesh: ViewerMesh, matrix: THREE.Matrix4): THREE.Box3 {
  const bounds = new THREE.Box3()
  const geometryBounds = mesh.geometry.boundingBox
  if (geometryBounds === null) mesh.geometry.computeBoundingBox()
  const localBounds = mesh.geometry.boundingBox
  if (localBounds !== null && !localBounds.isEmpty()) {
    const corners = [
      new THREE.Vector3(localBounds.min.x, localBounds.min.y, localBounds.min.z),
      new THREE.Vector3(localBounds.min.x, localBounds.min.y, localBounds.max.z),
      new THREE.Vector3(localBounds.min.x, localBounds.max.y, localBounds.min.z),
      new THREE.Vector3(localBounds.min.x, localBounds.max.y, localBounds.max.z),
      new THREE.Vector3(localBounds.max.x, localBounds.min.y, localBounds.min.z),
      new THREE.Vector3(localBounds.max.x, localBounds.min.y, localBounds.max.z),
      new THREE.Vector3(localBounds.max.x, localBounds.max.y, localBounds.min.z),
      new THREE.Vector3(localBounds.max.x, localBounds.max.y, localBounds.max.z),
    ]
    for (const corner of corners) bounds.expandByPoint(corner.applyMatrix4(matrix))
    return bounds
  }
  if (!mesh.geometry.hasAttribute('position')) return bounds
  const position = mesh.geometry.getAttribute('position')
  for (let index = 0; index < position.count; index += 1) bounds.expandByPoint(new THREE.Vector3(position.getX(index), position.getY(index), position.getZ(index)).applyMatrix4(matrix))
  return bounds
}

function surfaceTolerance(mesh: ViewerMesh, requested: number, analysisMatrix = mesh.matrixWorld): SurfaceTolerance {
  const bounds = analysisBounds(mesh, analysisMatrix)
  const diagonal = Math.max(bounds.getSize(new THREE.Vector3()).length(), 1)
  return {
    normal: Math.max(1e-6, requested),
    plane: Math.max(POSITION_TOLERANCE, diagonal * Math.max(1e-6, requested * 0.01)),
    position: Math.max(POSITION_TOLERANCE, Math.min(0.01, diagonal * 1e-6)),
  }
}

async function surfaceToleranceAsync(
  mesh: ViewerMesh,
  requested: number,
  options: ViewerSurfaceIndexOptions,
  analysisMatrix = mesh.matrixWorld,
): Promise<SurfaceTolerance> {
  const position = mesh.geometry.getAttribute('position')
  const chunkSize = chunkSizeFor(options)
  const elements = analysisMatrix.elements
  const identity = matrixIsIdentity(analysisMatrix)
  const directPosition = position instanceof THREE.BufferAttribute
  const values = directPosition ? position.array as ArrayLike<number> : undefined
  const itemSize = position.itemSize
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let index = 0; index < position.count; index += 1) {
    const offset = index * itemSize
    const x = values === undefined ? position.getX(index) : values[offset] ?? 0
    const y = values === undefined ? position.getY(index) : values[offset + 1] ?? 0
    const z = values === undefined ? position.getZ(index) : values[offset + 2] ?? 0
    let worldX = x
    let worldY = y
    let worldZ = z
    if (!identity) {
      const divisor = elements[3] * x + elements[7] * y + elements[11] * z + elements[15]
      const inverseDivisor = divisor === 0 ? 1 : 1 / divisor
      worldX = (elements[0] * x + elements[4] * y + elements[8] * z + elements[12]) * inverseDivisor
      worldY = (elements[1] * x + elements[5] * y + elements[9] * z + elements[13]) * inverseDivisor
      worldZ = (elements[2] * x + elements[6] * y + elements[10] * z + elements[14]) * inverseDivisor
    }
    minX = Math.min(minX, worldX)
    minY = Math.min(minY, worldY)
    minZ = Math.min(minZ, worldZ)
    maxX = Math.max(maxX, worldX)
    maxY = Math.max(maxY, worldY)
    maxZ = Math.max(maxZ, worldZ)
    abortSurfaceIndex(options.signal)
    if ((index + 1) % chunkSize === 0 && index + 1 < position.count) await yieldSurfaceIndexTask()
  }
  const diagonal = Number.isFinite(minX) && Number.isFinite(maxX)
    ? Math.max(Math.hypot(maxX - minX, maxY - minY, maxZ - minZ), 1)
    : 1
  return {
    normal: Math.max(1e-6, requested),
    plane: Math.max(POSITION_TOLERANCE, diagonal * Math.max(1e-6, requested * 0.01)),
    position: Math.max(POSITION_TOLERANCE, Math.min(0.01, diagonal * 1e-6)),
  }
}

function mixHash(first: number, second: number, seed: number): number {
  return (Math.imul((first ^ seed) >>> 0, 0x45d9f3b) ^ Math.imul(second >>> 0, 0x27d4eb2d)) >>> 0
}

/** A compact deterministic hash of a quantised world vertex. */
function vertexHash(x: number, y: number, z: number, tolerance: number, seed: number): number {
  const qx = Math.round(x / tolerance)
  const qy = Math.round(y / tolerance)
  const qz = Math.round(z / tolerance)
  const lowX = (qx % 0x100000000 + 0x100000000) % 0x100000000
  const lowY = (qy % 0x100000000 + 0x100000000) % 0x100000000
  const lowZ = (qz % 0x100000000 + 0x100000000) % 0x100000000
  let hash = (seed ^ 0x811c9dc5) >>> 0
  hash = Math.imul(hash ^ lowX, 0x01000193) >>> 0
  hash = Math.imul(hash ^ lowY, 0x01000193) >>> 0
  hash = Math.imul(hash ^ lowZ, 0x01000193) >>> 0
  return hash >>> 0
}

function quantizedCoordinate(value: number, tolerance: number): number {
  const quantized = Math.round(value / tolerance)
  return Number.isFinite(quantized) ? (Object.is(quantized, -0) ? 0 : quantized) : 0
}

function quantizedVertexHash(x: number, y: number, z: number, tolerance: number, seed: number): number {
  return vertexHash(x, y, z, tolerance, seed)
}

/** Finalises a 32-bit probe hash. The low bits must remain well distributed
 * because the compact tables use power-of-two capacities. */
function probeHash(value: number): number {
  let mixed = Math.imul((value ^ (value >>> 16)) >>> 0, 0x21f0aaad)
  mixed = Math.imul((mixed ^ (mixed >>> 15)) >>> 0, 0x735a2d97)
  return (mixed ^ (mixed >>> 15)) >>> 0
}

function vertexProbeStep(primary: number, secondary: number, mask: number): number {
  // The table size is a power of two. An odd step visits every slot, which
  // keeps adversarial hash clusters bounded without a collision chain.
  return ((probeHash((primary + secondary) >>> 0) | 1) & mask) || 1
}

function vertexIdentityMatches(table: VertexTable, vertexId: number, x: number, y: number, z: number): boolean {
  const positionIndex = table.representativeIndices[vertexId] ?? 0
  const elements = table.matrix.elements
  const localOffset = positionIndex * table.position.itemSize
  const localValues = table.position instanceof THREE.BufferAttribute ? table.position.array as ArrayLike<number> : undefined
  const localX = localValues === undefined ? table.position.getX(positionIndex) : localValues[localOffset] ?? 0
  const localY = localValues === undefined ? table.position.getY(positionIndex) : localValues[localOffset + 1] ?? 0
  const localZ = localValues === undefined ? table.position.getZ(positionIndex) : localValues[localOffset + 2] ?? 0
  const divisor = elements[3] * localX + elements[7] * localY + elements[11] * localZ + elements[15]
  const inverseDivisor = divisor === 0 ? 1 : 1 / divisor
  const worldX = (elements[0] * localX + elements[4] * localY + elements[8] * localZ + elements[12]) * inverseDivisor
  const worldY = (elements[1] * localX + elements[5] * localY + elements[9] * localZ + elements[13]) * inverseDivisor
  const worldZ = (elements[2] * localX + elements[6] * localY + elements[10] * localZ + elements[14]) * inverseDivisor
  return quantizedCoordinate(worldX, table.tolerance) === quantizedCoordinate(x, table.tolerance)
    && quantizedCoordinate(worldY, table.tolerance) === quantizedCoordinate(y, table.tolerance)
    && quantizedCoordinate(worldZ, table.tolerance) === quantizedCoordinate(z, table.tolerance)
}

function createVertexTable(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  matrix: THREE.Matrix4,
  tolerance: number,
  cacheSourceIndices: boolean,
): VertexTable {
  const capacity = nextPowerOfTwo(Math.max(8, Math.ceil(position.count / EDGE_LOAD_FACTOR)))
  const slots = new Int32Array(capacity)
  slots.fill(-1)
  return {
    slots,
    sourceVertexIds: cacheSourceIndices ? new Int32Array(position.count).fill(-1) : null,
    representativeIndices: new Uint32Array(position.count),
    position,
    matrix,
    tolerance,
    mask: capacity - 1,
    count: 0,
  }
}

function internVertex(table: VertexTable, x: number, y: number, z: number, positionIndex: number): number {
  if (table.sourceVertexIds !== null && positionIndex >= 0 && positionIndex < table.sourceVertexIds.length) {
    const cached = table.sourceVertexIds[positionIndex] ?? -1
    if (cached >= 0) return cached
  }
  const primary = quantizedVertexHash(x, y, z, table.tolerance, 0x1234)
  const secondary = quantizedVertexHash(x, y, z, table.tolerance, 0x9abc)
  let slot = probeHash(primary ^ secondary) & table.mask
  const step = vertexProbeStep(primary, secondary, table.mask)
  for (let probe = 0; probe <= table.mask; probe += 1) {
    const existing = table.slots[slot] ?? -1
    if (existing < 0) {
      const vertexId = table.count
      if (vertexId >= table.representativeIndices.length) throw new Error('Surface vertex table exhausted')
      table.representativeIndices[vertexId] = positionIndex
      table.slots[slot] = vertexId
      if (table.sourceVertexIds !== null && positionIndex >= 0 && positionIndex < table.sourceVertexIds.length) table.sourceVertexIds[positionIndex] = vertexId
      table.count = vertexId + 1
      return vertexId
    }
    if (vertexIdentityMatches(table, existing, x, y, z)) {
      if (table.sourceVertexIds !== null && positionIndex >= 0 && positionIndex < table.sourceVertexIds.length) table.sourceVertexIds[positionIndex] = existing
      return existing
    }
    slot = (slot + step) & table.mask
  }
  throw new Error('Surface vertex table exhausted')
}

function writeEdgeVertexPair(first: number, second: number, target: FaceComputationScratch): void {
  if (first <= second) {
    target.edgeVertexA = first
    target.edgeVertexB = second
  } else {
    target.edgeVertexA = second
    target.edgeVertexB = first
  }
}

function nextPowerOfTwo(value: number): number {
  let result = 1
  while (result < value && result < 0x40000000) result *= 2
  return result
}

/** Open-addressed numeric edge table. It has no string keys or unbounded buckets. */
function createEdgeTable(edgeCapacity: number): EdgeTable {
  const capacity = nextPowerOfTwo(Math.max(8, Math.ceil(edgeCapacity / EDGE_LOAD_FACTOR)))
  const heads = new Int32Array(capacity)
  heads.fill(-1)
  return {
    firstVertices: new Uint32Array(capacity),
    secondVertices: new Uint32Array(capacity),
    heads,
    mask: capacity - 1,
  }
}

function edgeTableSlot(table: EdgeTable, firstVertex: number, secondVertex: number): number {
  const primaryKey = mixHash(firstVertex, secondVertex, 0x51ed270b)
  const secondaryKey = mixHash(firstVertex, secondVertex, 0x6d2b79f5)
  let slot = probeHash(primaryKey ^ secondaryKey) & table.mask
  const step = vertexProbeStep(primaryKey, secondaryKey, table.mask)
  for (let probe = 0; probe <= table.mask; probe += 1) {
    const head = table.heads[slot] ?? -1
    if (head < 0 || (table.firstVertices[slot] === firstVertex && table.secondVertices[slot] === secondVertex)) return slot
    slot = (slot + step) & table.mask
  }
  // The load factor guarantees this is unreachable for supported models.
  throw new Error('Surface edge table exhausted')
}

function union(parent: Int32Array, first: number, second: number): void {
  let firstRoot = first
  while (parent[firstRoot] !== firstRoot) {
    const next = parent[firstRoot]
    if (next === undefined || next < 0) break
    const nextParent = parent[next]
    if (nextParent === undefined) break
    parent[firstRoot] = nextParent
    firstRoot = next
  }
  let secondRoot = second
  while (parent[secondRoot] !== secondRoot) {
    const next = parent[secondRoot]
    if (next === undefined || next < 0) break
    const nextParent = parent[next]
    if (nextParent === undefined) break
    parent[secondRoot] = nextParent
    secondRoot = next
  }
  if (firstRoot !== secondRoot) parent[secondRoot] = firstRoot
}

function samePlane(
  first: number,
  second: number,
  normals: Float32Array,
  centers: Float32Array,
  planeOffsets: Float64Array,
  tolerance: SurfaceTolerance,
): boolean {
  const firstOffset = first * 3
  const secondOffset = second * 3
  const normalDifference = 1 - Math.abs(dot(
    normals[firstOffset] ?? 0,
    normals[firstOffset + 1] ?? 0,
    normals[firstOffset + 2] ?? 0,
    normals[secondOffset] ?? 0,
    normals[secondOffset + 1] ?? 0,
    normals[secondOffset + 2] ?? 0,
  ))
  const firstPlane = planeOffsets[first] ?? 0
  const secondPlane = planeOffsets[second] ?? 0
  // Comparing plane constants directly is only valid when the normals are
  // identical. Even a small normal difference makes that comparison depend
  // on the model's distance from the world origin, which fragmented real
  // georeferenced photogrammetry into one surface per triangle. Compare each
  // face centre with the other face's plane instead; this is translation
  // invariant and still prevents disconnected, offset planes from merging.
  const firstToSecond = Math.abs(
    (normals[firstOffset] ?? 0) * (centers[secondOffset] ?? 0)
      + (normals[firstOffset + 1] ?? 0) * (centers[secondOffset + 1] ?? 0)
      + (normals[firstOffset + 2] ?? 0) * (centers[secondOffset + 2] ?? 0)
      - firstPlane,
  )
  const secondToFirst = Math.abs(
    (normals[secondOffset] ?? 0) * (centers[firstOffset] ?? 0)
      + (normals[secondOffset + 1] ?? 0) * (centers[firstOffset + 1] ?? 0)
      + (normals[secondOffset + 2] ?? 0) * (centers[firstOffset + 2] ?? 0)
      - secondPlane,
  )
  return normalDifference <= tolerance.normal
    && Math.max(firstToSecond, secondToFirst) <= tolerance.plane
}

function writeWorldPoint(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
  matrix: THREE.Matrix4,
  target: FaceComputationScratch,
  prefix: 'a' | 'b' | 'c',
  identity: boolean,
): void {
  const elements = matrix.elements
  const x = attributeComponent(attribute, index, 0)
  const y = attributeComponent(attribute, index, 1)
  const z = attributeComponent(attribute, index, 2)
  if (identity) {
    if (prefix === 'a') {
      target.ax = x; target.ay = y; target.az = z
    } else if (prefix === 'b') {
      target.bx = x; target.by = y; target.bz = z
    } else {
      target.cx = x; target.cy = y; target.cz = z
    }
    return
  }
  const divisor = elements[3] * x + elements[7] * y + elements[11] * z + elements[15]
  const inverseDivisor = divisor === 0 ? 1 : 1 / divisor
  const worldX = (elements[0] * x + elements[4] * y + elements[8] * z + elements[12]) * inverseDivisor
  const worldY = (elements[1] * x + elements[5] * y + elements[9] * z + elements[13]) * inverseDivisor
  const worldZ = (elements[2] * x + elements[6] * y + elements[10] * z + elements[14]) * inverseDivisor
  if (prefix === 'a') {
    target.ax = worldX; target.ay = worldY; target.az = worldZ
  } else if (prefix === 'b') {
    target.bx = worldX; target.by = worldY; target.bz = worldZ
  } else {
    target.cx = worldX; target.cy = worldY; target.cz = worldZ
  }
}

function computeFace(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null,
  faceIndex: number,
  scratch: FaceComputationScratch,
  matrix: THREE.Matrix4,
  identity: boolean,
): boolean {
  const offset = faceIndex * 3
  const ai = index === null ? offset : attributeComponent(index, offset, 0)
  const bi = index === null ? offset + 1 : attributeComponent(index, offset + 1, 0)
  const ci = index === null ? offset + 2 : attributeComponent(index, offset + 2, 0)
  scratch.positionIndexA = ai
  scratch.positionIndexB = bi
  scratch.positionIndexC = ci
  writeWorldPoint(position, ai, matrix, scratch, 'a', identity)
  writeWorldPoint(position, bi, matrix, scratch, 'b', identity)
  writeWorldPoint(position, ci, matrix, scratch, 'c', identity)
  const abx = scratch.bx - scratch.ax
  const aby = scratch.by - scratch.ay
  const abz = scratch.bz - scratch.az
  const acx = scratch.cx - scratch.ax
  const acy = scratch.cy - scratch.ay
  const acz = scratch.cz - scratch.az
  scratch.normalX = aby * acz - abz * acy
  scratch.normalY = abz * acx - abx * acz
  scratch.normalZ = abx * acy - aby * acx
  scratch.doubleArea = Math.hypot(scratch.normalX, scratch.normalY, scratch.normalZ)
  if (scratch.doubleArea <= Number.EPSILON) return false
  scratch.normalX /= scratch.doubleArea
  scratch.normalY /= scratch.doubleArea
  scratch.normalZ /= scratch.doubleArea
  scratch.centerX = (scratch.ax + scratch.bx + scratch.cx) / 3
  scratch.centerY = (scratch.ay + scratch.by + scratch.cy) / 3
  scratch.centerZ = (scratch.az + scratch.bz + scratch.cz) / 3
  scratch.planeOffset = dot(scratch.normalX, scratch.normalY, scratch.normalZ, scratch.ax, scratch.ay, scratch.az)
  return true
}

function makeScratch(): FaceComputationScratch {
  return {
    ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, cx: 0, cy: 0, cz: 0,
    normalX: 0, normalY: 0, normalZ: 0, doubleArea: 0,
    centerX: 0, centerY: 0, centerZ: 0, planeOffset: 0,
    positionIndexA: 0, positionIndexB: 0, positionIndexC: 0,
    vertexIdA: 0, vertexIdB: 0, vertexIdC: 0,
    edgeVertexA: 0, edgeVertexB: 0,
  }
}

function modelExteriorCenter(root: THREE.Object3D, rootInverse?: THREE.Matrix4): THREE.Vector3 {
  const bounds = new THREE.Box3().setFromObject(root)
  const center = bounds.isEmpty() ? root.getWorldPosition(new THREE.Vector3()) : bounds.getCenter(new THREE.Vector3())
  return rootInverse === undefined ? center : center.applyMatrix4(rootInverse)
}

function meshExteriorCenter(mesh: ViewerMesh, analysisMatrix = mesh.matrixWorld): THREE.Vector3 {
  const bounds = analysisBounds(mesh, analysisMatrix)
  if (!bounds.isEmpty()) return bounds.getCenter(new THREE.Vector3())
  const worldPosition = mesh.getWorldPosition(new THREE.Vector3())
  const transformed = transformPoint([worldPosition.x, worldPosition.y, worldPosition.z], analysisMatrix)
  return new THREE.Vector3(transformed[0], transformed[1], transformed[2])
}

function emptyPackedSurfaceMesh(
  mesh: ViewerMesh,
  positionTolerance = POSITION_TOLERANCE,
  exteriorCenter = meshExteriorCenter(mesh),
  analysisMatrix = mesh.matrixWorld.clone(),
): PackedSurfaceMesh {
  return {
    mesh,
    faceCount: 0,
    faceIndices: new Uint32Array(0),
    normals: new Float32Array(0),
    centers: new Float32Array(0),
    areas: new Float64Array(0),
    planeOffsets: new Float64Array(0),
    faceToGroup: new Int32Array(0),
    groupOffsets: new Uint32Array([0]),
    groupFaces: new Uint32Array(0),
    groupNormals: new Float32Array(0),
    groupCenters: new Float64Array(0),
    groupAreas: new Float64Array(0),
    boundaryOffsets: new Uint32Array([0]),
    boundaryFaces: new Uint32Array(0),
    boundaryLocals: new Uint8Array(0),
    positionTolerance,
    exteriorCenter,
    analysisMatrix,
    groups: [],
  }
}

function* finalisePackedSurfaceMeshSteps(
  mesh: ViewerMesh,
  analysisMatrix: THREE.Matrix4,
  faceCountTotal: number,
  validCount: number,
  faceIndices: Uint32Array,
  normals: Float32Array,
  centers: Float32Array,
  areas: Float64Array,
  planeOffsets: Float64Array,
  parent: Int32Array,
  positionTolerance: number,
  edgeTable: EdgeTable,
  edgeFaces: Int32Array,
  edgeNext: Int32Array,
  edgeLocals: Uint8Array,
  deferBoundary = false,
): Generator<void, PackedSurfaceMesh, void> {
  if (validCount === 0) return emptyPackedSurfaceMesh(mesh, positionTolerance, meshExteriorCenter(mesh, analysisMatrix), analysisMatrix)
  // Keep each synchronous finalisation slice below a frame on large meshes.
  // The packed arrays make the extra hand-offs inexpensive while preventing
  // the group/boundary passes from monopolising pointer/render work.
  const finaliseChunk = 4_096
  const groupForRoot = new Int32Array(validCount)
  groupForRoot.fill(-1)
  const groupOfSample = new Int32Array(validCount)
  const groupCounts = new Uint32Array(validCount)
  let groupCount = 0
  for (let sampleIndex = 0; sampleIndex < validCount; sampleIndex += 1) {
    let root = sampleIndex
    while (parent[root] !== root) {
      const next = parent[root]
      if (next === undefined || next < 0) break
      const nextParent = parent[next]
      if (nextParent === undefined) break
      parent[root] = nextParent
      root = next
    }
    let group = groupForRoot[root]
    if (group === undefined || group < 0) {
      group = groupCount
      groupCount += 1
      groupForRoot[root] = group
    }
    groupOfSample[sampleIndex] = group
    const existingCount = groupCounts[group] ?? 0
    groupCounts[group] = existingCount + 1
    if ((sampleIndex + 1) % finaliseChunk === 0 && sampleIndex + 1 < validCount) yield
  }
  const groupOffsets = new Uint32Array(groupCount + 1)
  for (let group = 0; group < groupCount; group += 1) {
    groupOffsets[group + 1] = (groupOffsets[group] ?? 0) + (groupCounts[group] ?? 0)
    if ((group + 1) % finaliseChunk === 0 && group + 1 < groupCount) yield
  }
  const groupFaces = new Uint32Array(validCount)
  const cursors = new Uint32Array(groupOffsets.subarray(0, groupCount))
  const faceToGroup = new Int32Array(faceCountTotal)
  faceToGroup.fill(-1)
  const groupNormals = new Float32Array(groupCount * 3)
  const groupCenters = new Float64Array(groupCount * 3)
  const groupAreas = new Float64Array(groupCount)
  const firstSample = new Int32Array(groupCount)
  firstSample.fill(-1)
  for (let sampleIndex = 0; sampleIndex < validCount; sampleIndex += 1) {
    const group = groupOfSample[sampleIndex] ?? 0
    const cursor = cursors[group] ?? 0
    groupFaces[cursor] = faceIndices[sampleIndex] ?? 0
    cursors[group] = cursor + 1
    const faceIndex = faceIndices[sampleIndex] ?? 0
    faceToGroup[faceIndex] = group
    const sampleArea = areas[sampleIndex] ?? 0
    groupAreas[group] = (groupAreas[group] ?? 0) + sampleArea
    const centerOffset = sampleIndex * 3
    const groupCenterOffset = group * 3
    groupCenters[groupCenterOffset] = (groupCenters[groupCenterOffset] ?? 0) + (centers[centerOffset] ?? 0) * sampleArea
    groupCenters[groupCenterOffset + 1] = (groupCenters[groupCenterOffset + 1] ?? 0) + (centers[centerOffset + 1] ?? 0) * sampleArea
    groupCenters[groupCenterOffset + 2] = (groupCenters[groupCenterOffset + 2] ?? 0) + (centers[centerOffset + 2] ?? 0) * sampleArea
    if ((firstSample[group] ?? -1) < 0) {
      firstSample[group] = sampleIndex
      groupNormals[groupCenterOffset] = normals[centerOffset] ?? 0
      groupNormals[groupCenterOffset + 1] = normals[centerOffset + 1] ?? 0
      groupNormals[groupCenterOffset + 2] = normals[centerOffset + 2] ?? 0
    }
    if ((sampleIndex + 1) % finaliseChunk === 0 && sampleIndex + 1 < validCount) yield
  }
  for (let group = 0; group < groupCount; group += 1) {
    const area = groupAreas[group] ?? 0
    const offset = group * 3
    const inverseArea = area <= Number.EPSILON ? 0 : 1 / area
    groupCenters[offset] = (groupCenters[offset] ?? 0) * inverseArea
    groupCenters[offset + 1] = (groupCenters[offset + 1] ?? 0) * inverseArea
    groupCenters[offset + 2] = (groupCenters[offset + 2] ?? 0) * inverseArea
    if ((group + 1) % finaliseChunk === 0 && group + 1 < groupCount) yield
  }
  // An edge is on the model boundary iff its compact numeric chain has one
  // occurrence. Retain only face/local-edge references; source vertices are
  // reconstructed lazily when a descriptor is requested. Large async loads
  // defer the two table scans to a cooperative pass below, avoiding a long
  // synchronous tail after face grouping has completed.
  const boundaryOffsets = new Uint32Array(groupCount + 1)
  let boundaryFaces = new Uint32Array(0)
  let boundaryLocals = new Uint8Array(0)
  if (!deferBoundary) {
    const boundaryCounts = new Uint32Array(groupCount)
    for (let slot = 0; slot < edgeTable.heads.length; slot += 1) {
      if ((slot + 1) % finaliseChunk === 0 && slot + 1 < edgeTable.heads.length) yield
      const head = edgeTable.heads[slot] ?? -1
      if (head < 0 || (edgeNext[head] ?? -1) >= 0) continue
      const sample = edgeFaces[head] ?? -1
      if (sample < 0 || sample >= validCount) continue
      const group = groupOfSample[sample] ?? -1
      if (group >= 0) boundaryCounts[group] = (boundaryCounts[group] ?? 0) + 1
    }
    for (let group = 0; group < groupCount; group += 1) boundaryOffsets[group + 1] = (boundaryOffsets[group] ?? 0) + (boundaryCounts[group] ?? 0)
    boundaryFaces = new Uint32Array(boundaryOffsets[groupCount] ?? 0)
    boundaryLocals = new Uint8Array(boundaryFaces.length)
    const boundaryCursors = new Uint32Array(boundaryOffsets.subarray(0, groupCount))
    for (let slot = 0; slot < edgeTable.heads.length; slot += 1) {
      if ((slot + 1) % finaliseChunk === 0 && slot + 1 < edgeTable.heads.length) yield
      const head = edgeTable.heads[slot] ?? -1
      if (head < 0 || (edgeNext[head] ?? -1) >= 0) continue
      const sample = edgeFaces[head] ?? -1
      if (sample < 0 || sample >= validCount) continue
      const group = groupOfSample[sample] ?? -1
      if (group < 0) continue
      const cursor = boundaryCursors[group] ?? 0
      boundaryFaces[cursor] = faceIndices[sample] ?? 0
      boundaryLocals[cursor] = edgeLocals[head] ?? 0
      boundaryCursors[group] = cursor + 1
    }
  }
  const compactFaceIndices = faceIndices.subarray(0, validCount)
  const compactNormals = normals.subarray(0, validCount * 3)
  const compactCenters = centers.subarray(0, validCount * 3)
  const compactAreas = areas.subarray(0, validCount)
  const compactPlanes = planeOffsets.subarray(0, validCount)
  return {
    mesh,
    faceCount: validCount,
    faceIndices: compactFaceIndices,
    normals: compactNormals,
    centers: compactCenters,
    areas: compactAreas,
    planeOffsets: compactPlanes,
    faceToGroup,
    groupOffsets,
    groupFaces,
    groupNormals,
    groupCenters,
    groupAreas,
    boundaryOffsets,
    boundaryFaces,
    boundaryLocals,
    positionTolerance,
    exteriorCenter: meshExteriorCenter(mesh, analysisMatrix),
    analysisMatrix,
    groups: new Array<ViewerSurfaceGroup | undefined>(groupCount),
  }
}

function finalisePackedSurfaceMesh(
  mesh: ViewerMesh,
  analysisMatrix: THREE.Matrix4,
  faceCountTotal: number,
  validCount: number,
  faceIndices: Uint32Array,
  normals: Float32Array,
  centers: Float32Array,
  areas: Float64Array,
  planeOffsets: Float64Array,
  parent: Int32Array,
  positionTolerance: number,
  edgeTable: EdgeTable,
  edgeFaces: Int32Array,
  edgeNext: Int32Array,
  edgeLocals: Uint8Array,
  deferBoundary = false,
): PackedSurfaceMesh {
  const steps = finalisePackedSurfaceMeshSteps(mesh, analysisMatrix, faceCountTotal, validCount, faceIndices, normals, centers, areas, planeOffsets, parent, positionTolerance, edgeTable, edgeFaces, edgeNext, edgeLocals, deferBoundary)
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

async function finalisePackedSurfaceMeshAsync(
  mesh: ViewerMesh,
  analysisMatrix: THREE.Matrix4,
  faceCountTotal: number,
  validCount: number,
  faceIndices: Uint32Array,
  normals: Float32Array,
  centers: Float32Array,
  areas: Float64Array,
  planeOffsets: Float64Array,
  parent: Int32Array,
  positionTolerance: number,
  edgeTable: EdgeTable,
  edgeFaces: Int32Array,
  edgeNext: Int32Array,
  edgeLocals: Uint8Array,
  deferBoundary: boolean,
  options: ViewerSurfaceIndexOptions,
): Promise<PackedSurfaceMesh> {
  const steps = finalisePackedSurfaceMeshSteps(mesh, analysisMatrix, faceCountTotal, validCount, faceIndices, normals, centers, areas, planeOffsets, parent, positionTolerance, edgeTable, edgeFaces, edgeNext, edgeLocals, deferBoundary)
  let step = steps.next()
  while (!step.done) {
    abortSurfaceIndex(options.signal)
    await yieldSurfaceIndexTask()
    step = steps.next()
  }
  return step.value
}

interface BoundaryReferences {
  readonly offsets: Uint32Array
  readonly faces: Uint32Array
  readonly locals: Uint8Array
}

/**
 * Collects singleton edge references without retaining expanded vertices.
 * The table scan is deliberately cooperative: a large connected mesh has a
 * sparse boundary but still a multi-million-slot numeric table, so each pass
 * yields before the browser's frame budget is exhausted.
 */
async function collectBoundaryReferencesAsync(
  packed: PackedSurfaceMesh,
  edgeTable: EdgeTable,
  edgeFaces: Int32Array,
  edgeNext: Int32Array,
  edgeLocals: Uint8Array,
  options: ViewerSurfaceIndexOptions,
): Promise<BoundaryReferences> {
  const groupCount = packed.groupOffsets.length - 1
  const counts = new Uint32Array(groupCount)
  // The numeric table is already packed and cache-friendly; scanning it in
  // larger slices avoids hundreds of timer hand-offs while keeping each
  // boundary pass below a frame on the large-model path.
  const chunkSize = Math.max(chunkSizeFor(options), 16_384)
  for (let slot = 0; slot < edgeTable.heads.length; slot += 1) {
    const head = edgeTable.heads[slot] ?? -1
    if (head >= 0 && (edgeNext[head] ?? -1) < 0) {
      const sample = edgeFaces[head] ?? -1
      const face = sample >= 0 && sample < packed.faceIndices.length ? packed.faceIndices[sample] ?? -1 : -1
      const group = face >= 0 && face < packed.faceToGroup.length ? packed.faceToGroup[face] ?? -1 : -1
      if (group >= 0 && group < groupCount) counts[group] = (counts[group] ?? 0) + 1
    }
    if ((slot + 1) % chunkSize === 0 && slot + 1 < edgeTable.heads.length) {
      abortSurfaceIndex(options.signal)
      await yieldSurfaceIndexTask()
    }
  }
  const offsets = new Uint32Array(groupCount + 1)
  for (let group = 0; group < groupCount; group += 1) offsets[group + 1] = (offsets[group] ?? 0) + (counts[group] ?? 0)
  const faces = new Uint32Array(offsets[groupCount] ?? 0)
  const locals = new Uint8Array(faces.length)
  const cursors = new Uint32Array(offsets.subarray(0, groupCount))
  for (let slot = 0; slot < edgeTable.heads.length; slot += 1) {
    const head = edgeTable.heads[slot] ?? -1
    if (head >= 0 && (edgeNext[head] ?? -1) < 0) {
      const sample = edgeFaces[head] ?? -1
      const face = sample >= 0 && sample < packed.faceIndices.length ? packed.faceIndices[sample] ?? -1 : -1
      const group = face >= 0 && face < packed.faceToGroup.length ? packed.faceToGroup[face] ?? -1 : -1
      if (group >= 0 && group < groupCount) {
        const cursor = cursors[group] ?? 0
        faces[cursor] = face
        locals[cursor] = edgeLocals[head] ?? 0
        cursors[group] = cursor + 1
      }
    }
    if ((slot + 1) % chunkSize === 0 && slot + 1 < edgeTable.heads.length) {
      abortSurfaceIndex(options.signal)
      await yieldSurfaceIndexTask()
    }
  }
  abortSurfaceIndex(options.signal)
  return { offsets, faces, locals }
}

function addEdgeOccurrence(
  table: EdgeTable,
  edgeFaces: Int32Array,
  edgeNext: Int32Array,
  edgeLocals: Uint8Array,
  edgeCursor: number,
  firstVertex: number,
  secondVertex: number,
  sampleIndex: number,
  localEdge: number,
  parent: Int32Array,
  normals: Float32Array,
  centers: Float32Array,
  planeOffsets: Float64Array,
  tolerance: SurfaceTolerance,
): number {
  const slot = edgeTableSlot(table, firstVertex, secondVertex)
  const previous = table.heads[slot] ?? -1
  table.firstVertices[slot] = firstVertex
  table.secondVertices[slot] = secondVertex
  edgeFaces[edgeCursor] = sampleIndex
  edgeNext[edgeCursor] = previous
  edgeLocals[edgeCursor] = localEdge
  table.heads[slot] = edgeCursor
  let linked = previous
  let compared = 0
  while (linked >= 0 && compared < MAX_EDGE_ADJACENCY) {
    const otherSample = edgeFaces[linked]
    if (otherSample !== undefined && samePlane(sampleIndex, otherSample, normals, centers, planeOffsets, tolerance)) union(parent, sampleIndex, otherSample)
    linked = edgeNext[linked] ?? -1
    compared += 1
  }
  return edgeCursor + 1
}

function buildPackedSurfaceMesh(
  mesh: ViewerMesh,
  requestedTolerance: number,
  exteriorCenter?: THREE.Vector3,
  analysisMatrix?: THREE.Matrix4,
): PackedSurfaceMesh {
  mesh.updateMatrixWorld(true)
  const matrix = analysisMatrix?.clone() ?? mesh.matrixWorld.clone()
  const resolvedExteriorCenter = exteriorCenter ?? meshExteriorCenter(mesh, matrix)
  if (!mesh.geometry.hasAttribute('position')) return emptyPackedSurfaceMesh(mesh, POSITION_TOLERANCE, resolvedExteriorCenter, matrix)
  const position = mesh.geometry.getAttribute('position')
  const index = mesh.geometry.index
  const faceCount = Math.floor((index?.count ?? position.count) / 3)
  if (faceCount === 0) return emptyPackedSurfaceMesh(mesh, POSITION_TOLERANCE, resolvedExteriorCenter, matrix)
  const tolerance = surfaceTolerance(mesh, requestedTolerance, matrix)
  const faceIndices = new Uint32Array(faceCount)
  const normals = new Float32Array(faceCount * 3)
  const centers = new Float32Array(faceCount * 3)
  const areas = new Float64Array(faceCount)
  const planeOffsets = new Float64Array(faceCount)
  const parent = new Int32Array(faceCount)
  parent.fill(-1)
  const edgeCapacity = faceCount * 3
  const edgeFaces = new Int32Array(edgeCapacity)
  const edgeNext = new Int32Array(edgeCapacity)
  const edgeLocals = new Uint8Array(edgeCapacity)
  edgeNext.fill(-1)
  const table = createEdgeTable(edgeCapacity)
  // Regular indexed geometry carries exact endpoint identity in its source
  // indices. OBJ tuple geometry deliberately opts into coordinate identity so
  // UV/normal seams do not split a physical roof into thousands of surfaces.
  const coordinateIdentity = coordinateVertexIdentityRequired(mesh.geometry)
  const vertexTable = coordinateIdentity
    ? createVertexTable(position, matrix, tolerance.position, index !== null)
    : null
  const identity = matrixIsIdentity(matrix)
  const scratch = makeScratch()
  let validCount = 0
  let edgeCursor = 0
  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    if (!computeFace(position, index, faceIndex, scratch, matrix, identity)) continue
    const sampleIndex = validCount
    validCount += 1
    parent[sampleIndex] = sampleIndex
    faceIndices[sampleIndex] = faceIndex
    const sampleOffset = sampleIndex * 3
    normals[sampleOffset] = scratch.normalX
    normals[sampleOffset + 1] = scratch.normalY
    normals[sampleOffset + 2] = scratch.normalZ
    centers[sampleOffset] = scratch.centerX
    centers[sampleOffset + 1] = scratch.centerY
    centers[sampleOffset + 2] = scratch.centerZ
    areas[sampleIndex] = scratch.doubleArea / 2
    planeOffsets[sampleIndex] = scratch.planeOffset
    assignFaceVertexIds(scratch, vertexTable)
    writeEdgeVertexPair(scratch.vertexIdA, scratch.vertexIdB, scratch)
    edgeCursor = addEdgeOccurrence(table, edgeFaces, edgeNext, edgeLocals, edgeCursor, scratch.edgeVertexA, scratch.edgeVertexB, sampleIndex, 0, parent, normals, centers, planeOffsets, tolerance)
    writeEdgeVertexPair(scratch.vertexIdB, scratch.vertexIdC, scratch)
    edgeCursor = addEdgeOccurrence(table, edgeFaces, edgeNext, edgeLocals, edgeCursor, scratch.edgeVertexA, scratch.edgeVertexB, sampleIndex, 1, parent, normals, centers, planeOffsets, tolerance)
    writeEdgeVertexPair(scratch.vertexIdC, scratch.vertexIdA, scratch)
    edgeCursor = addEdgeOccurrence(table, edgeFaces, edgeNext, edgeLocals, edgeCursor, scratch.edgeVertexA, scratch.edgeVertexB, sampleIndex, 2, parent, normals, centers, planeOffsets, tolerance)
  }
  const packed = finalisePackedSurfaceMesh(mesh, matrix, faceCount, validCount, faceIndices, normals, centers, areas, planeOffsets, parent, tolerance.position, table, edgeFaces, edgeNext, edgeLocals)
  return { ...packed, exteriorCenter: resolvedExteriorCenter, analysisMatrix: matrix }
}

function buildGroupForPacked(packed: PackedSurfaceMesh, groupNumber: number): ViewerSurfaceGroup {
  const cached = packed.groups[groupNumber]
  if (cached !== undefined) return cached
  const start = packed.groupOffsets[groupNumber] ?? 0
  const end = packed.groupOffsets[groupNumber + 1] ?? start
  const boundaryStart = packed.boundaryOffsets[groupNumber] ?? 0
  const boundaryEnd = packed.boundaryOffsets[groupNumber + 1] ?? boundaryStart
  const centerOffset = groupNumber * 3
  const faceSlice = packed.groupFaces.subarray(start, end)
  const faceIndices: readonly number[] | Uint32Array = faceSlice.length > 8_192
    ? faceSlice
    : Array.from(faceSlice, (value) => value)
  const group = {
    id: `${packed.mesh.uuid}:surface-${String(groupNumber)}`,
    mesh: packed.mesh,
    faceIndices,
    normal: new THREE.Vector3(
      packed.groupNormals[centerOffset] ?? 0,
      packed.groupNormals[centerOffset + 1] ?? 0,
      packed.groupNormals[centerOffset + 2] ?? 0,
    ).normalize(),
    center: new THREE.Vector3(
      packed.groupCenters[centerOffset] ?? 0,
      packed.groupCenters[centerOffset + 1] ?? 0,
      packed.groupCenters[centerOffset + 2] ?? 0,
    ),
    exteriorCenter: packed.exteriorCenter,
    analysisMatrix: packed.analysisMatrix,
    area: packed.groupAreas[groupNumber] ?? 0,
    positionTolerance: packed.positionTolerance,
    boundaryFaces: packed.boundaryFaces.subarray(boundaryStart, boundaryEnd),
    boundaryLocals: packed.boundaryLocals.subarray(boundaryStart, boundaryEnd),
  } satisfies ViewerSurfaceGroup
  packed.groups[groupNumber] = group
  return group
}

function groupsForPacked(packed: PackedSurfaceMesh): readonly ViewerSurfaceGroup[] {
  if (packed.allGroups !== undefined) return packed.allGroups
  const groups: ViewerSurfaceGroup[] = []
  const groupCount = packed.groupOffsets.length - 1
  for (let group = 0; group < groupCount; group += 1) groups.push(buildGroupForPacked(packed, group))
  packed.allGroups = groups
  return groups
}

function minimumSurfaceAreaFor(options: ViewerSurfaceIndexOptions): number {
  const minimum = options.minimumSurfaceAreaM2 ?? 0
  if (!Number.isFinite(minimum) || minimum < 0) {
    throw new RangeError('minimumSurfaceAreaM2 must be a finite, non-negative number')
  }
  return minimum
}

function indexedMeshFor(mesh: ViewerMesh, packed: PackedSurfaceMesh, minimumSurfaceAreaM2: number): IndexedMesh {
  const groupCount = packed.groupOffsets.length - 1
  const selected: number[] = []
  const groupMask = new Uint8Array(groupCount)
  for (let groupNumber = 0; groupNumber < groupCount; groupNumber += 1) {
    if ((packed.groupAreas[groupNumber] ?? 0) < minimumSurfaceAreaM2) continue
    selected.push(groupNumber)
    groupMask[groupNumber] = 1
  }
  return { mesh, packed, groupNumbers: Uint32Array.from(selected), groupMask }
}

function groupsForIndexed(entry: IndexedMesh): readonly ViewerSurfaceGroup[] {
  return Array.from(entry.groupNumbers, (groupNumber) => buildGroupForPacked(entry.packed, groupNumber))
}

function projectedTriangleBounds(
  scratch: TriangleScratch,
  group: ViewerSurfaceGroup,
  frame: SurfaceFrame,
): { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const vertex of [scratch.a, scratch.b, scratch.c]) {
    const dx = vertex[0] - group.center.x
    const dy = vertex[1] - group.center.y
    const dz = vertex[2] - group.center.z
    const x = dx * frame.tangentX.x + dy * frame.tangentX.y + dz * frame.tangentX.z
    const y = dx * frame.tangentY.x + dy * frame.tangentY.y + dz * frame.tangentY.z
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Builds a bounded 2-D uniform bin for a large coplanar group.  The bin is
 * deliberately a compact two-pass typed representation: no face objects or
 * per-cell JS arrays survive, and a malformed triangle that spans most cells
 * falls back to the exact (small-group) path rather than exploding memory.
 */
type GridBuildStep = Generator<void, GroupRaycastGrid | null, void>

/**
 * Runs the grid builder as a generator so the exact same packed algorithm can
 * be used synchronously for small callers and cooperatively for the imported
 * large-model path.  Yield points are deliberately in each face pass (and in
 * the cell-reference loops) rather than only between groups: a 500k-face
 * indexed roof is normally one connected group.
 */
function* buildGroupRaycastGridSteps(group: ViewerSurfaceGroup, yieldEvery: number): GridBuildStep {
  const faceCount = group.faceIndices.length
  if (faceCount <= 256) return null
  const frame = frameForGroup(group)
  const scratch = makeTriangleScratch()
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let processed = 0
  for (const faceIndex of group.faceIndices) {
    if (!triangleWorldVertices(group.mesh, faceIndex, scratch, group.analysisMatrix)) continue
    const bounds = projectedTriangleBounds(scratch, group, frame)
    minX = Math.min(minX, bounds.minX)
    minY = Math.min(minY, bounds.minY)
    maxX = Math.max(maxX, bounds.maxX)
    maxY = Math.max(maxY, bounds.maxY)
    processed += 1
    if (yieldEvery > 0 && processed % yieldEvery === 0) yield
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null
  const width = Math.max(maxX - minX, 1e-9)
  const height = Math.max(maxY - minY, 1e-9)
  const targetCells = 16_384
  const aspect = Math.sqrt(width / height)
  const columns = Math.min(256, Math.max(8, Math.ceil(Math.sqrt(targetCells * aspect))))
  const rows = Math.min(256, Math.max(8, Math.ceil(targetCells / columns)))
  const cellCount = columns * rows
  const cellWidth = width / columns
  const cellHeight = height / rows
  const counts = new Uint32Array(cellCount)
  const cellBounds = (bounds: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }): [number, number, number, number] => {
    const firstX = Math.max(0, Math.min(columns - 1, Math.floor((bounds.minX - minX) / cellWidth)))
    const firstY = Math.max(0, Math.min(rows - 1, Math.floor((bounds.minY - minY) / cellHeight)))
    const lastX = Math.max(firstX, Math.min(columns - 1, Math.floor((bounds.maxX - minX) / cellWidth)))
    const lastY = Math.max(firstY, Math.min(rows - 1, Math.floor((bounds.maxY - minY) / cellHeight)))
    return [firstX, firstY, lastX, lastY]
  }
  let references = 0
  processed = 0
  let processedCellReferences = 0
  for (const faceIndex of group.faceIndices) {
    if (!triangleWorldVertices(group.mesh, faceIndex, scratch, group.analysisMatrix)) continue
    const cells = cellBounds(projectedTriangleBounds(scratch, group, frame))
    const span = (cells[2] - cells[0] + 1) * (cells[3] - cells[1] + 1)
    // Avoid a pathological giant polygon multiplying a single face into the
    // whole table. Its exact face count is still bounded and can be tested
    // directly by the caller.
    if (span > cellCount / 2) return null
    references += span
    for (let y = cells[1]; y <= cells[3]; y += 1) {
      for (let x = cells[0]; x <= cells[2]; x += 1) {
        counts[y * columns + x] = (counts[y * columns + x] ?? 0) + 1
        processedCellReferences += 1
        if (yieldEvery > 0 && processedCellReferences % yieldEvery === 0) yield
      }
    }
    processed += 1
    if (yieldEvery > 0 && processed % yieldEvery === 0) yield
  }
  const offsets = new Uint32Array(cellCount + 1)
  for (let cell = 0; cell < cellCount; cell += 1) offsets[cell + 1] = (offsets[cell] ?? 0) + (counts[cell] ?? 0)
  const faces = new Uint32Array(references)
  const cursors = new Uint32Array(offsets.subarray(0, cellCount))
  processed = 0
  processedCellReferences = 0
  for (const faceIndex of group.faceIndices) {
    if (!triangleWorldVertices(group.mesh, faceIndex, scratch, group.analysisMatrix)) continue
    const cells = cellBounds(projectedTriangleBounds(scratch, group, frame))
    for (let y = cells[1]; y <= cells[3]; y += 1) {
      for (let x = cells[0]; x <= cells[2]; x += 1) {
        const cell = y * columns + x
        const cursor = cursors[cell] ?? 0
        faces[cursor] = faceIndex
        cursors[cell] = cursor + 1
        processedCellReferences += 1
        if (yieldEvery > 0 && processedCellReferences % yieldEvery === 0) yield
      }
    }
    processed += 1
    if (yieldEvery > 0 && processed % yieldEvery === 0) yield
  }
  return { minX, minY, width, height, columns, rows, frame, offsets, faces }
}

function buildGroupRaycastGrid(group: ViewerSurfaceGroup): GroupRaycastGrid | null {
  const steps = buildGroupRaycastGridSteps(group, 0)
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

async function buildGroupRaycastGridAsync(
  group: ViewerSurfaceGroup,
  options: ViewerSurfaceIndexOptions,
): Promise<GroupRaycastGrid | null> {
  const steps = buildGroupRaycastGridSteps(group, chunkSizeFor(options))
  let step = steps.next()
  while (!step.done) {
    abortSurfaceIndex(options.signal)
    await yieldSurfaceIndexTask()
    step = steps.next()
  }
  abortSurfaceIndex(options.signal)
  return step.value
}

function buildRaycastGrids(entry: IndexedMesh): void {
  const groupCount = entry.packed.groupOffsets.length - 1
  const grids: Array<GroupRaycastGrid | null> = Array.from({ length: groupCount }, () => null)
  for (const groupNumber of entry.groupNumbers) {
    grids[groupNumber] = buildGroupRaycastGrid(buildGroupForPacked(entry.packed, groupNumber))
  }
  entry.packed.raycastGrids = grids
  entry.packed.raycastStamps = new Uint32Array(entry.packed.faceCount)
  entry.packed.raycastStamp = 0
}

async function buildRaycastGridsAsync(entry: IndexedMesh, options: ViewerSurfaceIndexOptions): Promise<void> {
  const groupCount = entry.packed.groupOffsets.length - 1
  const grids: Array<GroupRaycastGrid | null> = Array.from({ length: groupCount }, () => null)
  for (const groupNumber of entry.groupNumbers) {
    grids[groupNumber] = await buildGroupRaycastGridAsync(buildGroupForPacked(entry.packed, groupNumber), options)
  }
  entry.packed.raycastGrids = grids
  entry.packed.raycastStamps = new Uint32Array(entry.packed.faceCount)
  entry.packed.raycastStamp = 0
}

function faceTriangleVectors(
  group: ViewerSurfaceGroup,
  faceIndex: number,
  target: { readonly a: THREE.Vector3; readonly b: THREE.Vector3; readonly c: THREE.Vector3 },
  scratch: TriangleScratch,
): boolean {
  if (!triangleWorldVertices(group.mesh, faceIndex, scratch, group.analysisMatrix)) return false
  target.a.set(scratch.a[0], scratch.a[1], scratch.a[2])
  target.b.set(scratch.b[0], scratch.b[1], scratch.b[2])
  target.c.set(scratch.c[0], scratch.c[1], scratch.c[2])
  return true
}

function raycastPackedGroup(
  packed: PackedSurfaceMesh,
  group: ViewerSurfaceGroup,
  groupNumber: number,
  ray: THREE.Ray,
  maxDistance: number,
): ViewerSurfaceRaycastHit | null {
  const denominator = ray.direction.dot(group.normal)
  if (Math.abs(denominator) < 1e-10) return null
  const t = group.center.clone().sub(ray.origin).dot(group.normal) / denominator
  if (!Number.isFinite(t) || t < 0 || t >= maxDistance) return null
  const planePoint = ray.origin.clone().addScaledVector(ray.direction, t)
  const frame = frameForGroup(group)
  const dx = planePoint.x - group.center.x
  const dy = planePoint.y - group.center.y
  const dz = planePoint.z - group.center.z
  const projectedX = dx * frame.tangentX.x + dy * frame.tangentX.y + dz * frame.tangentX.z
  const projectedY = dx * frame.tangentY.x + dy * frame.tangentY.y + dz * frame.tangentY.z
  const grid = packed.raycastGrids?.[groupNumber] ?? null
  const candidateFaces: readonly number[] | Uint32Array = grid === null
    ? group.faceIndices
    : (() => {
      const cellX = Math.floor((projectedX - grid.minX) / (grid.width / grid.columns))
      const cellY = Math.floor((projectedY - grid.minY) / (grid.height / grid.rows))
      // Clamp the exact max edge into the final bin; otherwise a ray landing
      // on the model boundary would floor to `columns`/`rows` and miss.
      if (cellX < 0 || cellY < 0 || cellX > grid.columns || cellY > grid.rows) return new Uint32Array(0)
      const boundedCellX = Math.min(grid.columns - 1, cellX)
      const boundedCellY = Math.min(grid.rows - 1, cellY)
      const cell = boundedCellY * grid.columns + boundedCellX
      const start = grid.offsets[cell] ?? 0
      const end = grid.offsets[cell + 1] ?? start
      return grid.faces.subarray(start, end)
    })()
  if (candidateFaces.length === 0) return null
  const stamps = packed.raycastStamps
  const stamp = (packed.raycastStamp ?? 0) + 1
  packed.raycastStamp = stamp >= 0xffff_fffe ? 1 : stamp
  const queryStamp = packed.raycastStamp
  const triangle = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3() }
  const hitPoint = new THREE.Vector3()
  const scratch = makeTriangleScratch()
  for (const candidate of candidateFaces) {
    const faceIndex = candidate
    if (stamps !== undefined) {
      if (stamps[faceIndex] === queryStamp) continue
      stamps[faceIndex] = queryStamp
    }
    if (!faceTriangleVectors(group, faceIndex, triangle, scratch)) continue
    const point = ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hitPoint)
    if (point === null) continue
    const distance = point.clone().sub(ray.origin).dot(ray.direction)
    if (!Number.isFinite(distance) || distance < 0 || distance >= maxDistance) continue
    return { mesh: group.mesh, group, faceIndex, point: point.clone(), distance }
  }
  return null
}

/** Groups connected coplanar triangles with packed, scale-bounded storage. */
export function buildViewerSurfaceGroups(mesh: ViewerMesh, tolerance = DEFAULT_TOLERANCE): readonly ViewerSurfaceGroup[] {
  return groupsForPacked(buildPackedSurfaceMesh(mesh, tolerance))
}

async function buildPackedSurfaceMeshAsync(
  mesh: ViewerMesh,
  requestedTolerance: number,
  options: ViewerSurfaceIndexOptions,
  exteriorCenter?: THREE.Vector3,
  analysisMatrix?: THREE.Matrix4,
): Promise<PackedSurfaceMesh> {
  mesh.updateMatrixWorld(true)
  const matrix = analysisMatrix?.clone() ?? mesh.matrixWorld.clone()
  const resolvedExteriorCenter = exteriorCenter ?? meshExteriorCenter(mesh, matrix)
  if (!mesh.geometry.hasAttribute('position')) return emptyPackedSurfaceMesh(mesh, POSITION_TOLERANCE, resolvedExteriorCenter, matrix)
  const position = mesh.geometry.getAttribute('position')
  const index = mesh.geometry.index
  const faceCount = Math.floor((index?.count ?? position.count) / 3)
  if (faceCount === 0) return emptyPackedSurfaceMesh(mesh, POSITION_TOLERANCE, resolvedExteriorCenter, matrix)
  const tolerance = await surfaceToleranceAsync(mesh, requestedTolerance, options, matrix)
  const faceIndices = new Uint32Array(faceCount)
  const normals = new Float32Array(faceCount * 3)
  const centers = new Float32Array(faceCount * 3)
  const areas = new Float64Array(faceCount)
  const planeOffsets = new Float64Array(faceCount)
  const parent = new Int32Array(faceCount)
  parent.fill(-1)
  const edgeCapacity = faceCount * 3
  const edgeFaces = new Int32Array(edgeCapacity)
  const edgeNext = new Int32Array(edgeCapacity)
  const edgeLocals = new Uint8Array(edgeCapacity)
  edgeNext.fill(-1)
  const table = createEdgeTable(edgeCapacity)
  const coordinateIdentity = coordinateVertexIdentityRequired(mesh.geometry)
  const vertexTable = coordinateIdentity
    ? createVertexTable(position, matrix, tolerance.position, index !== null)
    : null
  const identity = matrixIsIdentity(matrix)
  const scratch = makeScratch()
  const chunkSize = chunkSizeFor(options)
  let validCount = 0
  let edgeCursor = 0
  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    abortSurfaceIndex(options.signal)
    if (computeFace(position, index, faceIndex, scratch, matrix, identity)) {
      const sampleIndex = validCount
      validCount += 1
      parent[sampleIndex] = sampleIndex
      faceIndices[sampleIndex] = faceIndex
      const sampleOffset = sampleIndex * 3
      normals[sampleOffset] = scratch.normalX
      normals[sampleOffset + 1] = scratch.normalY
      normals[sampleOffset + 2] = scratch.normalZ
      centers[sampleOffset] = scratch.centerX
      centers[sampleOffset + 1] = scratch.centerY
      centers[sampleOffset + 2] = scratch.centerZ
      areas[sampleIndex] = scratch.doubleArea / 2
      planeOffsets[sampleIndex] = scratch.planeOffset
      assignFaceVertexIds(scratch, vertexTable)
      writeEdgeVertexPair(scratch.vertexIdA, scratch.vertexIdB, scratch)
      edgeCursor = addEdgeOccurrence(table, edgeFaces, edgeNext, edgeLocals, edgeCursor, scratch.edgeVertexA, scratch.edgeVertexB, sampleIndex, 0, parent, normals, centers, planeOffsets, tolerance)
      writeEdgeVertexPair(scratch.vertexIdB, scratch.vertexIdC, scratch)
      edgeCursor = addEdgeOccurrence(table, edgeFaces, edgeNext, edgeLocals, edgeCursor, scratch.edgeVertexA, scratch.edgeVertexB, sampleIndex, 1, parent, normals, centers, planeOffsets, tolerance)
      writeEdgeVertexPair(scratch.vertexIdC, scratch.vertexIdA, scratch)
      edgeCursor = addEdgeOccurrence(table, edgeFaces, edgeNext, edgeLocals, edgeCursor, scratch.edgeVertexA, scratch.edgeVertexB, sampleIndex, 2, parent, normals, centers, planeOffsets, tolerance)
    }
    if ((faceIndex + 1) % chunkSize === 0 && faceIndex + 1 < faceCount) await yieldSurfaceIndexTask()
  }
  abortSurfaceIndex(options.signal)
  const packed = await finalisePackedSurfaceMeshAsync(mesh, matrix, faceCount, validCount, faceIndices, normals, centers, areas, planeOffsets, parent, tolerance.position, table, edgeFaces, edgeNext, edgeLocals, true, options)
  const boundary = await collectBoundaryReferencesAsync(packed, table, edgeFaces, edgeNext, edgeLocals, options)
  const withBoundary: PackedSurfaceMesh = {
    ...packed,
    exteriorCenter: resolvedExteriorCenter,
    analysisMatrix: matrix,
    boundaryOffsets: boundary.offsets,
    boundaryFaces: boundary.faces,
    boundaryLocals: boundary.locals,
  }
  await yieldSurfaceIndexTask()
  abortSurfaceIndex(options.signal)
  return withBoundary
}

/** Time-sliced counterpart to buildViewerSurfaceGroups. */
export async function buildViewerSurfaceGroupsAsync(
  mesh: ViewerMesh,
  tolerance = DEFAULT_TOLERANCE,
  options: ViewerSurfaceIndexOptions = {},
): Promise<readonly ViewerSurfaceGroup[]> {
  return groupsForPacked(await buildPackedSurfaceMeshAsync(mesh, tolerance, options))
}

function triangleWorldVertices(
  mesh: ViewerMesh,
  faceIndex: number,
  target: { readonly a: [number, number, number]; readonly b: [number, number, number]; readonly c: [number, number, number] },
  analysisMatrix = mesh.matrixWorld,
): boolean {
  if (!mesh.geometry.hasAttribute('position')) return false
  const position = mesh.geometry.getAttribute('position')
  const index = mesh.geometry.index
  const offset = faceIndex * 3
  const ai = index?.getX(offset) ?? offset
  const bi = index?.getX(offset + 1) ?? offset + 1
  const ci = index?.getX(offset + 2) ?? offset + 2
  const worldA = transformPoint(positionAt(position, ai), analysisMatrix)
  const worldB = transformPoint(positionAt(position, bi), analysisMatrix)
  const worldC = transformPoint(positionAt(position, ci), analysisMatrix)
  target.a[0] = worldA[0]; target.a[1] = worldA[1]; target.a[2] = worldA[2]
  target.b[0] = worldB[0]; target.b[1] = worldB[1]; target.b[2] = worldB[2]
  target.c[0] = worldC[0]; target.c[1] = worldC[1]; target.c[2] = worldC[2]
  return true
}

/**
 * Chooses the exterior-facing side of a surface without changing grouping.
 * Horizontal roofs/ground are conventionally outside-facing toward +Y. For
 * open vertical surfaces, the side farther from the model centroid wins; an
 * exact centroid tie uses a stable positive dominant-axis sign.
 */
function canonicalNormalForGroup(group: ViewerSurfaceGroup): THREE.Vector3 {
  const normal = group.normal.clone().normalize()
  if (Math.abs(normal.y) >= 0.75) {
    if (normal.y < 0) normal.negate()
    return normal
  }
  const away = group.center.clone().sub(group.exteriorCenter)
  const awayLength = away.length()
  const projection = away.dot(normal)
  const projectionTolerance = Math.max(1e-8, awayLength * 1e-7)
  if (awayLength > Number.EPSILON && Math.abs(projection) > projectionTolerance) {
    if (projection < 0) normal.negate()
    return normal
  }
  // Deterministic tie-break: select the dominant component, with X before Y
  // before Z on equal magnitudes, and orient that component positively.
  const absX = Math.abs(normal.x)
  const absY = Math.abs(normal.y)
  const absZ = Math.abs(normal.z)
  if (absX >= absY && absX >= absZ) {
    if (normal.x < 0) normal.negate()
  } else if (absY >= absZ) {
    if (normal.y < 0) normal.negate()
  } else if (normal.z < 0) {
    normal.negate()
  }
  return normal
}

function frameForGroup(group: ViewerSurfaceGroup): SurfaceFrame {
  const normal = canonicalNormalForGroup(group)
  // Keep the historical deterministic axes for a horizontal plane, where
  // gravity has no in-plane component.  For every other plane, make +Y in
  // surface coordinates follow the projected world-down direction so panel
  // portrait rows naturally point toward a gutter/down-slope edge.
  const worldDown = new THREE.Vector3(0, -1, 0)
  const tangentY = worldDown.clone().addScaledVector(normal, -worldDown.dot(normal))
  let tangentX: THREE.Vector3
  if (tangentY.lengthSq() > 1e-12) {
    tangentY.normalize()
    // X × Y = normal (the frame handedness used by placement DTOs).
    tangentX = new THREE.Vector3().crossVectors(tangentY, normal).normalize()
  } else {
    const reference = new THREE.Vector3(1, 0, 0)
    tangentX = new THREE.Vector3().crossVectors(reference, normal).normalize()
    tangentY.copy(new THREE.Vector3().crossVectors(normal, tangentX).normalize())
  }
  return {
    origin: { x: group.center.x, y: group.center.y, z: group.center.z },
    normal: { x: normal.x === 0 ? 0 : normal.x, y: normal.y === 0 ? 0 : normal.y, z: normal.z === 0 ? 0 : normal.z },
    tangentX: { x: tangentX.x, y: tangentX.y, z: tangentX.z },
    tangentY: { x: tangentY.x, y: tangentY.y, z: tangentY.z },
  }
}

interface TriangleScratch {
  readonly a: [number, number, number]
  readonly b: [number, number, number]
  readonly c: [number, number, number]
}

function makeTriangleScratch(): TriangleScratch {
  return { a: [0, 0, 0], b: [0, 0, 0], c: [0, 0, 0] }
}

function localBounds(group: ViewerSurfaceGroup, frame: SurfaceFrame): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const origin = group.center
  const scratch = makeTriangleScratch()
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const faceIndex of group.faceIndices) {
    if (!triangleWorldVertices(group.mesh, faceIndex, scratch, group.analysisMatrix)) continue
    for (const vertex of [scratch.a, scratch.b, scratch.c]) {
      const dx = vertex[0] - origin.x
      const dy = vertex[1] - origin.y
      const dz = vertex[2] - origin.z
      const x = dx * frame.tangentX.x + dy * frame.tangentX.y + dz * frame.tangentX.z
      const y = dx * frame.tangentY.x + dy * frame.tangentY.y + dz * frame.tangentY.z
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return { x: 0, y: 0, width: Number.EPSILON, height: Number.EPSILON }
  return { x: minX, y: minY, width: Math.max(maxX - minX, Number.EPSILON), height: Math.max(maxY - minY, Number.EPSILON) }
}

function projectedPoint(vertex: readonly [number, number, number], group: ViewerSurfaceGroup, frame: SurfaceFrame): Point2 {
  const dx = vertex[0] - group.center.x
  const dy = vertex[1] - group.center.y
  const dz = vertex[2] - group.center.z
  return {
    x: dx * frame.tangentX.x + dy * frame.tangentX.y + dz * frame.tangentX.z,
    y: dx * frame.tangentY.x + dy * frame.tangentY.y + dz * frame.tangentY.z,
  }
}

function polygonArea(points: readonly Point2[]): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (current !== undefined && next !== undefined) sum += current.x * next.y - next.x * current.y
  }
  return Math.abs(sum) / 2
}

const SURFACE_BOUNDARY_EPSILON = 1e-9

function boundaryCross(first: Point2, second: Point2, point: Point2): number {
  return (second.x - first.x) * (point.y - first.y) - (second.y - first.y) * (point.x - first.x)
}

function pointOnBoundarySegment(first: Point2, second: Point2, point: Point2): boolean {
  return point.x >= Math.min(first.x, second.x) - SURFACE_BOUNDARY_EPSILON
    && point.x <= Math.max(first.x, second.x) + SURFACE_BOUNDARY_EPSILON
    && point.y >= Math.min(first.y, second.y) - SURFACE_BOUNDARY_EPSILON
    && point.y <= Math.max(first.y, second.y) + SURFACE_BOUNDARY_EPSILON
    && Math.abs(boundaryCross(first, second, point)) <= SURFACE_BOUNDARY_EPSILON
}

function boundarySegmentsIntersect(firstStart: Point2, firstEnd: Point2, secondStart: Point2, secondEnd: Point2): boolean {
  const first = boundaryCross(firstStart, firstEnd, secondStart)
  const second = boundaryCross(firstStart, firstEnd, secondEnd)
  const third = boundaryCross(secondStart, secondEnd, firstStart)
  const fourth = boundaryCross(secondStart, secondEnd, firstEnd)
  if (((first > SURFACE_BOUNDARY_EPSILON && second < -SURFACE_BOUNDARY_EPSILON)
      || (first < -SURFACE_BOUNDARY_EPSILON && second > SURFACE_BOUNDARY_EPSILON))
    && ((third > SURFACE_BOUNDARY_EPSILON && fourth < -SURFACE_BOUNDARY_EPSILON)
      || (third < -SURFACE_BOUNDARY_EPSILON && fourth > SURFACE_BOUNDARY_EPSILON))) return true
  return (Math.abs(first) <= SURFACE_BOUNDARY_EPSILON && pointOnBoundarySegment(firstStart, firstEnd, secondStart))
    || (Math.abs(second) <= SURFACE_BOUNDARY_EPSILON && pointOnBoundarySegment(firstStart, firstEnd, secondEnd))
    || (Math.abs(third) <= SURFACE_BOUNDARY_EPSILON && pointOnBoundarySegment(secondStart, secondEnd, firstStart))
    || (Math.abs(fourth) <= SURFACE_BOUNDARY_EPSILON && pointOnBoundarySegment(secondStart, secondEnd, firstEnd))
}

/**
 * Photogrammetry meshes can contain branched or non-manifold boundary edges.
 * Such walks may close while still crossing themselves, but placement regions
 * must always be simple polygons so one noisy patch cannot invalidate the
 * entire model context.
 */
export function isSimpleSurfaceBoundary(points: readonly Point2[]): boolean {
  if (points.length < 3 || polygonArea(points) <= SURFACE_BOUNDARY_EPSILON) return false
  for (let first = 0; first < points.length; first += 1) {
    const firstStart = points[first]
    const firstEnd = points[(first + 1) % points.length]
    if (firstStart === undefined || firstEnd === undefined) return false
    const edgeX = firstEnd.x - firstStart.x
    const edgeY = firstEnd.y - firstStart.y
    if (edgeX * edgeX + edgeY * edgeY <= SURFACE_BOUNDARY_EPSILON * SURFACE_BOUNDARY_EPSILON) return false
    for (let second = first + 1; second < points.length; second += 1) {
      const secondStart = points[second]
      const secondEnd = points[(second + 1) % points.length]
      if (secondStart === undefined || secondEnd === undefined) return false
      const adjacent = second === first + 1 || (first === 0 && second === points.length - 1)
      if (!adjacent && boundarySegmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return false
    }
  }
  return true
}

/** Selects the largest valid loop without mutating the caller's boundary list. */
export function largestSimpleSurfaceBoundary(loops: readonly (readonly Point2[])[]): readonly Point2[] | undefined {
  return [...loops]
    .filter(isSimpleSurfaceBoundary)
    .sort((first, second) => polygonArea(second) - polygonArea(first))[0]
}

function largestFaceRegion(group: ViewerSurfaceGroup, frame: SurfaceFrame): SurfaceRegion | undefined {
  const scratch = makeTriangleScratch()
  let largest: readonly Point2[] | undefined
  let largestArea = 0
  for (const faceIndex of group.faceIndices) {
    if (!triangleWorldVertices(group.mesh, faceIndex, scratch, group.analysisMatrix)) continue
    const points = [
      projectedPoint(scratch.a, group, frame),
      projectedPoint(scratch.b, group, frame),
      projectedPoint(scratch.c, group, frame),
    ]
    const area = polygonArea(points)
    if (area > largestArea && isSimpleSurfaceBoundary(points)) {
      largest = points
      largestArea = area
    }
  }
  return largest === undefined ? undefined : { points: largest }
}

interface BoundaryEdge {
  readonly key: bigint
  readonly firstKey: number
  readonly secondKey: number
  readonly first: [number, number, number]
  readonly second: [number, number, number]
}

function zigZagCoordinate(value: number, tolerance: number): bigint {
  const quantized = Math.round(value / tolerance)
  if (!Number.isFinite(quantized)) return 0n
  const integer = BigInt(quantized)
  return integer >= 0n ? integer * 2n : (-integer * 2n) - 1n
}

function cantorPair(first: bigint, second: bigint): bigint {
  const sum = first + second
  return ((sum * (sum + 1n)) / 2n) + second
}

/** Exact quantised key used only while lazily reconstructing one boundary. */
function regionVertexKey(vertex: readonly [number, number, number], tolerance: number): bigint {
  return cantorPair(cantorPair(zigZagCoordinate(vertex[0], tolerance), zigZagCoordinate(vertex[1], tolerance)), zigZagCoordinate(vertex[2], tolerance))
}

function regionEdgeKey(first: number, second: number): bigint {
  const low = Math.min(first, second)
  const high = Math.max(first, second)
  return cantorPair(BigInt(low), BigInt(high))
}

function regionDirectedEdgeKey(first: number, second: number): bigint {
  return cantorPair(BigInt(first), BigInt(second))
}

/**
 * Traces the faces of a planar boundary graph using a deterministic half-edge
 * rotation system. Real photogrammetry often contains boundary vertices with
 * more than two incident edges. Picking the first unused undirected edge at
 * those junctions can consume part of a large roof in a tiny, arbitrary loop.
 *
 * Each directed edge is instead followed by the neighbour immediately before
 * its reverse edge in angular order. This keeps the same face on one side of
 * the walk, recovers every bounded loop, and never invents an edge that is not
 * present in the supplied surface boundary.
 */
export function tracePlanarSurfaceBoundaryLoops(
  adjacency: ReadonlyMap<number, ReadonlySet<number>>,
  vertices: ReadonlyMap<number, Point2>,
): readonly (readonly Point2[])[] {
  const sortedAdjacency = new Map<number, readonly number[]>()
  for (const [vertexId, neighbours] of adjacency) {
    const origin = vertices.get(vertexId)
    if (origin === undefined) continue
    const sorted = [...neighbours]
      .filter((neighbourId) => neighbourId !== vertexId && vertices.has(neighbourId))
      .sort((firstId, secondId) => {
        const first = vertices.get(firstId)
        const second = vertices.get(secondId)
        if (first === undefined || second === undefined) return firstId - secondId
        const firstAngle = Math.atan2(first.y - origin.y, first.x - origin.x)
        const secondAngle = Math.atan2(second.y - origin.y, second.x - origin.x)
        const angleDelta = firstAngle - secondAngle
        return Math.abs(angleDelta) > SURFACE_BOUNDARY_EPSILON ? angleDelta : firstId - secondId
      })
    if (sorted.length > 0) sortedAdjacency.set(vertexId, sorted)
  }

  const vertexIds = [...sortedAdjacency.keys()].sort((first, second) => first - second)
  const directedEdgeCount = [...sortedAdjacency.values()].reduce((total, neighbours) => total + neighbours.length, 0)
  const visited = new Set<bigint>()
  const loops: Point2[][] = []
  for (const start of vertexIds) {
    const startNeighbours = sortedAdjacency.get(start) ?? []
    for (const neighbour of startNeighbours) {
      const initialEdge = regionDirectedEdgeKey(start, neighbour)
      if (visited.has(initialEdge)) continue
      const loopKeys: number[] = []
      let from = start
      let to = neighbour
      let closed = false
      for (let guard = 0; guard <= directedEdgeCount; guard += 1) {
        const directedEdge = regionDirectedEdgeKey(from, to)
        if (visited.has(directedEdge)) {
          closed = from === start && to === neighbour
          break
        }
        visited.add(directedEdge)
        loopKeys.push(from)
        const outgoing = sortedAdjacency.get(to)
        if (outgoing === undefined || outgoing.length === 0) break
        const reverseIndex = outgoing.indexOf(from)
        if (reverseIndex < 0) break
        const nextIndex = (reverseIndex - 1 + outgoing.length) % outgoing.length
        const next = outgoing[nextIndex]
        if (next === undefined) break
        from = to
        to = next
        if (from === start && to === neighbour) {
          closed = true
          break
        }
      }
      if (!closed || loopKeys.length < 3) continue
      const points: Point2[] = []
      for (const key of loopKeys) {
        const point = vertices.get(key)
        if (point === undefined) {
          points.length = 0
          break
        }
        points.push(point)
      }
      if (points.length >= 3) loops.push(points)
    }
  }
  return loops
}

/** Derives the outer boundary lazily, preserving concavities without index-time vertex copies. */
function regionForGroup(group: ViewerSurfaceGroup, frame: SurfaceFrame): SurfaceRegion {
  // BigInt Cantor keys retain exact quantised endpoint identity. This avoids
  // the old hash-only maps collapsing distant vertices/edges on large sites.
  const boundary = new Map<bigint, BoundaryEdge>()
  const counts = new Map<bigint, number>()
  const vertexIds = new Map<bigint, number>()
  const vertices = new Map<number, [number, number, number]>()
  const scratch = makeTriangleScratch()
  const internVertex = (vertex: readonly [number, number, number]): number => {
    const token = regionVertexKey(vertex, group.positionTolerance)
    const existing = vertexIds.get(token)
    if (existing !== undefined) return existing
    const id = vertices.size
    vertexIds.set(token, id)
    vertices.set(id, [vertex[0], vertex[1], vertex[2]])
    return id
  }
  const addBoundary = (first: readonly [number, number, number], second: readonly [number, number, number]): void => {
    const firstKey = internVertex(first)
    const secondKey = internVertex(second)
    const key = regionEdgeKey(firstKey, secondKey)
    const currentCount = (counts.get(key) ?? 0) + 1
    counts.set(key, currentCount)
    if (!boundary.has(key)) boundary.set(key, {
      key,
      firstKey,
      secondKey,
      first: [first[0], first[1], first[2]],
      second: [second[0], second[1], second[2]],
    })
  }
  // Reconstruct the boundary within this surface group. The packed boundary
  // references describe only edges on the outside of the complete mesh. A
  // roof also ends where it shares an edge with a wall, dormer, or differently
  // sloped roof face; those edges occur twice in the mesh but only once in the
  // roof group. Using the mesh-level cache whenever it was non-empty produced
  // open walks on real photogrammetry and collapsed otherwise large roofs to
  // the conservative single-triangle fallback below.
  for (const faceIndex of group.faceIndices) {
    if (!triangleWorldVertices(group.mesh, faceIndex, scratch, group.analysisMatrix)) continue
    addBoundary(scratch.a, scratch.b)
    addBoundary(scratch.b, scratch.c)
    addBoundary(scratch.c, scratch.a)
  }
  const adjacency = new Map<number, Set<number>>()
  for (const [key, count] of counts) {
    if (count !== 1) continue
    const edge = boundary.get(key)
    if (edge === undefined) continue
    const first = adjacency.get(edge.firstKey) ?? new Set<number>()
    const second = adjacency.get(edge.secondKey) ?? new Set<number>()
    first.add(edge.secondKey); second.add(edge.firstKey)
    adjacency.set(edge.firstKey, first); adjacency.set(edge.secondKey, second)
  }
  const projectedVertices = new Map<number, Point2>()
  for (const [vertexId, vertex] of vertices) projectedVertices.set(vertexId, projectedPoint(vertex, group, frame))
  const loops = tracePlanarSurfaceBoundaryLoops(adjacency, projectedVertices)
  const largest = largestSimpleSurfaceBoundary(loops)
  if (largest !== undefined) return { points: largest }
  // A self-intersecting boundary must never escape into the placement store.
  // A real face triangle is conservative but truthful: it cannot place a
  // panel in empty space as an enclosing AABB could.
  const faceRegion = largestFaceRegion(group, frame)
  if (faceRegion !== undefined) return faceRegion
  return localBounds(group, frame)
}

function azimuthDeg(normal: THREE.Vector3): number {
  const value = (Math.atan2(normal.x, normal.z) * 180) / Math.PI
  return (value + 360) % 360
}

function tiltDeg(normal: THREE.Vector3): number {
  const vertical = Math.min(1, Math.max(-1, Math.abs(normal.y)))
  return (Math.acos(vertical) * 180) / Math.PI
}

function pointDto(point: THREE.Vector3): Point3 {
  return Object.freeze({ x: point.x, y: point.y, z: point.z })
}

function descriptorForGroup(group: ViewerSurfaceGroup): SurfaceDescriptor {
  const frame = frameForGroup(group)
  const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z)
  return createSurfaceDescriptor({
    id: group.id,
    frame,
    region: regionForGroup(group, frame),
    area: group.area,
    azimuthDeg: azimuthDeg(normal),
    tiltDeg: tiltDeg(normal),
    usableArea: group.area,
    faceRefs: [{ meshId: group.mesh.uuid, faceIndices: [...group.faceIndices] }],
  })
}

/**
 * Materialises one descriptor without a long synchronous face-id copy. The
 * descriptor contract intentionally owns a plain array, so large packed
 * groups are expanded in bounded slices only at the DTO boundary.
 */
async function descriptorForGroupAsync(group: ViewerSurfaceGroup, options: ViewerSurfaceIndexOptions): Promise<SurfaceDescriptor> {
  const frame = frameForGroup(group)
  const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z)
  const faceIndices: number[] = []
  const chunkSize = chunkSizeFor(options)
  let copied = 0
  for (const faceIndex of group.faceIndices) {
    faceIndices.push(faceIndex)
    copied += 1
    if (copied % chunkSize === 0) {
      abortSurfaceIndex(options.signal)
      await yieldSurfaceIndexTask()
    }
  }
  abortSurfaceIndex(options.signal)
  return createSurfaceDescriptor({
    id: group.id,
    frame,
    region: regionForGroup(group, frame),
    area: group.area,
    azimuthDeg: azimuthDeg(normal),
    tiltDeg: tiltDeg(normal),
    usableArea: group.area,
    faceRefs: [{ meshId: group.mesh.uuid, faceIndices }],
  })
}

function trustedSurfaceSelection(surface: SurfaceDescriptor, group: ViewerSurfaceGroup, intersection: ViewerIntersectionLike): ViewerSurfaceSelection {
  const frame = frameForGroup(group)
  const offset = intersection.point.clone().sub(group.center)
  const hitLocal = Object.freeze({
    x: offset.x * frame.tangentX.x + offset.y * frame.tangentX.y + offset.z * frame.tangentX.z,
    y: offset.x * frame.tangentY.x + offset.y * frame.tangentY.y + offset.z * frame.tangentY.z,
  })
  return Object.freeze({
    surface,
    hitLocal,
    worldPoint: pointDto(intersection.point),
  })
}

function makeSelection(group: ViewerSurfaceGroup, intersection: ViewerIntersectionLike, cachedDescriptor?: SurfaceDescriptor): ViewerSurfaceSelection {
  const descriptor = cachedDescriptor ?? descriptorForGroup(group)
  return trustedSurfaceSelection(descriptor, group, intersection)
}

function meshFromIntersection(intersection: ViewerIntersectionLike): ViewerMesh | null {
  return isViewerMesh(intersection.object) ? intersection.object : null
}

function hitFromGroup(mesh: ViewerMesh, group: ViewerSurfaceGroup, intersection: ViewerIntersectionLike, cachedDescriptor?: SurfaceDescriptor): ViewerSurfaceHit {
  return { selection: makeSelection(group, intersection, cachedDescriptor), mesh, group }
}

async function materialiseSurfaceDescriptors(
  entries: readonly IndexedMesh[],
  options: ViewerSurfaceIndexOptions,
): Promise<readonly SurfaceDescriptor[]> {
  const descriptors: SurfaceDescriptor[] = []
  const chunkSize = chunkSizeFor(options)
  let processed = 0
  for (const entry of entries) {
    for (const groupNumber of entry.groupNumbers) {
      abortSurfaceIndex(options.signal)
      descriptors.push(await descriptorForGroupAsync(buildGroupForPacked(entry.packed, groupNumber), options))
      processed += 1
      if (processed % chunkSize === 0) await yieldSurfaceIndexTask()
    }
  }
  abortSurfaceIndex(options.signal)
  return descriptors
}

function childAncestorsDisableSelection(child: THREE.Object3D): boolean {
  let parent = child.parent
  while (parent !== null) {
    if (parent.userData.selectable === false) return true
    parent = parent.parent
  }
  return false
}

/** Converts a Three.js raycast hit to a plain selection DTO. */
export function selectionFromViewerIntersection(
  intersection: ViewerIntersectionLike,
  tolerance = DEFAULT_TOLERANCE,
  index?: ViewerSurfaceIndex,
): ViewerSurfaceSelection | null {
  const mesh = meshFromIntersection(intersection)
  const faceIndex = intersection.faceIndex
  if (mesh === null || mesh.userData.selectable === false || childAncestorsDisableSelection(mesh) || faceIndex === undefined || faceIndex === null) return null
  if (index !== undefined) return index.selectionForIntersection(intersection)?.selection ?? null
  const group = buildViewerSurfaceGroups(mesh, tolerance).find((candidate) => candidate.faceIndices.includes(faceIndex))
  return group === undefined ? null : makeSelection(group, intersection)
}

/** Resolves a hit while retaining its mesh for renderer-only highlight creation. */
export function viewerSurfaceHitFromIntersection(
  intersection: ViewerIntersectionLike,
  tolerance = DEFAULT_TOLERANCE,
  index?: ViewerSurfaceIndex,
): ViewerSurfaceHit | null {
  const mesh = meshFromIntersection(intersection)
  const faceIndex = intersection.faceIndex
  if (mesh === null || mesh.userData.selectable === false || childAncestorsDisableSelection(mesh) || faceIndex === undefined || faceIndex === null) return null
  if (index !== undefined) return index.selectionForIntersection(intersection)
  const group = buildViewerSurfaceGroups(mesh, tolerance).find((candidate) => candidate.faceIndices.includes(faceIndex))
  return group === undefined ? null : hitFromGroup(mesh, group, intersection)
}

function makeViewerSurfaceIndex(
  entries: readonly IndexedMesh[],
  modelId: string,
  buildMissingRaycastGrids = true,
): ViewerSurfaceIndex {
  const byMesh = new Map<ViewerMesh, IndexedMesh>(entries.map((entry) => [entry.mesh, entry]))
  const descriptorCache = new Map<ViewerSurfaceGroup, SurfaceDescriptor>()
  // Build one bounded, model-scoped acceleration structure per packed mesh.
  // R3F's default Mesh.raycast walks every triangle on every pointer event;
  // keeping this proxy index here makes picking independent of face count for
  // the common large, connected roof/site group.
  for (const entry of entries) {
    // The cooperative builder pre-populates grids for imported models. Keep
    // the synchronous fallback for the small/public builder, but never redo
    // an already-built grid at the async tail.
    if (buildMissingRaycastGrids && entry.packed.raycastGrids === undefined) buildRaycastGrids(entry)
  }
  let descriptors: readonly SurfaceDescriptor[] | undefined
  let descriptorsAsync: Promise<readonly SurfaceDescriptor[]> | undefined
  let gridPreparation: Promise<void> | undefined
  return {
    modelId,
    meshes: entries,
    groupsFor: (mesh) => {
      const entry = byMesh.get(mesh)
      return entry === undefined ? [] : groupsForIndexed(entry)
    },
    surfaceDescriptors: () => {
      if (descriptors !== undefined) return descriptors
      const next: SurfaceDescriptor[] = []
      for (const entry of entries) {
        for (const group of groupsForIndexed(entry)) {
          const descriptor = descriptorForGroup(group)
          descriptorCache.set(group, descriptor)
          next.push(descriptor)
        }
      }
      descriptors = next
      return next
    },
    surfaceDescriptorsAsync: (options = {}) => {
      if (descriptors !== undefined) return Promise.resolve(descriptors)
      if (descriptorsAsync !== undefined) return descriptorsAsync
      const pending = materialiseSurfaceDescriptors(entries, options)
        .then((next) => {
          let descriptorIndex = 0
          for (const entry of entries) {
            for (const group of groupsForIndexed(entry)) {
              const descriptor = next[descriptorIndex]
              if (descriptor !== undefined) descriptorCache.set(group, descriptor)
              descriptorIndex += 1
            }
          }
          descriptors = next
          return next
        })
        .catch((cause: unknown) => {
          descriptorsAsync = undefined
          throw cause
        })
      descriptorsAsync = pending
      return pending
    },
    prepareRaycastGridsAsync: (options = {}) => {
      if (entries.every((entry) => entry.packed.raycastGrids !== undefined)) return Promise.resolve()
      if (gridPreparation !== undefined) return gridPreparation
      const pending = (async (): Promise<void> => {
        for (const entry of entries) {
          abortSurfaceIndex(options.signal)
          if (entry.packed.raycastGrids === undefined) await buildRaycastGridsAsync(entry, options)
        }
      })().catch((cause: unknown) => {
        gridPreparation = undefined
        throw cause
      })
      gridPreparation = pending
      return pending
    },
    selectionForIntersection: (intersection) => {
      const mesh = meshFromIntersection(intersection)
      const faceIndex = intersection.faceIndex
      if (mesh === null || mesh.userData.selectable === false || childAncestorsDisableSelection(mesh) || faceIndex === undefined || faceIndex === null) return null
      const entry = byMesh.get(mesh)
      if (entry === undefined || faceIndex < 0 || faceIndex >= entry.packed.faceToGroup.length) return null
      const groupNumber = entry.packed.faceToGroup[faceIndex] ?? -1
      if (groupNumber < 0 || entry.groupMask[groupNumber] !== 1) return null
      const group = buildGroupForPacked(entry.packed, groupNumber)
      let descriptor = descriptorCache.get(group)
      if (descriptor === undefined) {
        descriptor = descriptorForGroup(group)
        descriptorCache.set(group, descriptor)
      }
      return hitFromGroup(mesh, group, intersection, descriptor)
    },
    raycastRawRay: (ray) => {
      let nearest: ViewerSurfaceRaycastHit | null = null
      for (const entry of entries) {
        for (const groupNumber of entry.groupNumbers) {
          const group = buildGroupForPacked(entry.packed, groupNumber)
          const hit = raycastPackedGroup(entry.packed, group, groupNumber, ray, nearest?.distance ?? Number.POSITIVE_INFINITY)
          if (hit !== null && (nearest === null || hit.distance < nearest.distance)) nearest = hit
        }
      }
      return nearest
    },
  }
}

/** Builds every mesh's grouping once for one loaded model. */
export function createViewerSurfaceIndex(root: THREE.Object3D, modelId = root.uuid, tolerance = DEFAULT_TOLERANCE): ViewerSurfaceIndex {
  root.updateMatrixWorld(true)
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const exteriorCenter = modelExteriorCenter(root, rootInverse)
  const entries: IndexedMesh[] = []
  root.traverse((child) => {
    if (!isViewerMesh(child) || child.userData.selectable === false || childAncestorsDisableSelection(child)) return
    const analysisMatrix = rootInverse.clone().multiply(child.matrixWorld)
    const packed = buildPackedSurfaceMesh(child, tolerance, exteriorCenter, analysisMatrix)
    entries.push(indexedMeshFor(child, packed, 0))
  })
  return makeViewerSurfaceIndex(entries, modelId)
}

/** Builds a model index in cooperative slices so pointer/render work can run. */
export async function createViewerSurfaceIndexAsync(
  root: THREE.Object3D,
  modelId = root.uuid,
  tolerance = DEFAULT_TOLERANCE,
  options: ViewerSurfaceIndexOptions = {},
): Promise<ViewerSurfaceIndex> {
  root.updateMatrixWorld(true)
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const exteriorCenter = modelExteriorCenter(root, rootInverse)
  const meshes: ViewerMesh[] = []
  root.traverse((child) => {
    if (!isViewerMesh(child) || child.userData.selectable === false || childAncestorsDisableSelection(child)) return
    meshes.push(child)
  })
  const entries: IndexedMesh[] = []
  const chunkSize = chunkSizeFor(options)
  const minimumSurfaceAreaM2 = minimumSurfaceAreaFor(options)
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
    const mesh = meshes[meshIndex]
    if (mesh === undefined) continue
    const analysisMatrix = rootInverse.clone().multiply(mesh.matrixWorld)
    const packed = await buildPackedSurfaceMeshAsync(mesh, tolerance, options, exteriorCenter, analysisMatrix)
    entries.push(indexedMeshFor(mesh, packed, minimumSurfaceAreaM2))
    abortSurfaceIndex(options.signal)
    if ((meshIndex + 1) % chunkSize === 0 && meshIndex + 1 < meshes.length) await yieldSurfaceIndexTask()
  }
  // Grid construction is part of the indexing pipeline, not the first
  // pointer event.  Build each large group in cooperative face passes so the
  // R3F/software-WebGL render loop remains responsive while descriptors are
  // materialised by the caller.
  if (options.deferRaycastGrids !== true) {
    for (const entry of entries) {
      abortSurfaceIndex(options.signal)
      await buildRaycastGridsAsync(entry, options)
    }
  }
  return makeViewerSurfaceIndex(entries, modelId, options.deferRaycastGrids !== true)
}

/** Exact retained typed-buffer bytes plus packed face references for planning. */
export function estimateViewerSurfaceIndexBytes(faceCount: number, groupCount = 1): number {
  const faces = Math.max(0, Math.floor(faceCount))
  const groups = Math.max(0, Math.floor(groupCount))
  const perFace = 4 + 12 + 12 + 8 + 8 + 4 + 4
  const perGroup = 12 + 24 + 8
  return faces * perFace + groups * perGroup + (groups + 1) * 4
}

/** Performs a camera raycast and resolves the nearest indexed surface. */
export function raycastViewerSurface(
  root: THREE.Object3D,
  raycaster: THREE.Raycaster,
  pointer: THREE.Vector2,
  camera: THREE.Camera,
  index?: ViewerSurfaceIndex,
): ViewerSurfaceSelection | null {
  raycaster.setFromCamera(pointer, camera)
  if (index !== undefined) {
    // The index is built in root-relative model coordinates. Convert the
    // camera ray once, then use the packed picker rather than Three's
    // face-by-face Mesh.raycast. This is also the public coordinate contract:
    // pointer/camera input may be display/world space, while returned DTOs are
    // always model-root space.
    const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
    const origin = raycaster.ray.origin.clone().applyMatrix4(inverseRoot)
    const direction = raycaster.ray.direction.clone().transformDirection(inverseRoot).normalize()
    const hit = index.raycastRawRay(new THREE.Ray(origin, direction))
    if (hit === null) return null
    return index.selectionForIntersection({ object: hit.mesh, faceIndex: hit.faceIndex, point: hit.point })?.selection ?? null
  }
  const intersections = raycaster.intersectObject(root, true)
  for (const intersection of intersections) {
    const selection = selectionFromViewerIntersection(intersection, DEFAULT_TOLERANCE, index)
    if (selection !== null) return selection
  }
  return null
}

type HighlightSelection = Pick<ViewerSurfaceSelection, 'surface'> | { readonly faceIndices: readonly number[] }

/**
 * A selected surface can contain hundreds of thousands of source triangles.
 * Expanding those triangles into a sibling highlight mesh on a pointer event
 * blocks React/R3F for seconds and duplicates the model's vertex storage. Use
 * the already-materialised surface footprint for large groups instead; small
 * groups retain the exact source-triangle highlight for crisp edges.
 */
const MAX_HIGHLIGHT_FACES = 8_192
const MAX_HIGHLIGHT_REGION_POINTS = 512

function highlightFaceCount(selection: HighlightSelection): number {
  if ('faceIndices' in selection) return selection.faceIndices.length
  let count = 0
  for (const faceRef of selection.surface.faceRefs) count += faceRef.faceIndices.length
  return count
}

function faceIndicesForHighlight(selection: HighlightSelection): readonly number[] {
  if ('faceIndices' in selection) return selection.faceIndices
  return selection.surface.faceRefs.flatMap((faceRef) => faceRef.faceIndices)
}

function limitedFaceIndicesForHighlight(selection: HighlightSelection, limit: number): readonly number[] {
  if ('faceIndices' in selection) return selection.faceIndices.slice(0, limit)
  const indices: number[] = []
  for (const faceRef of selection.surface.faceRefs) {
    for (const faceIndex of faceRef.faceIndices) {
      indices.push(faceIndex)
      if (indices.length >= limit) return indices
    }
  }
  return indices
}

function highlightRegionPoints(region: SurfaceRegion): readonly Point2[] {
  if ('points' in region) {
    if (region.points.length <= MAX_HIGHLIGHT_REGION_POINTS) return region.points
    const stride = Math.ceil(region.points.length / MAX_HIGHLIGHT_REGION_POINTS)
    const points: Point2[] = []
    for (let index = 0; index < MAX_HIGHLIGHT_REGION_POINTS; index += 1) {
      const point = region.points[Math.min(index * stride, region.points.length - 1)]
      if (point !== undefined) points.push(point)
    }
    return points
  }
  return [
    { x: region.x, y: region.y },
    { x: region.x + region.width, y: region.y },
    { x: region.x + region.width, y: region.y + region.height },
    { x: region.x, y: region.y + region.height },
  ]
}

function modelRootMatrixToHighlightParent(mesh: ViewerMesh, targetParent: THREE.Object3D | undefined): THREE.Matrix4 | null {
  if (targetParent === undefined) return null
  let root: THREE.Object3D = mesh
  while (root.parent !== null && root.parent !== targetParent) root = root.parent
  if (root.parent !== targetParent) return null
  root.updateMatrix()
  return root.matrix.clone()
}

function createRegionHighlightGeometry(
  selection: Pick<ViewerSurfaceSelection, 'surface'>,
  targetParent: THREE.Object3D | undefined,
  mesh: ViewerMesh,
): THREE.BufferGeometry | null {
  const points = highlightRegionPoints(selection.surface.region)
  if (points.length < 3) return null
  const contour = points.map((point) => new THREE.Vector2(point.x, point.y))
  const triangles = THREE.ShapeUtils.triangulateShape(contour, [])
  if (triangles.length === 0) return null
  const frame = selection.surface.frame
  const rootMatrix = modelRootMatrixToHighlightParent(mesh, targetParent)
  const vertices: number[] = []
  for (const point of points) {
    const vertex = new THREE.Vector3(
      frame.origin.x + frame.tangentX.x * point.x + frame.tangentY.x * point.y,
      frame.origin.y + frame.tangentX.y * point.x + frame.tangentY.y * point.y,
      frame.origin.z + frame.tangentX.z * point.x + frame.tangentY.z * point.y,
    )
    if (rootMatrix !== null) vertex.applyMatrix4(rootMatrix)
    vertices.push(vertex.x, vertex.y, vertex.z)
  }
  const indices: number[] = []
  for (const triangle of triangles) indices.push(triangle[0] ?? 0, triangle[1] ?? 0, triangle[2] ?? 0)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * Creates a highlight mesh in the coordinate space of `targetParent`.
 * Highlights are rendered as siblings of the loaded model, so using only the
 * source geometry's local positions would lose child translation/rotation.
 */
export function createViewerHighlightGeometry(
  mesh: ViewerMesh,
  selection: HighlightSelection,
  targetParent?: THREE.Object3D,
): THREE.BufferGeometry {
  if (!('faceIndices' in selection) && highlightFaceCount(selection) > MAX_HIGHLIGHT_FACES) {
    const regionGeometry = createRegionHighlightGeometry(selection, targetParent, mesh)
    if (regionGeometry !== null) return regionGeometry
  }
  const source = mesh.geometry
  const position = source.getAttribute('position')
  const index = source.index
  const vertices: number[] = []
  const indices: number[] = []
  const relativeMatrix = new THREE.Matrix4()
  if (targetParent !== undefined) {
    targetParent.updateMatrixWorld(true)
    mesh.updateMatrixWorld(true)
    relativeMatrix.copy(targetParent.matrixWorld).invert().multiply(mesh.matrixWorld)
  }
  const faceIndices = highlightFaceCount(selection) > MAX_HIGHLIGHT_FACES
    ? limitedFaceIndicesForHighlight(selection, MAX_HIGHLIGHT_FACES)
    : faceIndicesForHighlight(selection)
  for (const faceIndex of faceIndices) {
    const offset = faceIndex * 3
    const ai = index?.getX(offset) ?? offset
    const bi = index?.getX(offset + 1) ?? offset + 1
    const ci = index?.getX(offset + 2) ?? offset + 2
    const vertexOffset = vertices.length / 3
    for (const vertexIndex of [ai, bi, ci]) {
      const vertex = new THREE.Vector3(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex))
      if (targetParent !== undefined) vertex.applyMatrix4(relativeMatrix)
      vertices.push(vertex.x, vertex.y, vertex.z)
    }
    indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** Legacy-safe helper that creates an empty geometry when no source mesh is available. */
export function createEmptyViewerHighlightGeometry(): THREE.BufferGeometry {
  return new THREE.BufferGeometry()
}
