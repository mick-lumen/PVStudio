import { describe, expect, it } from 'vitest'
import type { PanelDefinition, PanelPlacement, SurfaceDescriptor } from '../core'
import { composePanelLocalMatrix, computePanelPose, cross, dot, normalise } from './math'

const panel: PanelDefinition = {
  id: 'p400',
  manufacturer: 'PV Studio',
  model: '400',
  widthM: 1,
  heightM: 2,
  thicknessM: 0.04,
  wattageW: 400,
  weightKg: 20,
}

const surface: SurfaceDescriptor = {
  id: 'roof',
  frame: {
    origin: { x: 10, y: 20, z: 30 },
    normal: { x: 0, y: 0, z: 2 },
    tangentX: { x: 1, y: 0, z: 0 },
    tangentY: { x: 0, y: 1, z: 0 },
  },
  region: { x: 0, y: 0, width: 20, height: 20 },
  area: 400,
  azimuthDeg: 90,
  tiltDeg: 25,
  usableArea: 400,
  faceRefs: [],
}

const placement = (overrides: Partial<PanelPlacement> = {}): PanelPlacement => ({
  id: 'placement-1',
  panelId: panel.id,
  surfaceId: surface.id,
  localCenter: { x: 2, y: 3 },
  orientation: 'portrait',
  clearanceM: 0.1,
  tiltDeg: 0,
  ...overrides,
})

describe('panel rendering pose math', () => {
  it('normalises malformed frames and preserves dimensionally accurate portrait pose', () => {
    const pose = computePanelPose(panel, surface, placement())
    expect(pose.footprint).toEqual({ widthM: 1, heightM: 2 })
    expect(pose.surfaceAnchor).toEqual({ x: 12, y: 23, z: 30.1 })
    expect(pose.center).toEqual({ x: 12, y: 23, z: 30.12 })
    expect(pose.normal).toEqual([0, 0, 1])
    expect(pose.tangentX).toEqual([1, 0, 0])
    expect(pose.tangentY).toEqual([0, 1, 0])
    expect(pose.matrix.slice(12, 15)).toEqual([12, 23, 30.12])
  })

  it('swaps the local footprint for landscape and rotates independently around tangent X', () => {
    const pose = computePanelPose(panel, surface, placement({ orientation: 'landscape', tiltDeg: 90 }))
    expect(pose.footprint).toEqual({ widthM: 2, heightM: 1 })
    expect(pose.tiltDeg).toBe(90)
    expect(pose.normal[0]).toBeCloseTo(0)
    expect(pose.normal[1]).toBeCloseTo(1)
    expect(pose.normal[2]).toBeCloseTo(0)
    expect(pose.tangentX).toEqual([1, 0, 0])
    expect(pose.tangentY[0]).toBeCloseTo(0)
    expect(pose.tangentY[1]).toBeCloseTo(0)
    expect(pose.tangentY[2]).toBeCloseTo(-1)
  })

  it('clamps unsafe clearance/tilt values and emits a serialisable matrix', () => {
    const pose = computePanelPose(panel, surface, placement({ clearanceM: -1, tiltDeg: Number.POSITIVE_INFINITY }))
    expect(pose.clearanceM).toBe(0)
    expect(pose.tiltDeg).toBe(0)
    expect(JSON.parse(JSON.stringify(pose))).toEqual(pose)
  })

  it('composes local rail translation and dimensions in column-major order', () => {
    const pose = computePanelPose(panel, surface, placement()).matrix
    const matrix = composePanelLocalMatrix(pose, [0.5, 0.25, -0.2], [2, 3, 4])
    expect(matrix.slice(0, 12)).toEqual([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0])
    expect(matrix.slice(12, 15)).toEqual([12.5, 23.25, 29.92])
  })

  it('keeps supplied frame axes right-handed after projection and tilt', () => {
    const pose = computePanelPose(panel, {
      ...surface,
      frame: {
        ...surface.frame,
        normal: { x: 0, y: 0, z: 7 },
        tangentX: { x: 1, y: 0, z: 0.1 },
        tangentY: { x: 0, y: -1, z: 0 },
      },
    }, placement({ tiltDeg: 35 }))
    expect(dot(cross(pose.tangentX, pose.tangentY), pose.normal)).toBeCloseTo(1)
  })

  it('provides a finite normal fallback for zero vectors', () => {
    expect(normalise([0, 0, 0])).toEqual([0, 0, 1])
  })
})
