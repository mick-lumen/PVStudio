import { describe, expect, it } from 'vitest'
import type {
  AutoFillRequest,
  PanelDefinition,
  PanelGroupSettings,
  SurfaceDescriptor,
} from '../core'
import {
  deriveSurfaceEdgeAxes,
  generateAutoFill,
  orientedCandidateInsideRegion,
  orientedObstacleOverlap,
  rectangleInsideSurfaceRegion,
} from './geometry'
import { createPlacementStore } from './state'

const panel: PanelDefinition = {
  id: 'commercial-panel',
  manufacturer: 'PV Studio',
  model: 'Commercial 400',
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

const surface: SurfaceDescriptor = {
  id: 'roof',
  frame: {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    tangentX: { x: 1, y: 0, z: 0 },
    tangentY: { x: 0, y: 1, z: 0 },
  },
  region: { x: 0, y: 0, width: 5, height: 7 },
  area: 35,
  azimuthDeg: 180,
  tiltDeg: 20,
  usableArea: 35,
  faceRefs: [],
}

const request = (overrides: Partial<AutoFillRequest> = {}): AutoFillRequest => ({
  panelId: panel.id,
  surfaceId: surface.id,
  region: surface.region,
  obstacles: [],
  settings,
  ...overrides,
})

describe('commercial auto-fill geometry controls', () => {
  it('caps each generated row without changing the distinct X/Y gap axes', () => {
    const candidates = generateAutoFill(panel, request({
      settings: { ...settings, modulesPerRow: 2 },
    }))
    const rows = new Map<number, number>()
    for (const candidate of candidates) rows.set(candidate.localCenter.y, (rows.get(candidate.localCenter.y) ?? 0) + 1)
    expect(candidates.length).toBeGreaterThan(0)
    expect([...rows.values()].every((count) => count <= 2)).toBe(true)
    expect(rows.size).toBeGreaterThan(1)
  })

  it('alternates a physical row-axis offset and clips oversized values at the edge', () => {
    const staggered = generateAutoFill(panel, request({
      settings: { ...settings, modulesPerRow: 2, rowOffsetM: 0.4 },
    }))
    const rowValues = [...new Set(staggered.map((candidate) => candidate.localCenter.y))]
    expect(rowValues.length).toBeGreaterThanOrEqual(3)
    const firstRow = staggered.filter((candidate) => candidate.localCenter.y === rowValues[0])
    const secondRow = staggered.filter((candidate) => candidate.localCenter.y === rowValues[1])
    expect(firstRow[0]?.localCenter.x).toBeCloseTo(0.7)
    expect(secondRow[0]?.localCenter.x).toBeCloseTo(1.1)

    const clipped = generateAutoFill(panel, request({
      settings: { ...settings, modulesPerRow: 2, rowOffsetM: 100 },
    }))
    expect(clipped.every((candidate) => candidate.localCenter.x <= 4.3 + 1e-9)).toBe(true)
    expect(clipped.every((candidate) => rectangleInsideSurfaceRegion({
      x: candidate.localCenter.x - candidate.footprint.widthM / 2,
      y: candidate.localCenter.y - candidate.footprint.heightM / 2,
      width: candidate.footprint.widthM,
      height: candidate.footprint.heightM,
    }, surface.region, settings.setbackM))).toBe(true)
  })

  it('rotates stagger with a reversed edge-aware row axis', () => {
    const forward = generateAutoFill(panel, request({
      edge: { type: 'gutter', direction: { x: 1, y: 0 } },
      settings: { ...settings, modulesPerRow: 2, rowOffsetM: 0.4 },
    }))
    const reverse = generateAutoFill(panel, request({
      edge: { type: 'gutter', direction: { x: -1, y: 0 } },
      settings: { ...settings, modulesPerRow: 2, rowOffsetM: 0.4 },
    }))
    expect(forward.length).toBe(reverse.length)
    expect(forward[0]?.localCenter).toEqual({ x: 0.7, y: 1.2 })
    // Reversing an edge changes row order while the canonical downhill side
    // (cross axis) remains stable.
    expect(reverse[0]?.localCenter).toEqual({ x: 4.3, y: 1.2 })
    expect(forward[2]?.localCenter.x).toBeCloseTo(1.1)
    expect(reverse[2]?.localCenter.x).toBeCloseTo(3.9)
  })

  it('expands obstacles without changing the edge setback', () => {
    const obstacle = { id: 'vent', x: 1.25, y: 1.1, width: 0.1, height: 0.1 }
    const withoutMargin = generateAutoFill(panel, request({ obstacles: [obstacle] }))
    const withMargin = generateAutoFill(panel, request({
      obstacles: [obstacle],
      settings: { ...settings, obstacleClearanceM: 0.1 },
    }))
    expect(withoutMargin.some((candidate) => candidate.localCenter.x === 0.7 && candidate.localCenter.y === 1.2)).toBe(true)
    expect(withMargin.some((candidate) => candidate.localCenter.x === 0.7 && candidate.localCenter.y === 1.2)).toBe(false)
    expect(withMargin.every((candidate) => rectangleInsideSurfaceRegion({
      x: candidate.localCenter.x - candidate.footprint.widthM / 2,
      y: candidate.localCenter.y - candidate.footprint.heightM / 2,
      width: candidate.footprint.widthM,
      height: candidate.footprint.heightM,
    }, surface.region, settings.setbackM))).toBe(true)
  })

  it('keeps preview and confirmation deterministic with commercial options', () => {
    const store = createPlacementStore({ panels: [panel], surfaces: [surface] })
    const input = {
      panelId: panel.id,
      surfaceId: surface.id,
      settings: { ...settings, modulesPerRow: 2, rowOffsetM: 0.4, obstacleClearanceM: 0.05 },
    }
    const first = store.previewAutoFill(input)
    const second = store.previewAutoFill(input)
    expect(first).toBeDefined()
    expect(second).toEqual(first)
    const confirmed = store.confirmAutoFill()
    expect(confirmed.map((placement) => placement.localCenter)).toEqual(first?.candidates.map((candidate) => candidate.localCenter))
    expect(store.confirmAutoFill()).toEqual([])
  })

  it('confirms a reversed edge-axis stagger with the same preview ordering', () => {
    const store = createPlacementStore({
      panels: [panel],
      surfaces: [surface],
      gutters: [{ surfaceId: surface.id, direction: { x: -1, y: 0 } }],
    })
    const input = {
      panelId: panel.id,
      surfaceId: surface.id,
      settings: { ...settings, modulesPerRow: 2, rowOffsetM: 0.4 },
    }
    const preview = store.previewAutoFill(input)
    expect(preview?.candidates.length).toBeGreaterThan(0)
    const confirmed = store.confirmAutoFill()
    expect(confirmed.map((placement) => placement.localCenter)).toEqual(preview?.candidates.map((candidate) => candidate.localCenter))
  })

  it('keeps a rotated-edge polygon preview and confirmation in lockstep', () => {
    const polygonSurface: SurfaceDescriptor = {
      ...surface,
      id: 'polygon-roof',
      region: { points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }] },
      area: 64,
      usableArea: 64,
    }
    const edge = { type: 'gutter' as const, direction: { x: 1, y: 1 } }
    const obstacle = { id: 'skylight', x: 5.85, y: 1.55, width: 0.1, height: 0.1 }
    const rotatedSettings: PanelGroupSettings = {
      ...settings,
      modulesPerRow: 4,
      rowOffsetM: 0.4,
      setbackM: 0.25,
      obstacleClearanceM: 0.2,
    }
    const input = {
      panelId: panel.id,
      surfaceId: polygonSurface.id,
      region: polygonSurface.region,
      edge,
      obstacles: [obstacle],
      settings: rotatedSettings,
    }
    const generatedWithoutMargin = generateAutoFill(panel, {
      ...input,
      settings: { ...rotatedSettings, obstacleClearanceM: 0 },
    })
    const store = createPlacementStore({ panels: [panel], surfaces: [polygonSurface] })
    const preview = store.previewAutoFill(input)
    expect(preview).toBeDefined()
    expect(preview?.candidates.length).toBeGreaterThan(0)
    expect(preview?.candidates.length).toBeLessThan(generatedWithoutMargin.length)

    const axes = deriveSurfaceEdgeAxes(edge, polygonSurface.region)
    const clearanceM = rotatedSettings.obstacleClearanceM ?? 0
    for (const candidate of preview?.candidates ?? []) {
      expect(orientedCandidateInsideRegion(
        candidate.localCenter,
        candidate.footprint.widthM,
        candidate.footprint.heightM,
        polygonSurface.region,
        axes,
        rotatedSettings.setbackM,
      )).toBe(true)
      expect(orientedObstacleOverlap(
        candidate.localCenter,
        candidate.footprint.widthM,
        candidate.footprint.heightM,
        { x: obstacle.x - clearanceM, y: obstacle.y - clearanceM, width: obstacle.width + 2 * clearanceM, height: obstacle.height + 2 * clearanceM },
        axes,
      )).toBe(false)
    }

    const confirmed = store.confirmAutoFill()
    expect(confirmed).toHaveLength(preview?.candidates.length ?? -1)
    expect(confirmed.map((placement) => placement.localCenter)).toEqual(preview?.candidates.map((candidate) => candidate.localCenter))
  })

  it('keeps confirm validation inside a strict request subregion', () => {
    const requestRegion = { x: 1, y: 0.5, width: 3, height: 5.5 }
    const edge = {
      type: 'ridge' as const,
      direction: { x: 1, y: 0.35 },
      line: { origin: { x: 0, y: 3.3 }, direction: { x: 1, y: 0 } },
    }
    const strictRequest = {
      panelId: panel.id,
      surfaceId: surface.id,
      region: requestRegion,
      edge,
      obstacles: [],
      settings: { ...settings, modulesPerRow: 3, rowOffsetM: 0.3 },
    }
    const store = createPlacementStore({ panels: [panel], surfaces: [surface] })
    const preview = store.previewAutoFill(strictRequest)
    expect(preview).toBeDefined()
    expect(preview?.candidates.length).toBeGreaterThan(0)
    const requestAxes = deriveSurfaceEdgeAxes(edge, requestRegion)
    for (const candidate of preview?.candidates ?? []) {
      expect(orientedCandidateInsideRegion(
        candidate.localCenter,
        candidate.footprint.widthM,
        candidate.footprint.heightM,
        requestRegion,
        requestAxes,
        strictRequest.settings.setbackM,
      )).toBe(true)
    }
    const confirmed = store.confirmAutoFill()
    expect(confirmed.map((placement) => placement.localCenter)).toEqual(preview?.candidates.map((candidate) => candidate.localCenter))
    expect(confirmed.every((placement) => {
      const footprint = panel
      return orientedCandidateInsideRegion(
        placement.localCenter,
        footprint.widthM,
        footprint.heightM,
        requestRegion,
        requestAxes,
        strictRequest.settings.setbackM,
      )
    })).toBe(true)
  })
})
