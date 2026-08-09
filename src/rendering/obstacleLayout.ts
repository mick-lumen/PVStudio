import type { RectangularObstacle, SurfaceDescriptor } from '../core'
import {
  add,
  cross,
  dot,
  normalise,
  scale,
  subtract,
  type Matrix4Tuple,
  type Vector3Tuple,
} from './math'

export type ObstacleRenderKind = 'persistent' | 'draft'

export interface ObstacleRenderItem {
  readonly key: string
  readonly surfaceId: string
  readonly obstacle: RectangularObstacle
  readonly kind: ObstacleRenderKind
  readonly dimensions: Vector3Tuple
  readonly matrix: Matrix4Tuple
}

const EPSILON = 1e-9
const FALLBACK_X: Vector3Tuple = [1, 0, 0]
const FALLBACK_Z: Vector3Tuple = [0, 0, 1]

const tuple = (value: { readonly x: number; readonly y: number; readonly z: number }): Vector3Tuple => [
  Number.isFinite(value.x) ? value.x : 0,
  Number.isFinite(value.y) ? value.y : 0,
  Number.isFinite(value.z) ? value.z : 0,
]

const length = (value: Vector3Tuple): number => Math.hypot(value[0], value[1], value[2])

const orthogonalTangent = (normal: Vector3Tuple): Vector3Tuple => {
  const preferred: Vector3Tuple = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : FALLBACK_X
  return normalise(subtract(preferred, scale(normal, dot(preferred, normal))), FALLBACK_X)
}

const projectedUnit = (value: Vector3Tuple, normal: Vector3Tuple): Vector3Tuple | undefined => {
  const projected = subtract(value, scale(normal, dot(value, normal)))
  const magnitude = length(projected)
  return magnitude > EPSILON && Number.isFinite(magnitude) ? scale(projected, 1 / magnitude) : undefined
}

const frameAxes = (surface: SurfaceDescriptor): {
  readonly normal: Vector3Tuple
  readonly tangentX: Vector3Tuple
  readonly tangentY: Vector3Tuple
} => {
  const normal = normalise(tuple(surface.frame.normal), FALLBACK_Z)
  const tangentX = projectedUnit(tuple(surface.frame.tangentX), normal) ?? orthogonalTangent(normal)
  const derivedY = normalise(cross(normal, tangentX), orthogonalTangent(normal))
  const suppliedY = projectedUnit(tuple(surface.frame.tangentY), normal)
  const tangentYCandidate = suppliedY === undefined
    ? derivedY
    : normalise(subtract(suppliedY, scale(tangentX, dot(suppliedY, tangentX))), derivedY)
  const tangentY = dot(cross(tangentX, tangentYCandidate), normal) >= 0
    ? tangentYCandidate
    : scale(tangentYCandidate, -1)
  return { normal, tangentX, tangentY }
}

const matrixForObstacle = (
  surface: SurfaceDescriptor,
  obstacle: RectangularObstacle,
  thicknessM: number,
): Matrix4Tuple => {
  const axes = frameAxes(surface)
  const centreX = obstacle.x + obstacle.width / 2
  const centreY = obstacle.y + obstacle.height / 2
  const center = add(
    add(tuple(surface.frame.origin), scale(axes.tangentX, centreX)),
    add(scale(axes.tangentY, centreY), scale(axes.normal, thicknessM / 2)),
  )
  const tangentX = scale(axes.tangentX, obstacle.width)
  const tangentY = scale(axes.tangentY, obstacle.height)
  const normal = scale(axes.normal, thicknessM)
  return [
    tangentX[0], tangentX[1], tangentX[2], 0,
    tangentY[0], tangentY[1], tangentY[2], 0,
    normal[0], normal[1], normal[2], 0,
    center[0], center[1], center[2], 1,
  ]
}

const validObstacle = (obstacle: RectangularObstacle | undefined): obstacle is RectangularObstacle =>
  obstacle !== undefined
  && typeof obstacle.id === 'string'
  && obstacle.id.length > 0
  && Number.isFinite(obstacle.x)
  && Number.isFinite(obstacle.y)
  && Number.isFinite(obstacle.width)
  && Number.isFinite(obstacle.height)
  && obstacle.width > 0
  && obstacle.height > 0

/**
 * Build stable serialisable transforms for the obstacle scene layer. The
 * result is intentionally pure so it can be memoised by the R3F component and
 * exercised without a WebGL context.
 */
export function buildObstacleRenderItems(
  surfaces: readonly SurfaceDescriptor[],
  obstaclesBySurface: Readonly<Record<string, readonly RectangularObstacle[]>>,
  draftObstacle: RectangularObstacle | null = null,
  draftSurfaceId: string | null = null,
): readonly ObstacleRenderItem[] {
  const items: ObstacleRenderItem[] = []
  const thicknessM = 0.025
  for (const surface of surfaces) {
    const obstacles = obstaclesBySurface[surface.id] ?? []
    for (const obstacle of obstacles) {
      if (!validObstacle(obstacle)) continue
      items.push({
        key: `${surface.id}:${obstacle.id}`,
        surfaceId: surface.id,
        obstacle,
        kind: 'persistent',
        dimensions: [obstacle.width, obstacle.height, thicknessM],
        matrix: matrixForObstacle(surface, obstacle, thicknessM),
      })
    }
    if (draftSurfaceId === surface.id && validObstacle(draftObstacle ?? undefined)) {
      const draft = draftObstacle as RectangularObstacle
      items.push({
        key: `${surface.id}:draft:${draft.id}`,
        surfaceId: surface.id,
        obstacle: draft,
        kind: 'draft',
        dimensions: [draft.width, draft.height, thicknessM],
        matrix: matrixForObstacle(surface, draft, thicknessM),
      })
    }
  }
  return items
}
