import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { NO_PANEL_RAYCAST, PANEL_RAYCAST } from './PanelBatch'
import { isPrimaryPanelPointer } from './panelPointer'

describe('panel pointer raycasts', () => {
  it('reserves secondary-button input for the context menu instead of starting a drag', () => {
    expect(isPrimaryPanelPointer(0)).toBe(true)
    expect(isPrimaryPanelPointer(1)).toBe(false)
    expect(isPrimaryPanelPointer(2)).toBe(false)
  })

  it('keeps a callable instanced-mesh raycast when interaction is re-enabled', () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 0.02),
      new THREE.MeshBasicMaterial(),
      1,
    )
    mesh.raycast = NO_PANEL_RAYCAST

    mesh.raycast = PANEL_RAYCAST

    expect(typeof mesh.raycast).toBe('function')
    const installedRaycast: unknown = Reflect.get(mesh, 'raycast')
    expect(installedRaycast).toBe(PANEL_RAYCAST)
    expect(installedRaycast).not.toBe(NO_PANEL_RAYCAST)
    mesh.geometry.dispose()
    mesh.material.dispose()
  })

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
