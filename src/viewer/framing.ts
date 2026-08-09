import * as THREE from 'three'
import type { ViewerBoundingBox } from './types'

export interface ViewerFrame {
  readonly center: THREE.Vector3
  readonly size: THREE.Vector3
  readonly radius: number
  readonly scale: number
}

export interface ViewerCameraFit {
  readonly position: THREE.Vector3
  readonly target: THREE.Vector3
  readonly near: number
  readonly far: number
  readonly orthographicSize: number
}

export interface ViewerOrthographicFrustum {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/** Computes a stable world-space frame without mutating the loaded object. */
export function computeViewerFrame(object: THREE.Object3D, targetExtent = 12): ViewerFrame {
  object.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) {
    return {
      center: new THREE.Vector3(),
      size: new THREE.Vector3(1, 1, 1),
      radius: 0.8660254,
      scale: targetExtent,
    }
  }
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(size.length() / 2, 0.001)
  return { center, size, radius, scale: targetExtent / Math.max(size.x, size.y, size.z, 0.001) }
}

/** Computes a frame directly from already-collected metadata bounds. */
export function computeViewerFrameFromBounds(bounds: ViewerBoundingBox, targetExtent = 12): ViewerFrame {
  const size = new THREE.Vector3(bounds.size.x, bounds.size.y, bounds.size.z)
  // A roof or facade can legitimately be planar (one zero-sized axis). Only
  // treat the bounds as empty when every extent is zero/non-finite.
  const largestExtent = Math.max(size.x, size.y, size.z)
  if (!Number.isFinite(largestExtent) || largestExtent <= 0) {
    return {
      center: new THREE.Vector3(),
      size: new THREE.Vector3(1, 1, 1),
      radius: 0.8660254,
      scale: targetExtent,
    }
  }
  const center = new THREE.Vector3(
    (bounds.min.x + bounds.max.x) / 2,
    (bounds.min.y + bounds.max.y) / 2,
    (bounds.min.z + bounds.max.z) / 2,
  )
  const radius = Math.max(size.length() / 2, 0.001)
  return { center, size, radius, scale: targetExtent / Math.max(size.x, size.y, size.z, 0.001) }
}

/** Returns camera limits and a pleasing oblique fit for a frame. */
export function fitViewerCamera(frame: ViewerFrame, aspect = 1, mode: 'perspective' | 'orthographic' = 'perspective'): ViewerCameraFit {
  const target = frame.center.clone()
  const distance = Math.max(frame.radius * 2.7, 2)
  const position = mode === 'orthographic'
    ? target.clone().add(new THREE.Vector3(0, Math.max(frame.radius * 2, 2), 0))
    : target.clone().add(new THREE.Vector3(distance * 0.9, distance * 0.72, distance * 1.05))
  const extent = Math.max(frame.size.x, frame.size.z, frame.size.y, 1)
  return {
    position,
    target,
    near: Math.max(0.01, frame.radius / 1000),
    far: Math.max(frame.radius * 30, 100),
    orthographicSize: mode === 'orthographic' ? extent * (aspect < 1 ? 1 / Math.max(aspect, 0.2) : 1) * 1.12 : extent,
  }
}

/** Converts the fitted vertical span into a viewport-aware orthographic frustum. */
export function createViewerOrthographicFrustum(orthographicSize: number, aspect = 1): ViewerOrthographicFrustum {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const safeSize = Number.isFinite(orthographicSize) && orthographicSize > 0 ? orthographicSize : 1
  const halfHeight = safeSize / 2
  const halfWidth = halfHeight * safeAspect
  return { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight }
}

/** Returns the clockwise screen angle of world north for a camera-aware compass. */
export function cameraNorthAngleDegrees(camera: THREE.Camera): number {
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
  const north = new THREE.Vector3(0, 0, 1)
  const horizontalRight = north.dot(right)
  const horizontalUp = north.dot(up)
  if (Math.abs(horizontalRight) < Number.EPSILON && Math.abs(horizontalUp) < Number.EPSILON) return 0
  return (Math.atan2(-horizontalRight, horizontalUp) * 180 / Math.PI + 360) % 360
}

/** Returns perspective world units represented by one viewport pixel. */
export function perspectiveWorldUnitsPerPixel(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  viewportHeight: number,
): number {
  const safeHeight = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : 1)
  const distance = Math.max(camera.position.distanceTo(target), 0.001)
  return (distance * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / safeHeight
}

/** Maps world bounds to a local, unit-ish scene for precision with huge OBJ files. */
export function createViewerNormalisation(frame: ViewerFrame): { readonly position: THREE.Vector3; readonly scale: number } {
  return { position: frame.center.clone().multiplyScalar(-frame.scale), scale: frame.scale }
}
