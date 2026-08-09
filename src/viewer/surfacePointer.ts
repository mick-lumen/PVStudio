import * as THREE from 'three'

/**
 * Converts an R3F pointer hit from the normalised display group back into the
 * raw model coordinates used by the surface index. Surface DTOs intentionally
 * report those raw coordinates so placement and scene content share one frame.
 */
export function toViewerSurfaceModelPoint(
  displayPoint: THREE.Vector3,
  normalisedPosition: THREE.Vector3,
  normalisedScale: number,
): THREE.Vector3 {
  const scale = Number.isFinite(normalisedScale) && Math.abs(normalisedScale) > Number.EPSILON
    ? normalisedScale
    : 1
  return displayPoint.clone().sub(normalisedPosition).multiplyScalar(1 / scale)
}
