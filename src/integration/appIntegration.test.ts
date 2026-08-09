import { describe, expect, it } from 'vitest'
import { createSurfaceDescriptor } from '../core'
import { PANEL_CATALOG } from '../data'
import { createPlacementStore } from '../placement'
import {
  buildViewerSourceFromFiles,
  CATALOG_PANEL_DEFINITIONS,
  createPanelVisuals,
  formatSurfaceLabel,
  placementValues,
  summarisePlacementState,
  toShellPanel,
  toShellSurface,
} from './appIntegration'

const surface = createSurfaceDescriptor({
  id: 'roof-east',
  frame: {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    tangentX: { x: 1, y: 0, z: 0 },
    tangentY: { x: 0, y: 1, z: 0 },
  },
  region: { x: 0, y: 0, width: 8, height: 4 },
  area: 32,
  azimuthDeg: 90,
  tiltDeg: 25,
  usableArea: 27,
  faceRefs: [{ meshId: 'roof', faceIndices: [0] }],
})

describe('app integration adapters', () => {
  it('builds an OBJ source from one model, optional MTL, and image textures', () => {
    const obj = new File(['obj'], 'site.obj', { type: 'text/plain' })
    const mtl = new File(['mtl'], 'site.mtl', { type: 'text/plain' })
    const texture = new File(['jpg'], 'roof.JPG', { type: 'image/jpeg' })
    const result = buildViewerSourceFromFiles([obj, mtl, texture])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toMatchObject({ obj, mtl, name: 'site.obj' })
    expect(result.source.textures).toEqual([texture])
  })

  it('rejects missing or ambiguous model/material files', () => {
    const mtl = new File(['mtl'], 'site.mtl', { type: 'text/plain' })
    const first = new File(['obj'], 'first.obj', { type: 'text/plain' })
    const second = new File(['obj'], 'second.obj', { type: 'text/plain' })
    expect(buildViewerSourceFromFiles([mtl]).ok).toBe(false)
    const duplicateObj = buildViewerSourceFromFiles([first, second])
    const duplicateMtl = buildViewerSourceFromFiles([first, mtl, new File(['mtl'], 'other.mtl')])
    expect(duplicateObj.ok).toBe(false)
    expect(duplicateMtl.ok).toBe(false)
    if (!duplicateObj.ok && !duplicateMtl.ok) {
      expect(duplicateObj.message).toMatch(/multiple OBJ/i)
      expect(duplicateMtl.message).toMatch(/multiple MTL/i)
    }
  })

  it('keeps catalogue visual metadata at the rendering boundary', () => {
    const first = PANEL_CATALOG[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    const visuals = createPanelVisuals([first])
    expect(visuals[first.id]).toEqual({ cellCount: first.cellCount, frameColor: 0x1e252b })
    expect(Object.isFrozen(visuals)).toBe(true)
    expect(Object.isFrozen(visuals[first.id])).toBe(true)
  })

  it('maps canonical surface and panel records to shell-safe summaries', () => {
    const panel = PANEL_CATALOG[0]
    expect(panel).toBeDefined()
    if (panel === undefined) return
    expect(toShellSurface(surface)).toEqual({
      id: surface.id,
      area: surface.area,
      usableArea: surface.usableArea,
      azimuthDeg: surface.azimuthDeg,
      tiltDeg: surface.tiltDeg,
      label: 'Roof face · East',
    })
    expect(toShellPanel(panel)).toMatchObject({
      id: panel.id,
      manufacturer: panel.manufacturer,
      model: panel.model,
      wattageW: (panel.wattage.min + panel.wattage.max) / 2,
    })
  })

  it('derives stable human-readable labels from surface geometry', () => {
    expect(formatSurfaceLabel({ tiltDeg: 0, azimuthDeg: Number.NaN })).toBe('Ground plane')
    expect(formatSurfaceLabel({ tiltDeg: 90, azimuthDeg: 180 })).toBe('Wall · South')
    expect(formatSurfaceLabel({ tiltDeg: 32, azimuthDeg: 315 })).toBe('Roof face · North-west')
  })

  it('reports placement count and total kWp from the placement store', () => {
    const panel = CATALOG_PANEL_DEFINITIONS[0]
    expect(panel).toBeDefined()
    if (panel === undefined) return
    const store = createPlacementStore({ panels: CATALOG_PANEL_DEFINITIONS, surfaces: [surface] })
    expect(store.beginManualPlacement({ panelId: panel.id, surfaceId: surface.id })).toBe(true)
    expect(store.commitManualPlacement({ x: 4, y: 2 })).toBeDefined()
    const summary = summarisePlacementState(store.getSnapshot(), store)
    expect(summary.count).toBe(1)
    expect(summary.selectedCount).toBe(1)
    expect(summary.totalWattageW).toBe(panel.wattageW)
    expect(summary.totalKwp).toBe(panel.wattageW / 1000)
    expect(placementValues(store.getSnapshot())).toHaveLength(1)
  })

  it('moves an existing placement without creating a new placement or history entry per pointer update', () => {
    const panel = CATALOG_PANEL_DEFINITIONS[0]
    expect(panel).toBeDefined()
    if (panel === undefined) return
    const store = createPlacementStore({ panels: CATALOG_PANEL_DEFINITIONS, surfaces: [surface] })
    expect(store.beginManualPlacement({ panelId: panel.id, surfaceId: surface.id })).toBe(true)
    const created = store.commitManualPlacement({ x: 4, y: 2 })
    expect(created).toBeDefined()
    if (created === undefined) return
    const originalId = created.id
    const originalCenter = created.localCenter
    const historyBeforeDrag = store.getSnapshot().undoDepth

    // App's transient pointer updates do not call the store.  The release
    // commits one group move, preserving the existing ID and count.
    expect(store.moveGroup([originalId], { x: 0.35, y: 0.2 })).toBe(true)
    const moved = placementValues(store.getSnapshot())
    expect(moved).toHaveLength(1)
    expect(moved[0]?.id).toBe(originalId)
    expect(moved[0]?.localCenter).toEqual({ x: originalCenter.x + 0.35, y: originalCenter.y + 0.2 })
    expect(store.getSnapshot().undoDepth).toBe(historyBeforeDrag + 1)

    expect(store.undo()).toBe(true)
    expect(placementValues(store.getSnapshot())[0]?.localCenter).toEqual(originalCenter)
  })
})
