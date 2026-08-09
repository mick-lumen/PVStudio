import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { NO_PANEL_RAYCAST } from './PanelBatch'

describe('panel pointer raycasts', () => {
  it('lets the viewer surface remain the nearest hit beneath an inert preview mesh', () => {
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.MeshBasicMaterial(),
    )
    surface.name = 'viewer-surface'

    const preview = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 0.02),
      new THREE.MeshBasicMaterial(),
    )
    preview.name = 'cursor-ghost'
    preview.position.z = 0.05
    preview.raycast = NO_PANEL_RAYCAST

    surface.updateMatrixWorld(true)
    preview.updateMatrixWorld(true)
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 5),
      new THREE.Vector3(0, 0, -1),
    )
    const intersections = raycaster.intersectObjects([preview, surface], true)

    expect(intersections.length).toBeGreaterThan(0)
    expect(intersections.every((intersection) => intersection.object === surface)).toBe(true)

    surface.geometry.dispose()
    surface.material.dispose()
    preview.geometry.dispose()
    preview.material.dispose()
  })
})
