import { describe, expect, it } from 'vitest'
import {
  createSurfaceFrame,
  isSurfaceFrame,
  pointFromSurfaceCoordinates,
  projectPointToFrame,
  projectPointToSurface,
  unprojectPointFromFrame,
} from './index'
import type { SurfaceFrame } from './index'

const frame: SurfaceFrame = {
  origin: { x: 10, y: 20, z: 5 },
  normal: { x: 0, y: 0, z: 1 },
  tangentX: { x: 2, y: 0, z: 0 },
  tangentY: { x: 0, y: 3, z: 0 },
}

describe('pure surface-frame projection', () => {
  it('projects metres into local coordinates and retains signed normal offset', () => {
    const projected = projectPointToFrame(frame, { x: 12, y: 26, z: 5.4 })
    expect(projected.u).toBeCloseTo(2)
    expect(projected.v).toBeCloseTo(6)
    expect(projected.normalOffsetM).toBeCloseTo(0.4)
    expect(projectPointToSurface(frame, { x: 12, y: 26, z: 5.4 })).toEqual({ x: 2, y: 6 })
  })

  it('round-trips local coordinates through non-unit basis vectors', () => {
    const local = { u: 2, v: 6, normalOffsetM: 0.4 }
    expect(unprojectPointFromFrame(frame, local)).toEqual({ x: 12, y: 26, z: 5.4 })
    expect(pointFromSurfaceCoordinates(frame, { x: 2, y: 6 }, 0.4)).toEqual({ x: 12, y: 26, z: 5.4 })
  })

  it('does not mutate either input object and rejects invalid coordinates', () => {
    const point = { x: 12, y: 26, z: 5.4 }
    const before = { ...point }
    projectPointToSurface(frame, point)
    expect(point).toEqual(before)
    expect(() => projectPointToFrame(frame, { x: Number.NaN, y: 0, z: 0 })).toThrow(TypeError)
    expect(() => unprojectPointFromFrame(frame, { u: 0, v: Number.POSITIVE_INFINITY, normalOffsetM: 0 })).toThrow(TypeError)
  })

  it('normalises non-unit bases and rejects non-orthogonal or left-handed frames', () => {
    const canonical = createSurfaceFrame(frame)
    expect(canonical.normal).toEqual({ x: 0, y: 0, z: 1 })
    expect(canonical.tangentX).toEqual({ x: 1, y: 0, z: 0 })
    expect(canonical.tangentY).toEqual({ x: 0, y: 1, z: 0 })
    expect(projectPointToSurface(canonical, { x: 12, y: 26, z: 5.4 })).toEqual({ x: 2, y: 6 })

    const malformedFrames: SurfaceFrame[] = [
      { ...frame, tangentY: { x: 0, y: -3, z: 0 } },
      { ...frame, tangentY: { x: 1, y: 3, z: 0 } },
      { ...frame, tangentX: { x: 0, y: 0, z: 0 } },
      { ...frame, origin: { ...frame.origin, z: Number.NaN } },
    ]
    for (const malformed of malformedFrames) {
      expect(isSurfaceFrame(malformed)).toBe(false)
      expect(() => createSurfaceFrame(malformed)).toThrow(TypeError)
      expect(() => projectPointToFrame(malformed, { x: 0, y: 0, z: 0 })).toThrow(TypeError)
    }
  })
})
