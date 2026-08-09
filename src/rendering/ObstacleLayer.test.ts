import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { NO_OBSTACLE_RAYCAST } from './ObstacleLayer'

describe('ObstacleLayer pointer isolation', () => {
  it('keeps overlay meshes out of raycasts so the underlying picker can receive hits', () => {
    const scene = new THREE.Group()
    const overlay = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    overlay.raycast = NO_OBSTACLE_RAYCAST
    const picker = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    scene.add(overlay, picker)
    scene.updateMatrixWorld(true)

    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 5),
      new THREE.Vector3(0, 0, -1),
    )
    const hits = raycaster.intersectObject(scene, true)

    expect(overlay.raycast === NO_OBSTACLE_RAYCAST).toBe(true)
    expect(hits.some((hit) => hit.object === overlay)).toBe(false)
    expect(hits.some((hit) => hit.object === picker)).toBe(true)
  })
})
