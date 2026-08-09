import { describe, expect, it } from 'vitest'
import type {
  AutoFillRequest,
  PanelDefinition,
  PanelPlacement,
  PanelGroupSettings,
  Polygon,
  Rect,
} from '../core'
import {
  boundsOfRegion,
  calculateTotalKwp,
  calculateTotalWattage,
  candidateBounds,
  createSurfaceFrame,
  generateAutoFill,
  normaliseRect,
  normaliseSurfaceNormal,
  orientedFootprint,
  pointInPolygon,
  pointOnSurface,
  projectLocalToWorld,
  projectWorldToLocal,
  rayPlaneIntersection,
  rectangleInsidePolygon,
  rectangleInsideRegion,
  rectangleInsideSurfaceRegion,
  rectanglesOverlap,
} from './geometry'

const panel: PanelDefinition = {
  id: 'panel-400',
  manufacturer: 'PV Studio',
  model: 'Test 400',
  widthM: 1,
  heightM: 2,
  thicknessM: 0.035,
  wattageW: 400,
  weightKg: 20,
}

const settings: PanelGroupSettings = {
  orientation: 'portrait',
  interPanelSpacingM: 0.1,
  rowSpacingM: 0.2,
  setbackM: 0.2,
  clearanceM: 0.1,
  tiltDeg: 10,
}

const request = (region: AutoFillRequest['region'], overrides: Partial<AutoFillRequest> = {}): AutoFillRequest => ({
  panelId: panel.id,
  surfaceId: 'roof',
  region,
  obstacles: [],
  settings,
  ...overrides,
})

describe('surface-local geometry', () => {
  it('normalises valid rectangles and rejects non-finite or degenerate dimensions', () => {
    expect(normaliseRect(null)).toBeUndefined()
    expect(normaliseRect({ x: 3, y: 4, width: -2, height: -1 })).toEqual({ x: 1, y: 3, width: 2, height: 1 })
    expect(normaliseRect({ x: 0, y: 0, width: 0, height: 1 })).toBeUndefined()
    expect(normaliseRect({ x: 0, y: 0, width: Number.NaN, height: 1 })).toBeUndefined()
    expect(boundsOfRegion({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] })).toBeUndefined()
    expect(boundsOfRegion({ points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }] })).toBeUndefined()
    expect(boundsOfRegion({ points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: 0, y: 0 }] })).toBeUndefined()
    expect(boundsOfRegion({ points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }] })).toEqual({ x: 0, y: 0, width: 2, height: 1 })
    expect(pointInPolygon(null, null)).toBe(false)
    expect(rectanglesOverlap(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(false)
    expect(rectangleInsideRegion(null, { x: 0, y: 0, width: 1, height: 1 }, Number.NaN)).toBe(false)
  })

  it('handles inclusive points, boundaries, setbacks and rectangle collisions', () => {
    const rectangle: Rect = { x: 1, y: 1, width: 2, height: 2 }
    expect(rectangleInsideRegion(rectangle, { x: 0, y: 0, width: 5, height: 5 }, 0.5)).toBe(true)
    expect(rectangleInsideRegion(rectangle, { x: 0, y: 0, width: 5, height: 5 }, 1.1)).toBe(false)
    expect(rectanglesOverlap(rectangle, { x: 3, y: 1, width: 1, height: 1 })).toBe(true)
    expect(rectanglesOverlap(rectangle, { x: 3.01, y: 1, width: 1, height: 1 })).toBe(false)
    expect(pointInPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }])).toBe(true)
    expect(pointInPolygon({ x: 5, y: 5 }, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }])).toBe(false)
  })

  it('keeps candidate rectangles inside polygon boundaries, including concave regions', () => {
    const triangle: Polygon = { points: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 6 }] }
    const rectangle: Rect = { x: 0.5, y: 0.5, width: 1, height: 1 }
    expect(rectangleInsidePolygon(rectangle, triangle.points, 0.1)).toBe(true)
    expect(rectangleInsidePolygon({ x: 4, y: 3, width: 1, height: 1 }, triangle.points, 0)).toBe(false)

    const concave: Polygon = { points: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 6 }, { x: 0, y: 6 }] }
    const candidates = generateAutoFill(panel, request(concave, {
      settings: { ...settings, setbackM: 0.1, interPanelSpacingM: 0.2, rowSpacingM: 0.2 },
    }))
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) expect(rectangleInsideSurfaceRegion(candidateBounds(candidate), concave, 0.1)).toBe(true)
  })

  it('generates deterministic row-major candidates with spacing, orientation, obstacles and totals', () => {
    const first = generateAutoFill(panel, request({ x: 0, y: 0, width: 5, height: 5 }))
    const second = generateAutoFill(panel, request({ x: 0, y: 0, width: 5, height: 5 }))
    expect(first).toEqual(second)
    expect(first.length).toBe(8)
    expect(first[0]?.localCenter).toEqual({ x: 0.7, y: 1.2 })
    expect(orientedFootprint(panel, 'portrait')).toEqual({ widthM: 1, heightM: 2 })
    expect(orientedFootprint(panel, 'landscape')).toEqual({ widthM: 2, heightM: 1 })

    const blocked = generateAutoFill(panel, request({ x: 0, y: 0, width: 5, height: 5 }, {
      obstacles: [{ id: 'chimney', x: 0.6, y: 1.1, width: 1, height: 2 }],
    }))
    expect(blocked.length).toBe(first.length - 4)
    expect(blocked.some((candidate) => candidate.localCenter.x === 0.7 && candidate.localCenter.y === 1.2)).toBe(false)

    const placements: PanelPlacement[] = first.slice(0, 2).map((candidate, index) => ({
      id: `placement-${String(index)}`,
      panelId: panel.id,
      surfaceId: 'roof',
      localCenter: candidate.localCenter,
      orientation: candidate.orientation,
      clearanceM: candidate.clearanceM,
      tiltDeg: candidate.tiltDeg,
    }))
    expect(calculateTotalWattage(placements, { [panel.id]: panel })).toBe(800)
    expect(calculateTotalKwp(placements, { [panel.id]: panel })).toBe(0.8)
  })

  it('rejects malformed dimensions and settings rather than producing NaN candidates', () => {
    expect(generateAutoFill({ widthM: Number.NaN, heightM: 2 }, request({ x: 0, y: 0, width: 5, height: 5 }))).toEqual([])
    expect(generateAutoFill({ widthM: 0, heightM: 2 }, request({ x: 0, y: 0, width: 5, height: 5 }))).toEqual([])
    expect(generateAutoFill(panel, request({ x: 0, y: 0, width: 5, height: 5 }, {
      settings: { ...settings, rowSpacingM: Number.POSITIVE_INFINITY },
    }))).toEqual([])
    expect(generateAutoFill(panel, request({ x: 0, y: 0, width: 5, height: 5 }, {
      settings: { ...settings, tiltDeg: 91 },
    }))).toEqual([])
    expect(generateAutoFill(panel, request({ x: 0, y: 0, width: Number.NaN, height: 5 }))).toEqual([])
  })

  it('projects points through a deterministic orthonormal surface frame', () => {
    const frame = createSurfaceFrame({ x: 10, y: 20, z: 30 }, { x: 0, y: 0, z: 1 })
    const world = pointOnSurface({ x: 2, y: 3 }, frame, 0.4)
    expect(world).toEqual({ x: 12, y: 23, z: 30.4 })
    expect(normaliseSurfaceNormal({ x: 0, y: 0, z: 2 })).toEqual({ x: 0, y: 0, z: 1 })
    expect(normaliseSurfaceNormal({ x: Number.NaN, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 1 })
  })

  it('rejects concave edge crossings, malformed frames and negative clearances', () => {
    const uShape: Polygon = {
      points: [
        { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 6, y: 8 },
        { x: 6, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 8 }, { x: 0, y: 8 },
      ],
    }
    // All four corners lie in the two arms/base, but the top edge crosses the notch.
    expect(rectangleInsidePolygon({ x: 1, y: 1, width: 6, height: 2 }, uShape.points, 0)).toBe(false)
    expect(rectangleInsidePolygon({ x: 0.5, y: 0.5, width: 1, height: 1 }, [
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
    ], 0.6)).toBe(false)
    const frame = createSurfaceFrame({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
    expect(() => createSurfaceFrame({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toThrow()
    expect(() => pointOnSurface({ x: 1, y: 1 }, frame, -0.1)).toThrow()
    expect(() => pointOnSurface({ x: 1, y: 1 }, { ...frame, tangentX: { x: 0, y: 0, z: 0 } }, 0)).toThrow()
  })

  it('round-trips local projections and resolves forward ray hits', () => {
    const frame = createSurfaceFrame({ x: 10, y: 20, z: 30 }, { x: 0, y: 0, z: 1 })
    const world = projectLocalToWorld({ x: 2, y: 3 }, frame, 0.4)
    expect(world).toEqual({ x: 12, y: 23, z: 30.4 })
    expect(world === undefined ? undefined : projectWorldToLocal(world, frame)).toEqual({ x: 2, y: 3 })
    const hit = rayPlaneIntersection({ x: 12, y: 23, z: 35 }, { x: 0, y: 0, z: -1 }, frame)
    expect(hit?.distanceM).toBe(5)
    expect(hit?.localPoint).toEqual({ x: 2, y: 3 })
    const scaledHit = rayPlaneIntersection({ x: 12, y: 23, z: 35 }, { x: 0, y: 0, z: -2 }, frame)
    expect(scaledHit?.distanceM).toBe(5)
    expect(scaledHit?.worldPoint).toEqual({ x: 12, y: 23, z: 30 })
    expect(rayPlaneIntersection({ x: 0, y: 0, z: 5 }, { x: 1, y: 0, z: 0 }, frame)).toBeUndefined()
    expect(projectWorldToLocal({ x: 1, y: 2, z: 3 }, { ...frame, tangentY: { x: 0, y: 0, z: 0 } })).toBeUndefined()
  })

  it('fills thousands of panels within the placement performance budget', () => {
    const started = performance.now()
    const candidates = generateAutoFill(panel, request({ x: 0, y: 0, width: 100, height: 100 }, {
      settings: { ...settings, setbackM: 0.2, interPanelSpacingM: 0.05, rowSpacingM: 0.05 },
    }))
    const elapsedMs = performance.now() - started
    expect(candidates.length).toBeGreaterThan(100)
    expect(elapsedMs).toBeLessThan(2000)
    expect(candidates.every((candidate) => Number.isFinite(candidate.localCenter.x) && Number.isFinite(candidate.localCenter.y))).toBe(true)
  })
})
