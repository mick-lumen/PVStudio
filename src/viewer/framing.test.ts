import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { cameraNorthAngleDegrees, computeViewerFrame, createViewerNormalisation, createViewerOrthographicFrustum, fitViewerCamera, perspectiveWorldUnitsPerPixel } from './framing'

describe('viewer framing', () => {
  it('computes world bounds and a precision-friendly normalisation', () => {
    const object = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 6), new THREE.MeshBasicMaterial())
    object.position.set(10, 3, -2)
    const frame = computeViewerFrame(object, 12)

    expect(frame.center.toArray()).toEqual([10, 3, -2])
    expect(frame.size.toArray()).toEqual([4, 2, 6])
    expect(frame.scale).toBeCloseTo(2)
    expect(createViewerNormalisation(frame).position.toArray()).toEqual([-20, -6, 4])

    object.geometry.dispose()
    ;(object.material as THREE.Material).dispose()
  })

  it('returns bounded perspective and top-down camera fits', () => {
    const frame = {
      center: new THREE.Vector3(),
      size: new THREE.Vector3(10, 4, 8),
      radius: 6,
      scale: 1,
    }
    const perspective = fitViewerCamera(frame, 1.5, 'perspective')
    const top = fitViewerCamera(frame, 0.75, 'orthographic')

    expect(perspective.position.length()).toBeGreaterThan(frame.radius * 2)
    expect(perspective.near).toBeGreaterThan(0)
    expect(perspective.far).toBeGreaterThan(perspective.near)
    expect(top.orthographicSize).toBeGreaterThan(frame.size.x)
    expect(top.target.toArray()).toEqual([0, 0, 0])
    expect(top.position.x).toBe(0)
    expect(top.position.z).toBe(0)
    expect(top.position.y).toBeGreaterThan(0)
    expect(createViewerOrthographicFrustum(top.orthographicSize, 0.75)).toEqual({ left: -top.orthographicSize * 0.375, right: top.orthographicSize * 0.375, top: top.orthographicSize / 2, bottom: -top.orthographicSize / 2 })
  })

  it('uses a deterministic fallback for empty objects', () => {
    const frame = computeViewerFrame(new THREE.Group())
    expect(frame.center.toArray()).toEqual([0, 0, 0])
    expect(frame.size.toArray()).toEqual([1, 1, 1])
    expect(frame.scale).toBe(12)
  })

  it('derives a camera-aware north angle from the camera quaternion', () => {
    const camera = new THREE.PerspectiveCamera()
    camera.lookAt(0, 0, -1)
    expect(cameraNorthAngleDegrees(camera)).toBeCloseTo(0)
    camera.rotation.y = Math.PI / 2
    expect(cameraNorthAngleDegrees(camera)).toBeCloseTo(90)
  })

  it('measures perspective scale from camera to the controls target after a pan', () => {
    const camera = new THREE.PerspectiveCamera(42)
    camera.position.set(10, 6, 8)
    const originalTarget = new THREE.Vector3()
    const pannedTarget = new THREE.Vector3(8, 5, 6)
    const originalScale = perspectiveWorldUnitsPerPixel(camera, originalTarget, 600)
    const pannedScale = perspectiveWorldUnitsPerPixel(camera, pannedTarget, 600)
    expect(pannedScale).toBeLessThan(originalScale)
  })
})
