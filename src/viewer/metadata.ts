import * as THREE from 'three'
import type { Point3 } from '../core'
import type { ViewerBoundingBox, ViewerModelMetadata, ViewerSourceMetadata } from './types'

interface MeshMaterial extends THREE.Material {
  readonly map?: THREE.Texture | null
}

interface ViewerMesh extends THREE.Object3D {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
}

export interface ViewerMetadataOptions {
  readonly signal?: AbortSignal
  /** Vertices processed between macrotask yields. */
  readonly chunkSize?: number
  /** Parser-owned source measurements for imported OBJ models. */
  readonly source?: ViewerSourceMetadata
}

function isViewerMesh(child: THREE.Object3D): child is ViewerMesh {
  return child instanceof THREE.Mesh
}

function materialList(material: ViewerMesh['material']): readonly THREE.Material[] {
  return Array.isArray(material) ? material : [material]
}

function isMeshMaterial(material: THREE.Material): material is MeshMaterial {
  return 'map' in material
}

function zeroBoundingBox(): ViewerBoundingBox {
  const zero: Point3 = { x: 0, y: 0, z: 0 }
  return { min: zero, max: zero, size: zero }
}

function pointDto(point: THREE.Vector3): Point3 {
  return { x: point.x, y: point.y, z: point.z }
}

function sourceMetadataFields(source: ViewerSourceMetadata | undefined): {
  readonly sourceVertexCount?: number
  readonly sourcePolygonCount?: number
  readonly sourceBounds?: ViewerBoundingBox
} {
  if (source === undefined) return {}
  return {
    sourceVertexCount: source.vertexCount,
    sourcePolygonCount: source.polygonCount,
    sourceBounds: source.bounds,
  }
}

function sameWorldMatrix(first: THREE.Object3D, second: THREE.Object3D): boolean {
  const firstElements = first.matrixWorld.elements
  const secondElements = second.matrixWorld.elements
  for (let index = 0; index < 16; index += 1) {
    if (firstElements[index] !== secondElements[index]) return false
  }
  return true
}

/** Collects counts and world-space extents for an OBJ or demo scene. */
export function computeViewerMetadata(object: THREE.Object3D, name = 'Site model', isDemo = false, source?: ViewerSourceMetadata): ViewerModelMetadata {
  object.updateMatrixWorld(true)

  let vertexCount = 0
  let polygonCount = 0
  let meshCount = 0
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()

  object.traverse((child) => {
    if (!isViewerMesh(child)) return
    meshCount += 1
    const geometry = child.geometry
    const positions = geometry.getAttribute('position')
    vertexCount += positions.count
    polygonCount += Math.floor((geometry.index?.count ?? positions.count) / 3)
    for (const material of materialList(child.material)) {
      materials.add(material)
      if (isMeshMaterial(material) && material.map !== undefined && material.map !== null) {
        textures.add(material.map)
      }
    }
  })

  const worldBox = new THREE.Box3().setFromObject(object)
  const boundingBox = worldBox.isEmpty()
    ? zeroBoundingBox()
    : (() => {
        const size = worldBox.getSize(new THREE.Vector3())
        return {
          min: pointDto(worldBox.min),
          max: pointDto(worldBox.max),
          size: pointDto(size),
        }
      })()

  return {
    name,
    vertexCount,
    polygonCount,
    ...sourceMetadataFields(source),
    meshCount,
    materialCount: materials.size,
    textureCount: textures.size,
    boundingBox,
    isDemo,
  }
}

function abortMetadata(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Model loading was cancelled', 'AbortError')
}

function yieldMetadataTask(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Computes metadata in bounded slices.  The synchronous helper remains useful
 * for tiny demo scenes, while model loading uses this path so a large vertex
 * buffer cannot monopolise the browser event loop while its bounds are read.
 */
export async function computeViewerMetadataAsync(
  object: THREE.Object3D,
  name = 'Site model',
  isDemo = false,
  options: ViewerMetadataOptions = {},
): Promise<ViewerModelMetadata> {
  object.updateMatrixWorld(true)
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? 16_384))
  let vertexCount = 0
  let polygonCount = 0
  let meshCount = 0
  let visitedVertices = 0
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const meshes: ViewerMesh[] = []
  object.traverse((child) => {
    if (isViewerMesh(child)) meshes.push(child)
  })

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  const source = options.source
  const canUseSourceBounds = source !== undefined
    && meshes.length > 0
    && meshes.every((mesh) => sameWorldMatrix(mesh, object))
  let sourceBoundsIncluded = false
  const includeWorld = (x: number, y: number, z: number): void => {
    const elements = object.matrixWorld.elements
    const divisor = elements[3] * x + elements[7] * y + elements[11] * z + elements[15]
    const inverseDivisor = divisor === 0 ? 1 : 1 / divisor
    const worldX = (elements[0] * x + elements[4] * y + elements[8] * z + elements[12]) * inverseDivisor
    const worldY = (elements[1] * x + elements[5] * y + elements[9] * z + elements[13]) * inverseDivisor
    const worldZ = (elements[2] * x + elements[6] * y + elements[10] * z + elements[14]) * inverseDivisor
    minX = Math.min(minX, worldX)
    minY = Math.min(minY, worldY)
    minZ = Math.min(minZ, worldZ)
    maxX = Math.max(maxX, worldX)
    maxY = Math.max(maxY, worldY)
    maxZ = Math.max(maxZ, worldZ)
  }
  if (canUseSourceBounds) {
    // `bounds` covers every source `v`, including unused outliers. The
    // rendered/referenced bounds are authoritative for the camera and model
    // box, while the full source bounds remain available as metadata.
    const sourceBounds = source.renderedBounds ?? source.bounds
    const sourceMin = sourceBounds.min
    const sourceMax = sourceBounds.max
    includeWorld(sourceMin.x, sourceMin.y, sourceMin.z)
    includeWorld(sourceMin.x, sourceMin.y, sourceMax.z)
    includeWorld(sourceMin.x, sourceMax.y, sourceMin.z)
    includeWorld(sourceMin.x, sourceMax.y, sourceMax.z)
    includeWorld(sourceMax.x, sourceMin.y, sourceMin.z)
    includeWorld(sourceMax.x, sourceMin.y, sourceMax.z)
    includeWorld(sourceMax.x, sourceMax.y, sourceMin.z)
    includeWorld(sourceMax.x, sourceMax.y, sourceMax.z)
    sourceBoundsIncluded = true
  }
  for (const mesh of meshes) {
    meshCount += 1
    const geometry = mesh.geometry
    const positions = geometry.getAttribute('position')
    vertexCount += positions.count
    polygonCount += Math.floor((geometry.index?.count ?? positions.count) / 3)
    for (const material of materialList(mesh.material)) {
      materials.add(material)
      if (isMeshMaterial(material) && material.map !== undefined && material.map !== null) textures.add(material.map)
    }
    if (sourceBoundsIncluded) continue
    // Scan each local position once, then transform only the eight corners of
    // its axis-aligned local box. The previous implementation multiplied every
    // vertex by matrixWorld, which made a 1.5M-vertex imported OBJ spend
    // seconds in metadata before the first model could be published. An affine
    // Three.js matrix maps a box's extrema to extrema among its corners, so the
    // resulting world bounds remain exact for the same projective-safe matrix
    // math while reducing the expensive transform work to O(1) per mesh.
    let localMinX = Number.POSITIVE_INFINITY
    let localMinY = Number.POSITIVE_INFINITY
    let localMinZ = Number.POSITIVE_INFINITY
    let localMaxX = Number.NEGATIVE_INFINITY
    let localMaxY = Number.NEGATIVE_INFINITY
    let localMaxZ = Number.NEGATIVE_INFINITY
    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index)
      const y = positions.getY(index)
      const z = positions.getZ(index)
      localMinX = Math.min(localMinX, x)
      localMinY = Math.min(localMinY, y)
      localMinZ = Math.min(localMinZ, z)
      localMaxX = Math.max(localMaxX, x)
      localMaxY = Math.max(localMaxY, y)
      localMaxZ = Math.max(localMaxZ, z)
      visitedVertices += 1
      abortMetadata(options.signal)
      if (visitedVertices % chunkSize === 0) await yieldMetadataTask()
    }
    if (!Number.isFinite(localMinX) || !Number.isFinite(localMaxX)) continue
    const elements = mesh.matrixWorld.elements
    const includeMeshWorld = (x: number, y: number, z: number): void => {
      const divisor = elements[3] * x + elements[7] * y + elements[11] * z + elements[15]
      const inverseDivisor = divisor === 0 ? 1 : 1 / divisor
      const worldX = (elements[0] * x + elements[4] * y + elements[8] * z + elements[12]) * inverseDivisor
      const worldY = (elements[1] * x + elements[5] * y + elements[9] * z + elements[13]) * inverseDivisor
      const worldZ = (elements[2] * x + elements[6] * y + elements[10] * z + elements[14]) * inverseDivisor
      minX = Math.min(minX, worldX)
      minY = Math.min(minY, worldY)
      minZ = Math.min(minZ, worldZ)
      maxX = Math.max(maxX, worldX)
      maxY = Math.max(maxY, worldY)
      maxZ = Math.max(maxZ, worldZ)
    }
    includeMeshWorld(localMinX, localMinY, localMinZ)
    includeMeshWorld(localMinX, localMinY, localMaxZ)
    includeMeshWorld(localMinX, localMaxY, localMinZ)
    includeMeshWorld(localMinX, localMaxY, localMaxZ)
    includeMeshWorld(localMaxX, localMinY, localMinZ)
    includeMeshWorld(localMaxX, localMinY, localMaxZ)
    includeMeshWorld(localMaxX, localMaxY, localMinZ)
    includeMeshWorld(localMaxX, localMaxY, localMaxZ)
  }
  abortMetadata(options.signal)
  const boundingBox = Number.isFinite(minX) && Number.isFinite(maxX)
    ? {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
      }
    : zeroBoundingBox()
  return {
    name,
    vertexCount,
    polygonCount,
    ...sourceMetadataFields(options.source),
    meshCount,
    materialCount: materials.size,
    textureCount: textures.size,
    boundingBox,
    isDemo,
  }
}

/** Formats a count without turning metadata into a noisy wall of digits. */
export function formatViewerCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

export function formatViewerDimension(value: number, unit = 'm'): string {
  const absolute = Math.abs(value)
  const precision = absolute >= 10 ? 1 : absolute >= 1 ? 2 : 3
  return `${value.toFixed(precision)} ${unit}`
}
