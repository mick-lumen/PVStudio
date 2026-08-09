import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { toViewerSurfaceModelPoint } from './surfacePointer'

describe('surface pointer coordinate mapping', () => {
  it('inverts the normalised model transform exactly', () => {
    const rawPoint = new THREE.Vector3(125, 7, -33)
    const center = new THREE.Vector3(100, 5, -40)
    const scale = 0.5
    const position = center.clone().multiplyScalar(-scale)
    const displayPoint = rawPoint.clone().multiplyScalar(scale).add(position)

    expect(toViewerSurfaceModelPoint(displayPoint, position, scale)).toEqual(rawPoint)
  })

  it('uses an identity scale for invalid values without mutating the hit', () => {
    const displayPoint = new THREE.Vector3(2, 3, 4)
    const position = new THREE.Vector3(1, 1, 1)
    const mapped = toViewerSurfaceModelPoint(displayPoint, position, Number.NaN)

    expect(mapped).toEqual(new THREE.Vector3(1, 2, 3))
    expect(displayPoint).toEqual(new THREE.Vector3(2, 3, 4))
  })
})
