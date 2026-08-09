import type { ReactNode } from 'react'
import { useMemo } from 'react'
import * as THREE from 'three'
import type { RectangularObstacle, SurfaceDescriptor } from '../core'
import { buildObstacleRenderItems, type ObstacleRenderItem } from './obstacleLayout'

export interface ObstacleLayerProps {
  readonly surfaces: readonly SurfaceDescriptor[]
  readonly obstaclesBySurface: Readonly<Record<string, readonly RectangularObstacle[]>>
  readonly draftObstacle?: RectangularObstacle | null
  readonly draftSurfaceId?: string | null
  readonly name?: string
}

const SHARED_GEOMETRY = new THREE.BoxGeometry(1, 1, 1)
const PERSISTENT_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xf97316,
  transparent: true,
  opacity: 0.42,
  depthWrite: false,
})
const DRAFT_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xfbbf24,
  transparent: true,
  opacity: 0.28,
  depthWrite: false,
})

/** Overlay meshes must never win the scene raycast over the packed picker. */
export const NO_OBSTACLE_RAYCAST: THREE.Mesh['raycast'] = (): void => {}

interface ObstacleMeshItem {
  readonly item: ObstacleRenderItem
  readonly matrix: THREE.Matrix4
}

/** A memoised, surface-aligned obstacle layer for the Viewer scene. */
export function ObstacleLayer({
  surfaces,
  obstaclesBySurface,
  draftObstacle = null,
  draftSurfaceId = null,
  name = 'pv-obstacle-layer',
}: ObstacleLayerProps): ReactNode {
  const items = useMemo(
    () => buildObstacleRenderItems(surfaces, obstaclesBySurface, draftObstacle, draftSurfaceId),
    [draftObstacle, draftSurfaceId, obstaclesBySurface, surfaces],
  )
  const meshes = useMemo<readonly ObstacleMeshItem[]>(
    () => items.map((item) => ({ item, matrix: new THREE.Matrix4().fromArray(item.matrix) })),
    [items],
  )
  return (
    <group name={name}>
      {meshes.map(({ item, matrix }) => (
        <mesh
          key={item.key}
          geometry={SHARED_GEOMETRY}
          material={item.kind === 'draft' ? DRAFT_MATERIAL : PERSISTENT_MATERIAL}
          matrix={matrix}
          matrixAutoUpdate={false}
          raycast={NO_OBSTACLE_RAYCAST}
          renderOrder={item.kind === 'draft' ? 4 : 3}
          userData={{ surfaceId: item.surfaceId, obstacleId: item.obstacle.id, kind: item.kind }}
        />
      ))}
    </group>
  )
}
