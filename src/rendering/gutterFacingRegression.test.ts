import { describe, expect, it } from 'vitest'
import type { PanelDefinition, PanelPlacement, Point3, SurfaceDescriptor } from '../core'
import { buildPanelRenderItems, groupPanelRenderItems } from './layout'
import { computePanelPose, cross, dot, type PanelPose, type Vector3Tuple } from './math'

const panel: PanelDefinition = {
  id: 'gutter-panel',
  manufacturer: 'PV Studio',
  model: 'GUTTER-400',
  widthM: 1,
  heightM: 2,
  thicknessM: 0.04,
  wattageW: 400,
  weightKg: 20,
}

// This frame is sloped: +Y is the projected world-down direction toward the
// gutter, while +X runs parallel to the gutter. X × Y = the outward normal.
const slopedSurface: SurfaceDescriptor = {
  id: 'sloped-roof',
  frame: {
    origin: { x: 10, y: 20, z: 30 },
    normal: { x: 0, y: 0.6, z: 0.8 },
    tangentX: { x: -1, y: 0, z: 0 },
    tangentY: { x: 0, y: -0.8, z: 0.6 },
  },
  region: { x: 0, y: 0, width: 20, height: 20 },
  area: 400,
  azimuthDeg: 180,
  tiltDeg: 36.87,
  usableArea: 400,
  faceRefs: [],
}

const downhill: Vector3Tuple = [0, -0.8, 0.6]
const gutterParallel: Vector3Tuple = [-1, 0, 0]
const outward: Vector3Tuple = [0, 0.6, 0.8]

const placement = (
  id: string,
  orientation: PanelPlacement['orientation'],
  localCenter = { x: 2, y: 3 },
): PanelPlacement => ({
  id,
  panelId: panel.id,
  surfaceId: slopedSurface.id,
  localCenter,
  orientation,
  clearanceM: 0.15,
  tiltDeg: 0,
})

const assertRightHandedDownhillFrame = (pose: PanelPose): void => {
  expect(dot(pose.tangentY, downhill)).toBeCloseTo(1)
  expect(dot(cross(pose.tangentX, pose.tangentY), pose.normal)).toBeCloseTo(1)
}

const pointOnSurfacePlane = (point: Point3, localCenter: PanelPlacement['localCenter']): Point3 => ({
  x: point.x + slopedSurface.frame.tangentX.x * localCenter.x + slopedSurface.frame.tangentY.x * localCenter.y,
  y: point.y + slopedSurface.frame.tangentX.y * localCenter.x + slopedSurface.frame.tangentY.y * localCenter.y,
  z: point.z + slopedSurface.frame.tangentX.z * localCenter.x + slopedSurface.frame.tangentY.z * localCenter.y,
})

const displacement = (from: Point3, to: Point3): Vector3Tuple => [
  to.x - from.x,
  to.y - from.y,
  to.z - from.z,
]

describe('v2 automatic gutter-facing panel transforms', () => {
  it('keeps portrait long edges downhill and landscape long edges parallel to the gutter', () => {
    // “Faces gutter” means the panel/row short edge points downhill; this
    // convention uses the canonical SurfaceDescriptor frame, not gutter UI.
    const portraitPlacement = placement('portrait', 'portrait')
    const landscapePlacement = placement('landscape', 'landscape')
    const portrait = computePanelPose(panel, slopedSurface, portraitPlacement)
    const landscape = computePanelPose(panel, slopedSurface, landscapePlacement)

    expect(portrait.footprint).toEqual({ widthM: 1, heightM: 2 })
    expect(portrait.footprint.heightM).toBeGreaterThan(portrait.footprint.widthM)
    expect(dot(portrait.tangentY, downhill)).toBeCloseTo(1)

    expect(landscape.footprint).toEqual({ widthM: 2, heightM: 1 })
    expect(landscape.footprint.widthM).toBeGreaterThan(landscape.footprint.heightM)
    expect(dot(landscape.tangentX, gutterParallel)).toBeCloseTo(1)
    expect(dot(landscape.tangentY, downhill)).toBeCloseTo(1)
    assertRightHandedDownhillFrame(portrait)
    assertRightHandedDownhillFrame(landscape)
  })

  it('keeps positive clearance outside the sloped surface along its outward normal', () => {
    const current = placement('clearance', 'portrait')
    const pose = computePanelPose(panel, slopedSurface, current)
    const planePoint = pointOnSurfacePlane(slopedSurface.frame.origin, current.localCenter)

    expect(dot(displacement(planePoint, pose.surfaceAnchor), outward)).toBeCloseTo(current.clearanceM)
    expect(dot(displacement(planePoint, pose.center), outward)).toBeCloseTo(current.clearanceM + panel.thicknessM / 2)
    expect(dot(displacement(planePoint, pose.surfaceAnchor), outward)).toBeGreaterThan(0)
  })

  it('uses a stable right-handed fallback frame for flat surfaces without supplied tangents', () => {
    const flatSurface: SurfaceDescriptor = {
      ...slopedSurface,
      id: 'flat-roof',
      frame: {
        ...slopedSurface.frame,
        normal: { x: 0, y: 0, z: 1 },
        tangentX: { x: 0, y: 0, z: 0 },
        tangentY: { x: 0, y: 0, z: 0 },
      },
    }
    const current: PanelPlacement = { ...placement('flat', 'portrait'), surfaceId: flatSurface.id }
    const first = computePanelPose(panel, flatSurface, current)
    const second = computePanelPose(panel, flatSurface, current)

    expect(first.tangentX).toEqual([1, 0, 0])
    expect(first.tangentY).toEqual([0, 1, 0])
    expect(first.normal).toEqual([0, 0, 1])
    expect(first.matrix).toEqual(second.matrix)
    expect(dot(cross(first.tangentX, first.tangentY), first.normal)).toBeCloseTo(1)
  })

  it('preserves downhill-facing transforms for mixed portrait and landscape render batches', () => {
    const items = buildPanelRenderItems({
      placements: [placement('batch-portrait', 'portrait'), placement('batch-landscape', 'landscape')],
      panelDefinitions: [panel],
      surfaces: [slopedSurface],
    })
    const batches = groupPanelRenderItems(items)
    const batchedItems = batches.flatMap((batch) => batch.items)

    expect(batchedItems.map((item) => item.id)).toEqual(['batch-portrait', 'batch-landscape'])
    expect(batches).toHaveLength(2)
    for (const item of batchedItems) {
      assertRightHandedDownhillFrame(item.pose)
      expect(dot(item.pose.tangentY, downhill)).toBeCloseTo(1)
      if (item.placement.orientation === 'portrait') {
        expect(item.pose.footprint.heightM).toBe(panel.heightM)
      } else {
        expect(item.pose.footprint.widthM).toBe(panel.heightM)
        expect(dot(item.pose.tangentX, gutterParallel)).toBeCloseTo(1)
      }
    }
  })
})
