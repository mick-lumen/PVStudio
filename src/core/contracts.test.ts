import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANEL_GROUP_SETTINGS,
  createAutoFillCandidate,
  createAutoFillPreview,
  createPanelDefinition,
  createPanelGroupSettings,
  createPanelPlacement,
  createSurfaceDescriptor,
  createSurfaceEdge,
  createSurfaceEdgeMetadata,
  isAutoFillPreview,
  isAutoFillCandidate,
  isPanelDefinition,
  isPanelGroupSettings,
  isPanelPlacement,
  isPoint2,
  isRect,
  isSurfaceNormal,
  isSurfaceSelection,
  isSurfaceDescriptor,
  isSurfaceEdge,
  isSurfaceEdgeMetadata,
  isSurfaceEdgeSide,
  isSurfaceEdgeType,
  SURFACE_EDGE_DIRECTION_EPSILON,
} from './index'
import type {
  AutoFillPreview,
  PanelDefinition,
  Point2,
  SurfaceDescriptor,
  SurfaceSelection,
} from './index'

const frame = {
  origin: { x: 10, y: 20, z: 30 },
  normal: { x: 0, y: 0, z: 1 },
  tangentX: { x: 1, y: 0, z: 0 },
  tangentY: { x: 0, y: 1, z: 0 },
} as const

const descriptor: SurfaceDescriptor = {
  id: 'roof-east',
  frame,
  region: { x: 0, y: 0, width: 8, height: 4 },
  area: 32,
  azimuthDeg: 90,
  tiltDeg: 25,
  usableArea: 27,
  faceRefs: [{ meshId: 'roof-mesh', faceIndices: [4, 5, 6] }],
}

const panel: PanelDefinition = {
  id: 'demo-panel',
  manufacturer: 'PV Studio',
  model: 'Demo 400',
  widthM: 1.1,
  heightM: 1.75,
  thicknessM: 0.035,
  wattageW: 400,
  weightKg: 20,
}

const preview: AutoFillPreview = {
  request: {
    panelId: panel.id,
    surfaceId: descriptor.id,
    region: descriptor.region,
    obstacles: [{ id: 'chimney', x: 2, y: 1, width: 1, height: 1 }],
    settings: DEFAULT_PANEL_GROUP_SETTINGS,
  },
  candidates: [{
    id: 'preview-1',
    localCenter: { x: 1, y: 1 },
    footprint: { widthM: panel.widthM, heightM: panel.heightM },
    orientation: 'portrait',
    clearanceM: 0.1,
    tiltDeg: 0,
  }],
  totalWattageW: panel.wattageW,
  totalKwp: 0.4,
}

describe('core contract guards', () => {
  it('accept finite points and reject non-finite or malformed values', () => {
    expect(isPoint2({ x: 1, y: -2 })).toBe(true)
    expect(isPoint2({ x: Number.NaN, y: 0 })).toBe(false)
    expect(isPoint2({ x: 1, y: 0, z: 2 })).toBe(true)
    expect(isSurfaceNormal({ x: 0, y: 0, z: 0 })).toBe(false)
    expect(isSurfaceNormal({ x: 0, y: 0, z: 1 })).toBe(true)
    expect(isRect({ x: 0, y: 0, width: 2, height: 1 })).toBe(true)
    expect(isRect({ x: 0, y: 0, width: 0, height: 1 })).toBe(false)
  })

  it('validates settings, panel definitions and selection DTOs without Three.js objects', () => {
    expect(isPanelGroupSettings(DEFAULT_PANEL_GROUP_SETTINGS)).toBe(true)
    expect(isPanelDefinition(panel)).toBe(true)
    expect(isPanelDefinition({ ...panel, widthM: Number.POSITIVE_INFINITY })).toBe(false)

    const selection: SurfaceSelection = {
      surface: descriptor,
      hitLocal: { x: 2.5, y: 1.25 },
      worldPoint: { x: 12.5, y: 21.25, z: 30 },
    }
    expect(isSurfaceSelection(selection)).toBe(true)
    expect(isSurfaceSelection({ ...selection, worldPoint: { x: 0, y: 0, z: Number.NaN } })).toBe(false)
  })

  it('validates typed edge metadata while retaining legacy omission semantics', () => {
    const gutter = {
      type: 'gutter' as const,
      direction: { x: 1, y: 0 },
      line: { origin: { x: 0, y: 0 }, direction: { x: 1, y: 0 } },
    }
    expect(isSurfaceEdgeType('ridge')).toBe(true)
    expect(isSurfaceEdgeType('eave')).toBe(false)
    expect(isSurfaceEdgeMetadata(gutter)).toBe(true)
    expect(isSurfaceEdgeMetadata({ ...gutter, direction: { x: 0, y: 0 } })).toBe(false)
    expect(isSurfaceEdgeSide('left')).toBe(true)
    expect(isSurfaceEdgeSide('right')).toBe(true)
    expect(isSurfaceEdgeSide('downhill')).toBe(false)
    expect(isSurfaceEdgeMetadata({ ...gutter, side: 'left' })).toBe(true)
    expect(isSurfaceEdgeMetadata({ type: 'gutter', direction: { x: 1, y: 0 }, side: 'left' })).toBe(false)
    expect(isSurfaceEdgeMetadata({ ...gutter, side: 'downhill' })).toBe(false)
    expect(isSurfaceEdgeMetadata({ ...gutter, direction: { x: SURFACE_EDGE_DIRECTION_EPSILON, y: 0 } })).toBe(false)
    expect(isSurfaceEdgeMetadata({ ...gutter, direction: { x: SURFACE_EDGE_DIRECTION_EPSILON * 2, y: 0 } })).toBe(true)
    expect(isSurfaceEdge({ surfaceId: 'roof-east', ...gutter })).toBe(true)
    expect(isSurfaceEdge({ surfaceId: '', ...gutter })).toBe(false)
    expect(isSurfaceDescriptor({ ...descriptor, edge: gutter })).toBe(true)
    expect(isSurfaceDescriptor({ ...descriptor, edge: { ...gutter, type: 'eave' } })).toBe(false)
  })
})

describe('immutable serialisable constructors', () => {
  it('deep freezes cloned nested DTOs and leaves source values untouched', () => {
    const source = structuredClone(preview)
    const frozen = createAutoFillPreview(source)

    expect(frozen).not.toBe(source)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.request)).toBe(true)
    expect(Object.isFrozen(frozen.request.obstacles)).toBe(true)
    expect(Object.isFrozen(frozen.candidates[0])).toBe(true)
    expect(Object.isFrozen(frozen.candidates[0]?.localCenter)).toBe(true)
    expect(JSON.parse(JSON.stringify(frozen))).toEqual(source)

    const frozenDescriptor = createSurfaceDescriptor(descriptor)
    expect(Object.isFrozen(frozenDescriptor.faceRefs[0])).toBe(true)
    expect(Object.isFrozen(frozenDescriptor.frame)).toBe(true)

    const polygonDescriptor = createSurfaceDescriptor({
      ...descriptor,
      region: {
        points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 4 }, { x: 0, y: 4 }],
        holes: [[{ x: 2, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2 }, { x: 2, y: 2 }]],
      },
    })
    expect('holes' in polygonDescriptor.region ? polygonDescriptor.region.holes : undefined).toEqual([
      [{ x: 2, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2 }, { x: 2, y: 2 }],
    ])

    const edge = createSurfaceEdgeMetadata({
      type: 'ridge',
      direction: { x: 0, y: 2 },
      line: { origin: { x: 0, y: 1 }, direction: { x: 1, y: 0 } },
    })
    expect(Object.isFrozen(edge)).toBe(true)
    expect(Object.isFrozen(edge.direction)).toBe(true)
    expect(edge.direction).toEqual({ x: 0, y: 2 })
    const keyedEdge = createSurfaceEdge({ surfaceId: ' roof-east ', ...edge })
    expect(keyedEdge.surfaceId).toBe('roof-east')
    expect(Object.isFrozen(keyedEdge.line)).toBe(true)

    expect(source.request.settings.clearanceM).toBe(0.1)
    expect(frozen.request.settings.clearanceM).toBe(0.1)
  })

  it('trims stable identifiers while retaining canonical metre and watt units', () => {
    const frozenPanel = createPanelDefinition({ ...panel, id: ' panel ', manufacturer: ' Maker ' })
    expect(frozenPanel.id).toBe('panel')
    expect(frozenPanel.manufacturer).toBe('Maker')
    expect(frozenPanel.widthM).toBe(1.1)
    expect(frozenPanel.wattageW).toBe(400)

    const placement = createPanelPlacement({
      id: ' p1 ',
      panelId: 'demo-panel',
      surfaceId: 'roof-east',
      localCenter: { x: 2, y: 3 },
      orientation: 'landscape',
      clearanceM: 0.1,
      tiltDeg: 5,
      groupId: ' g1 ',
    })
    expect(placement.id).toBe('p1')
    expect(placement.groupId).toBe('g1')
    expect(Object.isFrozen(placement.localCenter)).toBe(true)
  })

  it('rejects malformed DTOs at construction time', () => {
    expect(() => createPanelDefinition({ ...panel, thicknessM: 0 })).toThrow(TypeError)
    expect(() => createPanelPlacement({
      id: 'p1',
      panelId: 'demo-panel',
      surfaceId: 'roof-east',
      localCenter: { x: Number.NaN, y: 0 },
      orientation: 'portrait',
      clearanceM: 0,
      tiltDeg: 0,
    })).toThrow(TypeError)
    expect(isAutoFillPreview({ ...preview, totalKwp: Number.NaN })).toBe(false)
  })

  it('applies the canonical 0..90 degree tilt bound to every placement DTO', () => {
    expect(isPanelGroupSettings({ ...DEFAULT_PANEL_GROUP_SETTINGS, tiltDeg: 91 })).toBe(false)
    expect(isPanelGroupSettings({ ...DEFAULT_PANEL_GROUP_SETTINGS, tiltDeg: Number.NaN })).toBe(false)
    expect(() => createPanelGroupSettings({ ...DEFAULT_PANEL_GROUP_SETTINGS, tiltDeg: 91 })).toThrow(TypeError)

    const placement = {
      id: 'tilt-placement',
      panelId: panel.id,
      surfaceId: descriptor.id,
      localCenter: { x: 1, y: 1 },
      orientation: 'portrait' as const,
      clearanceM: 0,
      tiltDeg: 91,
    }
    expect(isPanelPlacement(placement)).toBe(false)
    expect(() => createPanelPlacement(placement)).toThrow(TypeError)

    const candidate = {
      id: 'tilt-candidate',
      localCenter: { x: 1, y: 1 },
      footprint: { widthM: panel.widthM, heightM: panel.heightM },
      orientation: 'portrait' as const,
      clearanceM: 0,
      tiltDeg: 91,
    }
    expect(isAutoFillCandidate(candidate)).toBe(false)
    expect(() => createAutoFillCandidate(candidate)).toThrow(TypeError)
  })

  it('keeps readonly point contracts assignable to serialisable values', () => {
    const point: Point2 = { x: 1, y: 2 }
    expect(JSON.stringify(point)).toBe('{"x":1,"y":2}')
  })
})
