import { describe, expect, it } from 'vitest'
import type {
  PanelDefinition,
  PanelGroupSettings,
  RectangularObstacle,
  SurfaceDescriptor,
} from '../core'
import {
  createPlacementStore,
  dispatchPlacementAction,
  initialPlacementState,
  placementReducer,
} from './state'
import type { PlacementContext } from './state'

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

const surface: SurfaceDescriptor = {
  id: 'roof',
  frame: {
    origin: { x: 10, y: 20, z: 30 },
    normal: { x: 0, y: 0, z: 1 },
    tangentX: { x: 1, y: 0, z: 0 },
    tangentY: { x: 0, y: 1, z: 0 },
  },
  region: { x: 0, y: 0, width: 10, height: 5 },
  area: 50,
  azimuthDeg: 180,
  tiltDeg: 20,
  usableArea: 45,
  faceRefs: [],
}

const secondSurface: SurfaceDescriptor = {
  ...surface,
  id: 'garage',
  frame: { ...surface.frame, origin: { x: 0, y: 0, z: 2 } },
}

const makeStore = () => createPlacementStore({ panels: [panel], surfaces: [surface, secondSurface], settings })

const isPanelList = (value: PlacementContext['panels']): value is readonly PanelDefinition[] =>
  Array.isArray(value)

const isSurfaceList = (value: PlacementContext['surfaces']): value is readonly SurfaceDescriptor[] =>
  Array.isArray(value)

describe('PlacementStore manual placement and selection', () => {
  it('runs begin/update/commit and cancel transactions while rejecting invalid points', () => {
    const store = makeStore()
    expect(store.setActiveSurface('roof')).toBe(true)
    expect(store.beginManualPlacement({ panelId: panel.id })).toBe(true)
    expect(store.updateManualPlacement({ x: 2, y: 2 })).toBe(true)
    const placement = store.commitManualPlacement()
    expect(placement?.localCenter).toEqual({ x: 2, y: 2 })
    expect(store.getState().manualPlacement).toBeUndefined()
    expect(store.beginManualPlacement({ panelId: panel.id })).toBe(true)
    expect(store.updateManualPlacement({ x: Number.NaN, y: 0 })).toBe(false)
    expect(store.cancelManualPlacement()).toBe(true)
    expect(store.commitManualPlacement()).toBeUndefined()
    expect(store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: Number.POSITIVE_INFINITY, y: 0 } })).toBeUndefined()
  })

  it('adds, moves and deletes panels atomically with boundary and collision checks', () => {
    const store = makeStore()
    const first = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 }, id: 'first' })
    const second = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 5, y: 2 }, id: 'second' })
    expect(first?.id).toBe('first')
    expect(second?.id).toBe('second')
    expect(store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 0.4, y: 1.2 } })).toBeUndefined()
    expect(store.movePanel('second', { x: 2, y: 2 })).toBe(false)
    expect(store.getState().placements.second?.localCenter).toEqual({ x: 5, y: 2 })
    expect(store.movePanel('second', { x: 6, y: 2 })).toBe(true)
    expect(store.deletePanel('first')).toBe(true)
    expect(store.deletePanel('missing')).toBe(false)
    expect(Object.keys(store.getState().placements)).toEqual(['second'])
  })

  it('supports click, additive/toggle and surface-scoped box selection', () => {
    const store = makeStore()
    const first = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 } })
    const second = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 5, y: 2 } })
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(store.clickSelect(first?.id ?? '')).toEqual([first?.id])
    expect(store.clickSelect(second?.id ?? '', true)).toEqual([first?.id, second?.id])
    expect(store.clickSelect(second?.id ?? '', true, true)).toEqual([first?.id])
    expect(store.selectByBox({ x: 1.4, y: 0.8, width: 1.2, height: 2.4 }, 'roof')).toEqual([first?.id])
    expect(store.selectByBox({ x: 1.4, y: 0.8, width: 1.2, height: 2.4 }, 'garage')).toEqual([])
  })

  it('moves a selected group without allowing collisions or non-finite deltas', () => {
    const store = makeStore()
    const first = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 } })
    const second = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 5, y: 2 } })
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    store.selectPanels([first?.id ?? '', second?.id ?? ''])
    expect(store.moveSelected({ x: 0.5, y: 0 })).toBe(true)
    expect(store.getState().placements[first?.id ?? '']?.localCenter.x).toBe(2.5)
    expect(store.moveGroup([first?.id ?? ''], { x: 0.5, y: 0 })).toBe(true)
    expect(store.moveGroup({ x: Number.NaN, y: 0 })).toBe(false)
    expect(store.moveGroup({ x: 20, y: 0 })).toBe(false)
  })

  it('rejects unknown surfaces in every surface-targeted workflow', () => {
    const store = makeStore()
    expect(store.setActiveSurface('missing')).toBe(false)
    expect(store.setActiveSurfaces(['roof', 'missing'])).toBe(false)
    expect(store.addPanel({ panelId: panel.id, surfaceId: 'missing', localCenter: { x: 2, y: 2 } })).toBeUndefined()
    expect(store.beginManualPlacement({ panelId: panel.id, surfaceId: 'missing' })).toBe(false)
    expect(store.beginArrayDrag(panel.id, 'missing', { x: 1, y: 1 })).toBe(false)
    expect(store.previewAutoFill({ panelId: panel.id, surfaceId: 'missing' })).toBeUndefined()
    expect(store.selectByBox({ x: 0, y: 0, width: 2, height: 2 }, 'missing')).toEqual([])

    store.setActiveSurface('roof')
    expect(store.beginManualPlacement({ panelId: panel.id })).toBe(true)
    expect(store.updateManualPlacement({ x: 2, y: 2 }, 'missing')).toBe(false)
    expect(store.cancelManualPlacement()).toBe(true)
    expect(store.getState().placements).toEqual({})
  })

  it('updates obstacle validation without history loss and rejects malformed or unknown sources', () => {
    const store = makeStore()
    const existing = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 }, id: 'existing' })
    expect(existing).toBeDefined()
    const before = store.getSnapshot()
    const undoDepth = store.getState().undoDepth
    let notifications = 0
    store.subscribe(() => { notifications += 1 })

    const source: Readonly<Record<string, readonly RectangularObstacle[]>> = {
      roof: [{ id: 'roof-block', x: 0, y: 0, width: 10, height: 5 }],
    }
    expect(store.setObstacles(source)).toBe(true)
    expect(store.getState().undoDepth).toBe(undoDepth)
    expect(store.getSnapshot()).not.toBe(before)
    const stored = store.context.obstacles as Readonly<Record<string, readonly RectangularObstacle[]>>
    expect(stored.roof?.[0]).toEqual(source.roof?.[0])
    expect(Object.isFrozen(stored.roof)).toBe(true)
    expect(Object.isFrozen(stored.roof?.[0])).toBe(true)
    expect(notifications).toBe(1)

    const preview = store.previewAutoFill({ panelId: panel.id, surfaceId: 'roof', region: surface.region, settings })
    expect(preview?.candidates).toEqual([])
    expect(store.movePanel(existing?.id ?? '', { x: 5, y: 2 })).toBe(false)
    expect(store.getState().placements.existing?.localCenter).toEqual({ x: 2, y: 2 })
    const stableSnapshot = store.getSnapshot()

    const equivalent = { roof: [{ id: 'roof-block', x: 0, y: 0, width: 10, height: 5 }] }
    expect(store.setObstacles(equivalent)).toBe(false)
    expect(store.getSnapshot()).toBe(stableSnapshot)
    expect(notifications).toBe(2)
    expect(store.setObstacles({ missing: [] })).toBe(false)
    expect(store.setObstacles({ roof: [{ id: 'bad', x: 0, y: 0, width: 0, height: 1 }] })).toBe(false)
    expect(notifications).toBe(2)
    expect(store.undo()).toBe(true)
    expect(store.getState().placements).toEqual({})
    expect(store.context.obstacles as unknown).toEqual(stored)
  })

  it('uses the current obstacle context for manual, move/group, array, orientation and alignment collision checks', () => {
    const obstacle: RectangularObstacle = { id: 'block', x: 0, y: 0, width: 10, height: 5 }

    const manual = makeStore()
    manual.setActiveSurface('roof')
    expect(manual.setObstacles({ roof: [obstacle] })).toBe(true)
    expect(manual.beginManualPlacement({ panelId: panel.id })).toBe(true)
    expect(manual.updateManualPlacement({ x: 5, y: 2 })).toBe(true)
    expect(manual.commitManualPlacement()).toBeUndefined()
    expect(manual.getState().placements).toEqual({})

    const moved = makeStore()
    const movedFirst = moved.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 }, id: 'moved-first' })
    const movedSecond = moved.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 5, y: 2 }, id: 'moved-second' })
    expect(movedFirst).toBeDefined()
    expect(movedSecond).toBeDefined()
    expect(moved.setObstacles({ roof: [obstacle] })).toBe(true)
    moved.selectPanels([movedFirst?.id ?? '', movedSecond?.id ?? ''])
    expect(moved.moveGroup({ x: 0.5, y: 0 })).toBe(false)
    expect(moved.setOrientation('landscape', [movedFirst?.id ?? ''])).toBe(false)

    const array = makeStore()
    array.setActiveSurface('roof')
    expect(array.setObstacles({ roof: [obstacle] })).toBe(true)
    expect(array.beginArrayDrag(panel.id, 'roof', { x: 0, y: 0 })).toBe(true)
    expect(array.updateArrayDrag({ x: 10, y: 5 })).toBe(true)
    expect(array.commitArrayDrag()).toEqual([])
    expect(array.getState().placements).toEqual({})

    const aligned = makeStore()
    const anchor = aligned.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 }, id: 'anchor' })
    const other = aligned.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 5, y: 2 }, id: 'other' })
    expect(anchor).toBeDefined()
    expect(other).toBeDefined()
    expect(aligned.setObstacles({ roof: [{ id: 'alignment-block', x: 2.8, y: 1, width: 1, height: 2 }] })).toBe(true)
    aligned.selectPanels([anchor?.id ?? '', other?.id ?? ''])
    expect(aligned.setAlignMode(true, anchor?.id)).toBe(true)
    expect(aligned.previewAlign()?.invalidIds).toContain(other?.id)
    expect(aligned.confirmAlign()).toBe(false)
    expect(aligned.getState().placements.other?.localCenter).toEqual({ x: 5, y: 2 })
  })

  it('treats malformed runtime entrypoint values as safe no-ops', () => {
    const store = createPlacementStore(null)
    expect(() => {
      store.addPanel(null)
      store.beginManualPlacement(null)
      store.updateManualPlacement({ x: Number.NaN, y: 0 }, null)
      store.commitManualPlacement({ x: Number.POSITIVE_INFINITY, y: 0 })
      store.movePanel(null, { x: 0, y: 0 })
      store.deletePanels(null)
      store.deletePanel(null)
      store.clickSelect(null as unknown as string)
      store.selectPanels(null)
      store.selectByBox(null, null)
      store.setOrientation(null, null)
      store.setSettings(null)
      store.setGroupSettings(null, null)
      store.setActiveSurface(null)
      store.setActiveSurfaces(null)
      store.toggleSurfaceSelection(null)
      store.beginArrayDrag(null, null, { x: Number.NaN, y: 0 })
      store.updateArrayDrag({ x: Number.POSITIVE_INFINITY, y: 0 })
      store.commitArrayDrag({ x: Number.NaN, y: 0 })
      store.setAlignMode(null)
      store.previewAlign(null)
      store.alignSelected(null)
      store.previewAutoFill(null)
      store.confirmAutoFill()
      store.cancelAutoFill()
      store.totals(null)
      store.placementTransform(null)
      store.gutterFacing(null)
      dispatchPlacementAction(store, null)
    }).not.toThrow()
    expect(store.getState().placements).toEqual({})
    expect(store.totals(null)).toEqual({ count: 0, wattageW: 0, kwp: 0 })
  })

  it('enforces the complete manual inter-panel gap and accepts an exact gap', () => {
    const store = createPlacementStore({
      panels: [panel],
      surfaces: [surface],
      settings: { ...settings, interPanelSpacingM: 0.5, rowSpacingM: 0.5 },
    })
    const first = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 } })
    expect(first).toBeDefined()
    expect(store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 3.4, y: 2 } })).toBeUndefined()
    expect(store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 3.5, y: 2 } })).toBeDefined()
  })
})

describe('PlacementStore settings, surfaces, arrays and alignment', () => {
  it('keeps portrait/landscape settings and rejects invalid settings', () => {
    const store = makeStore()
    expect(store.setSettings({ orientation: 'landscape', tiltDeg: 25 })).toBe(true)
    expect(store.getState().settings.orientation).toBe('landscape')
    expect(store.setSettings({ clearanceM: Number.NaN })).toBe(false)
    expect(store.getState().settings.clearanceM).toBe(0.1)
    expect(store.setActiveSurfaces(['roof', 'garage'])).toBe(true)
    expect(store.getState().activeSurfaceId).toBe('roof')
    expect(store.toggleSurfaceSelection('garage')).toBe(true)
    expect(store.getState().activeSurfaceIds).toEqual(['roof'])
    expect(store.setActiveSurface(undefined)).toBe(true)
    expect(store.getState().activeSurfaceIds).toEqual([])
  })

  it('creates a unique panel array from drag bounds and clears the draft', () => {
    const store = makeStore()
    store.setActiveSurface('roof')
    expect(store.beginArrayDrag(panel.id, undefined, { x: 1, y: 1 })).toBe(true)
    expect(store.updateArrayDrag({ x: 6, y: 4 })).toBe(true)
    const created = store.commitArrayDrag()
    expect(created.length).toBe(4)
    expect(new Set(created.map((placement) => placement.id)).size).toBe(created.length)
    expect(store.getState().arrayDrag).toBeUndefined()
    expect(store.commitArrayDrag()).toEqual([])
  })

  it('aligns selected panels from an anchor and honours alignment mode', () => {
    const store = makeStore()
    const anchor = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 } })
    const other = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 5, y: 2 } })
    const third = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 8, y: 2 } })
    expect(anchor).toBeDefined()
    expect(other).toBeDefined()
    expect(third).toBeDefined()
    store.selectPanels([anchor?.id ?? '', other?.id ?? '', third?.id ?? ''])
    expect(store.alignSelected()).toBe(false)
    expect(store.setAlignMode(true, anchor?.id)).toBe(true)
    expect(store.alignSelected()).toBe(true)
    expect(store.getState().placements[other?.id ?? '']?.localCenter).toEqual({ x: 3.1, y: 2 })
    expect(store.getState().placements[third?.id ?? '']?.localCenter).toEqual({ x: 4.2, y: 2 })
  })
})

describe('PlacementStore auto-fill, history and selectors', () => {
  it('previews and confirms obstacle-aware candidates without existing collisions', () => {
    const store = makeStore()
    const existing = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 0.7, y: 1.2 } })
    expect(existing).toBeDefined()
    const preview = store.previewAutoFill({
      panelId: panel.id,
      surfaceId: 'roof',
      region: { x: 0, y: 0, width: 5, height: 5 },
      obstacles: [{ id: 'chimney', x: 1.8, y: 1.1, width: 1, height: 2 }],
      settings,
      groupId: 'group-a',
    })
    expect(preview).toBeDefined()
    expect(preview?.candidates.some((candidate) => candidate.localCenter.x === 0.7 && candidate.localCenter.y === 1.2)).toBe(false)
    expect(preview?.candidates.every((candidate) => candidate.groupId === 'group-a')).toBe(true)
    const confirmed = store.confirmAutoFill()
    expect(confirmed.length).toBeGreaterThan(0)
    expect(new Set(confirmed.map((placement) => placement.id)).size).toBe(confirmed.length)
    expect(store.getState().autoFillPreview).toBeUndefined()
    expect(store.previewAutoFill({ panelId: panel.id, surfaceId: 'roof' })).toBeDefined()
    expect(store.cancelAutoFill()).toBe(true)
    expect(store.getState().autoFillPreview).toBeUndefined()
  })

  it('confirms more than 400 auto-fill candidates within the interaction budget', () => {
    const store = createPlacementStore({
      panels: [panel],
      surfaces: [{ ...surface, region: { x: 0, y: 0, width: 30, height: 30 }, area: 900, usableArea: 900 }],
      settings: { ...settings, interPanelSpacingM: 0.02, rowSpacingM: 0.02, setbackM: 0.2 },
    })
    const preview = store.previewAutoFill({
      panelId: panel.id,
      surfaceId: surface.id,
      region: { x: 0, y: 0, width: 30, height: 30 },
      obstacles: [],
      settings: { ...settings, interPanelSpacingM: 0.02, rowSpacingM: 0.02, setbackM: 0.2 },
    })
    expect(preview?.candidates.length).toBe(406)
    const started = performance.now()
    const confirmed = store.confirmAutoFill()
    const elapsedMs = performance.now() - started
    expect(confirmed.length).toBe(406)
    expect(elapsedMs).toBeLessThan(2000)
  })

  it('keeps indexed confirmation equivalent with mixed groups and surfaces', () => {
    const widePanel: PanelDefinition = { ...panel, id: 'panel-wide', widthM: 2, heightM: 1 }
    // Zero requested spacing intentionally leaves adjacent preview candidates
    // touching; confirmation must reject those pairs exactly like addPanel.
    const fillSettings: PanelGroupSettings = { ...settings, interPanelSpacingM: 0, rowSpacingM: 0 }
    const blockerSettings: PanelGroupSettings = { ...fillSettings, interPanelSpacingM: 0.9, rowSpacingM: 0.9 }
    const obstacles: readonly RectangularObstacle[] = [{ id: 'roof-window', x: 7, y: 2.4, width: 1, height: 1.2 }]
    const context = {
      panels: [panel, widePanel],
      surfaces: [
        { ...surface, region: { x: 0, y: 0, width: 12, height: 8 }, area: 96, usableArea: 96 },
        { ...secondSurface, region: { x: 0, y: 0, width: 12, height: 8 }, area: 96, usableArea: 96 },
      ],
      settings: fillSettings,
      groupSettings: { array: fillSettings, 'wide-clearance': blockerSettings },
      obstacles,
    }
    const indexedStore = createPlacementStore(context)
    const baselineStore = createPlacementStore(context)
    for (const store of [indexedStore, baselineStore]) {
      expect(store.addPanel({ panelId: widePanel.id, surfaceId: 'roof', localCenter: { x: 3, y: 3 }, groupId: 'wide-clearance', id: 'roof-blocker' })).toBeDefined()
      expect(store.addPanel({ panelId: panel.id, surfaceId: 'garage', localCenter: { x: 3, y: 3 }, id: 'garage-anchor' })).toBeDefined()
    }
    const request = {
      panelId: panel.id,
      surfaceId: 'roof',
      region: { x: 0, y: 0, width: 12, height: 8 },
      obstacles,
      settings: fillSettings,
      groupId: 'array',
    }
    const preview = indexedStore.previewAutoFill(request)
    expect(preview).toBeDefined()
    expect(preview?.candidates.length).toBeGreaterThan(10)
    const expected = []
    for (const candidate of preview?.candidates ?? []) {
      const placement = baselineStore.addPanel({
        panelId: request.panelId,
        surfaceId: request.surfaceId,
        localCenter: candidate.localCenter,
        orientation: candidate.orientation,
        clearanceM: candidate.clearanceM,
        tiltDeg: candidate.tiltDeg,
        groupId: candidate.groupId,
      })
      if (placement !== undefined) expected.push(placement)
    }
    const confirmed = indexedStore.confirmAutoFill()
    expect(confirmed).toEqual(expected)
    expect(confirmed.length).toBeLessThan(preview?.candidates.length ?? 0)
    expect(indexedStore.getState().placements['garage-anchor']).toBeDefined()
  })

  it('supports undo/redo and a reducer facade with canonical actions', () => {
    const store = makeStore()
    store.setActiveSurface('roof')
    const created = store.addPanel({ panelId: panel.id, localCenter: { x: 2, y: 2 } })
    expect(created).toBeDefined()
    expect(store.undo()).toBe(true)
    expect(store.getState().placements).toEqual({})
    expect(store.redo()).toBe(true)
    expect(store.getState().placements[created?.id ?? '']).toBeDefined()
    expect(dispatchPlacementAction(store, { type: 'set-settings', settings: { orientation: 'landscape' } })).toBe(true)
    expect(store.getState().settings.orientation).toBe('landscape')

    const state = initialPlacementState({ panels: [panel], surfaces: [surface] })
    const selected = placementReducer(state, { type: 'set-active-surface', surfaceId: 'roof' }, { panels: [panel], surfaces: [surface] })
    expect(selected.activeSurfaceId).toBe('roof')
  })

  it('reports totals, transforms and gutter-facing orientation metadata', () => {
    const store = makeStore()
    store.setActiveSurface('roof')
    const placement = store.addPanel({ panelId: panel.id, localCenter: { x: 2, y: 2 } })
    expect(placement).toBeDefined()
    expect(store.totals()).toEqual({ count: 1, wattageW: 400, kwp: 0.4 })
    const transform = store.placementTransform(placement?.id ?? '')
    expect(transform?.worldCenter).toEqual({ x: 12, y: 22, z: 30.1 })
    expect(transform?.gutterDirection).toEqual({ x: 1, y: 0 })
    expect(store.gutterFacing('roof', 'landscape')).toEqual({ surfaceId: 'roof', direction: { x: 1, y: 0 }, orientation: 'landscape', azimuthDeg: 180 })
    expect(store.gutterFacing('unknown')).toBeUndefined()
  })

  it('keeps group settings persistent, isolated and undoable', () => {
    const store = makeStore()
    expect(store.setGroupSettings('array-a', { interPanelSpacingM: 0.45, setbackM: 0.3 })).toBe(true)
    expect(store.getGroupSettings('array-a')).toMatchObject({ interPanelSpacingM: 0.45, setbackM: 0.3 })
    expect(store.getState().groupSettings['array-a']?.interPanelSpacingM).toBe(0.45)
    expect(store.undo()).toBe(true)
    expect(store.getState().groupSettings['array-a']).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.getGroupSettings('array-a').setbackM).toBe(0.3)
    const exposed = store.getGroupSettings('array-a') as unknown as { interPanelSpacingM: number }
    expect(() => { exposed.interPanelSpacingM = 0 }).toThrow()
    expect(store.getGroupSettings('array-a').interPanelSpacingM).toBe(0.45)
  })

  it('does not record transient interaction state in undo history', () => {
    const store = makeStore()
    store.setActiveSurface('roof')
    const initialDepth = store.getState().undoDepth
    expect(store.beginManualPlacement({ panelId: panel.id })).toBe(true)
    expect(store.updateManualPlacement({ x: 2, y: 2 })).toBe(true)
    expect(store.cancelManualPlacement()).toBe(true)
    expect(store.beginArrayDrag(panel.id, 'roof', { x: 1, y: 1 })).toBe(true)
    expect(store.updateArrayDrag({ x: 3, y: 3 })).toBe(true)
    expect(store.cancelArrayDrag()).toBe(true)
    expect(store.selectByBox({ x: 0, y: 0, width: 4, height: 4 }, 'roof')).toEqual([])
    expect(store.previewAutoFill({ panelId: panel.id, surfaceId: 'roof' })).toBeDefined()
    expect(store.cancelAutoFill()).toBe(true)
    expect(store.setAlignMode(true)).toBe(true)
    expect(store.cancelAlign()).toBe(false)
    expect(store.getState().undoDepth).toBe(initialDepth)

    const created = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 } })
    expect(created).toBeDefined()
    const committedDepth = store.getState().undoDepth
    expect(store.selectPanels([created?.id ?? ''])).toEqual([created?.id])
    expect(store.previewAutoFill({ panelId: panel.id, surfaceId: 'roof' })).toBeDefined()
    expect(store.cancelAutoFill()).toBe(true)
    expect(store.getState().undoDepth).toBe(committedDepth)
    expect(store.undo()).toBe(true)
    expect(store.getState().placements).toEqual({})
  })

  it('aligns mixed footprints when valid and reports invalid obstacle previews without mutation', () => {
    const widePanel: PanelDefinition = { ...panel, id: 'panel-wide', widthM: 2, heightM: 1 }
    const validStore = createPlacementStore({
      panels: [panel, widePanel],
      surfaces: [{ ...surface, region: { x: 0, y: 0, width: 12, height: 8 } }],
      settings: { ...settings, interPanelSpacingM: 0.2, rowSpacingM: 0.2, setbackM: 0.2 },
    })
    const anchor = validStore.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 } })
    const other = validStore.addPanel({ panelId: widePanel.id, surfaceId: 'roof', localCenter: { x: 8, y: 2 } })
    expect(anchor).toBeDefined()
    expect(other).toBeDefined()
    validStore.selectPanels([anchor?.id ?? '', other?.id ?? ''])
    expect(validStore.setAlignMode(true, anchor?.id)).toBe(true)
    const validPreview = validStore.previewAlign()
    expect(validPreview?.valid).toBe(true)
    expect(validPreview?.placements[0]?.localCenter.x).toBeCloseTo(3.7)
    expect(validStore.confirmAlign()).toBe(true)
    expect(validStore.getState().placements[other?.id ?? '']?.localCenter.x).toBeCloseTo(3.7)

    const blockedStore = createPlacementStore({
      panels: [panel, widePanel],
      surfaces: [{ ...surface, region: { x: 0, y: 0, width: 12, height: 8 } }],
      obstacles: [{ id: 'chimney', x: 3, y: 1, width: 1.5, height: 2 }],
      settings: { ...settings, interPanelSpacingM: 0.2, rowSpacingM: 0.2, setbackM: 0.2 },
    })
    const blockedAnchor = blockedStore.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 } })
    const blockedOther = blockedStore.addPanel({ panelId: widePanel.id, surfaceId: 'roof', localCenter: { x: 8, y: 2 } })
    expect(blockedAnchor).toBeDefined()
    expect(blockedOther).toBeDefined()
    blockedStore.selectPanels([blockedAnchor?.id ?? '', blockedOther?.id ?? ''])
    blockedStore.setAlignMode(true, blockedAnchor?.id)
    const invalidPreview = blockedStore.previewAlign()
    expect(invalidPreview?.valid).toBe(false)
    expect(invalidPreview?.invalidIds).toContain(blockedOther?.id)
    expect(blockedStore.confirmAlign()).toBe(false)
    expect(blockedStore.getState().placements[blockedOther?.id ?? '']?.localCenter).toEqual({ x: 8, y: 2 })
  })

  it('clones and freezes caller inputs, snapshots and placement outputs', () => {
    const sourcePanel = { ...panel }
    const sourceSurface = {
      ...surface,
      frame: {
        ...surface.frame,
        origin: { ...surface.frame.origin },
      },
      region: { x: 0, y: 0, width: 10, height: 5 },
    }
    const sourceGutter = {
      surfaceId: 'roof',
      direction: { x: 4, y: 0 },
      line: { origin: { x: 0, y: 0 }, direction: { x: 0, y: 2 } },
    }
    const store = createPlacementStore({ panels: [sourcePanel], surfaces: [sourceSurface], gutters: [sourceGutter] })
    sourcePanel.widthM = 4
    sourceSurface.frame.origin.x = 99
    sourceSurface.region.width = 1
    sourceGutter.direction.x = 0
    const placement = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 } })
    expect(placement).toBeDefined()
    expect(store.placementTransform(placement?.id ?? '')?.worldCenter).toEqual({ x: 12, y: 22, z: 30.1 })
    expect(store.placementTransform(placement?.id ?? '')?.gutterDirection).toEqual({ x: 1, y: 0 })
    expect(store.gutterFacing('roof')?.line?.direction).toEqual({ x: 0, y: 1 })
    const snapshot = store.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.settings)).toBe(true)
    expect(Object.isFrozen(snapshot.placements[placement?.id ?? ''])).toBe(true)
    expect(Object.isFrozen(snapshot.placements[placement?.id ?? '']?.localCenter)).toBe(true)
    const mutableSettings = snapshot.settings as unknown as { clearanceM: number }
    expect(() => { mutableSettings.clearanceM = 9 }).toThrow()
    expect(snapshot.settings.clearanceM).toBe(0.1)
  })
})

describe('PlacementStore host integration seam', () => {
  it('keeps getSnapshot stable, notifies once per real change, and unsubscribes idempotently', () => {
    const store = makeStore()
    let notifications = 0
    const unsubscribe = store.subscribe(() => { notifications += 1 })
    const initial = store.getSnapshot()
    expect(store.getSnapshot()).toBe(initial)

    expect(store.setActiveSurface('roof')).toBe(true)
    expect(notifications).toBe(1)
    const active = store.getSnapshot()
    expect(active).not.toBe(initial)
    expect(store.setActiveSurface('roof')).toBe(false)
    expect(notifications).toBe(1)
    expect(store.getSnapshot()).toBe(active)

    const placement = store.addPanel({ panelId: panel.id, localCenter: { x: 2, y: 2 } })
    expect(placement).toBeDefined()
    expect(notifications).toBe(2)
    const committed = store.getSnapshot()
    expect(store.selectPanels([placement?.id ?? ''])).toEqual([placement?.id])
    expect(notifications).toBe(2)
    expect(store.getSnapshot()).toBe(committed)

    unsubscribe()
    unsubscribe()
    expect(store.setActiveSurface(undefined)).toBe(true)
    expect(notifications).toBe(2)
  })

  it('registers custom panel definitions without destroying design or history', () => {
    const store = makeStore()
    const existing = store.addPanel({ panelId: panel.id, surfaceId: 'roof', localCenter: { x: 2, y: 2 } })
    expect(existing).toBeDefined()
    const before = store.getSnapshot()
    const undoDepth = store.getState().undoDepth
    let notifications = 0
    store.subscribe(() => { notifications += 1 })
    const custom: PanelDefinition = { ...panel, id: 'custom-450', model: 'Custom 450', wattageW: 450 }
    expect(store.registerPanel(custom)).toBe(true)
    expect(isPanelList(store.context.panels) && store.context.panels.some((candidate) => candidate.id === custom.id)).toBe(true)
    expect(store.getSnapshot()).not.toBe(before)
    expect(store.getState().placements[existing?.id ?? '']).toBeDefined()
    expect(store.getState().undoDepth).toBe(undoDepth)
    const registered = isPanelList(store.context.panels) ? store.context.panels.find((candidate) => candidate.id === custom.id) : undefined
    expect(Object.isFrozen(registered)).toBe(true)
    expect(notifications).toBe(1)
    expect(store.registerPanel(custom)).toBe(false)
    expect(notifications).toBe(1)
    const added = store.addPanel({ panelId: custom.id, surfaceId: 'garage', localCenter: { x: 2, y: 2 } })
    expect(added?.panelId).toBe(custom.id)
  })

  it('replaces context as a reset transaction and rejects malformed context inputs', () => {
    const store = makeStore()
    store.setActiveSurface('roof')
    const existing = store.addPanel({ panelId: panel.id, localCenter: { x: 2, y: 2 } })
    expect(existing).toBeDefined()
    expect(store.beginManualPlacement({ panelId: panel.id })).toBe(true)
    expect(store.updateManualPlacement({ x: 3, y: 2 })).toBe(true)
    expect(store.previewAutoFill({ panelId: panel.id, surfaceId: 'roof' })).toBeDefined()
    expect(store.getState().undoDepth).toBeGreaterThan(0)
    const before = store.getSnapshot()
    let notifications = 0
    store.subscribe(() => { notifications += 1 })

    expect(store.replaceContext(null)).toBe(false)
    expect(store.getSnapshot()).toBe(before)
    expect(store.registerPanel(null)).toBe(false)
    expect(store.registerPanel({ ...panel, id: 'bad', widthM: Number.NaN })).toBe(false)
    expect(notifications).toBe(0)

    expect(store.replaceContext({ panels: [panel], surfaces: [secondSurface], obstacles: [] })).toBe(true)
    const reset = store.getSnapshot()
    expect(reset).not.toBe(before)
    expect(reset.placements).toEqual({})
    expect(reset.selectedIds).toEqual([])
    expect(reset.activeSurfaceIds).toEqual([])
    expect(reset.manualPlacement).toBeUndefined()
    expect(reset.autoFillPreview).toBeUndefined()
    expect(reset.undoDepth).toBe(0)
    expect(reset.redoDepth).toBe(0)
    expect(isSurfaceList(store.context.surfaces) ? store.context.surfaces.map((candidate) => candidate.id) : []).toEqual(['garage'])
    expect(store.undo()).toBe(false)
    expect(store.setActiveSurface('roof')).toBe(false)
    expect(notifications).toBe(1)
  })
})
