import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { AutoFillPreview, PanelDefinition, PanelPlacement, SurfaceDescriptor } from '../core'
import {
  buildPanelRenderItems,
  createInstanceIdMap,
  groupPanelRenderItems,
  resolveInstanceId,
} from './layout'
import { syncInstancedMeshCount } from './PanelBatch.helpers'

const panel: PanelDefinition = {
  id: 'panel', manufacturer: 'Maker', model: 'M1', widthM: 1, heightM: 2, thicknessM: 0.04, wattageW: 400, weightKg: 20,
}
const surface: SurfaceDescriptor = {
  id: 'surface', frame: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, tangentX: { x: 1, y: 0, z: 0 }, tangentY: { x: 0, y: 1, z: 0 } },
  region: { x: 0, y: 0, width: 10, height: 10 }, area: 100, azimuthDeg: 180, tiltDeg: 0, usableArea: 100, faceRefs: [],
}
const placement = (id: string, localCenter = { x: 1, y: 1 }): PanelPlacement => ({ id, panelId: panel.id, surfaceId: surface.id, localCenter, orientation: 'portrait', clearanceM: 0.1, tiltDeg: 0 })

const preview: AutoFillPreview = {
  request: { panelId: panel.id, surfaceId: surface.id, region: surface.region, obstacles: [], settings: { orientation: 'portrait', interPanelSpacingM: 0.02, rowSpacingM: 0.03, setbackM: 0.2, clearanceM: 0.1, tiltDeg: 0 } },
  candidates: [{ id: 'candidate', localCenter: { x: 2, y: 2 }, footprint: { widthM: 1, heightM: 2 }, orientation: 'portrait', clearanceM: 0.1, tiltDeg: 0 }],
  totalWattageW: 400,
  totalKwp: 0.4,
}

describe('panel render layout', () => {
  it('resolves arrays/records, skips stale references, and preserves stable placement order', () => {
    const items = buildPanelRenderItems({ placements: [placement('a'), { ...placement('missing'), panelId: 'not-catalogued' }], panelDefinitions: [panel], surfaces: { [surface.id]: surface } })
    expect(items.map((item) => item.id)).toEqual(['a'])
    expect(items[0]?.source).toBe('placement')
    expect(items[0]?.interactive).toBe(true)
  })

  it('marks selected, dragged, ghost, and auto-fill preview items without duplicate ids', () => {
    const items = buildPanelRenderItems({
      placements: [placement('placed'), placement('dragged'), placement('candidate')],
      panelDefinitions: { [panel.id]: panel },
      surfaces: { [surface.id]: surface },
      selectedIds: ['placed'],
      draggingIds: ['dragged'],
      ghostPlacements: [placement('ghost')],
      autoFillPreview: preview,
    })
    expect(items.map((item) => item.id)).toEqual(['placed', 'dragged', 'candidate', 'ghost'])
    expect(items.map((item) => item.state)).toEqual(['selected', 'ghost', 'placed', 'ghost'])
    expect(items.find((item) => item.id === 'candidate')?.source).toBe('placement')
    expect(items.find((item) => item.id === 'ghost')?.source).toBe('placement')
    expect(items.find((item) => item.id === 'candidate')?.interactive).toBe(true)
  })

  it('groups repeated dimensions and state for bounded instancing and maps instance ids', () => {
    const items = buildPanelRenderItems({ placements: [placement('a'), placement('b')], panelDefinitions: [panel], surfaces: [surface] })
    const batches = groupPanelRenderItems(items)
    expect(batches).toHaveLength(1)
    expect(batches[0]?.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(createInstanceIdMap(items)).toEqual(new Map([[0, 'a'], [1, 'b']]))
    expect(resolveInstanceId(1, items)?.id).toBe('b')
    expect(resolveInstanceId(99, items)).toBeUndefined()
  })

  it('keeps a batch key stable across selection/count changes and splits mixed visual models', () => {
    const panelTwo: PanelDefinition = { ...panel, id: 'panel-two', model: 'M2' }
    const first = buildPanelRenderItems({
      placements: [placement('a'), placement('b')],
      panelDefinitions: [panel, panelTwo],
      surfaces: [surface],
      panelVisuals: {
        [panel.id]: { cellCount: 60, frameColor: 0x111111 },
        [panelTwo.id]: { cellCount: 72, frameColor: 0x222222 },
      },
    })
    const selected = buildPanelRenderItems({
      placements: [placement('a'), placement('b')],
      panelDefinitions: [panel, panelTwo],
      surfaces: [surface],
      selectedIds: ['a'],
      panelVisuals: {
        [panel.id]: { cellCount: 60, frameColor: 0x111111 },
        [panelTwo.id]: { cellCount: 72, frameColor: 0x222222 },
      },
    })
    const firstBatches = groupPanelRenderItems(first)
    const selectedBatches = groupPanelRenderItems(selected)
    expect(firstBatches).toHaveLength(1)
    expect(selectedBatches).toHaveLength(1)
    expect(selectedBatches[0]?.key).toBe(firstBatches[0]?.key)
    expect(selectedBatches[0]?.items.map((item) => item.state)).toEqual(['selected', 'placed'])
    const mixed = buildPanelRenderItems({
      placements: [placement('a'), { ...placement('b'), panelId: panelTwo.id }],
      panelDefinitions: [panel, panelTwo],
      surfaces: [surface],
      panelVisuals: {
        [panel.id]: { cellCount: 60, frameColor: 0x111111 },
        [panelTwo.id]: { cellCount: 72, frameColor: 0x222222 },
      },
    })
    expect(groupPanelRenderItems(mixed)).toHaveLength(2)
  })

  it('keeps 500+ canonical placements in bounded instanced batches with stable ids', () => {
    const placements = Array.from({ length: 512 }, (_, index) => placement(`panel-${String(index)}`, {
      x: (index % 32) * 1.1,
      y: Math.floor(index / 32) * 2.1,
    }))
    const started = performance.now()
    const items = buildPanelRenderItems({ placements, panelDefinitions: [panel], surfaces: [surface] })
    const batches = groupPanelRenderItems(items)
    const elapsedMs = performance.now() - started

    expect(items).toHaveLength(512)
    expect(batches).toHaveLength(1)
    const batch = batches[0]
    if (batch === undefined) throw new Error('expected a render batch')
    expect(batch.items).toHaveLength(512)

    // The renderer owns a fixed set of instanced meshes per batch, rather
    // than one Three object per placement. Exercise the same count sync used
    // by PanelBatch for all panel/frame/cell meshes in this bounded batch.
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshBasicMaterial()
    const meshes = Array.from({ length: 12 }, () => new THREE.InstancedMesh(geometry, material, 1))
    meshes.forEach((mesh) => { syncInstancedMeshCount(mesh, batch.items.length) })
    expect(meshes.every((mesh) => mesh.count === 512 && mesh.instanceMatrix.count >= 512)).toBe(true)

    const idMap = createInstanceIdMap(batch.items)
    expect(idMap.size).toBe(512)
    expect(idMap.get(0)).toBe('panel-0')
    expect(idMap.get(511)).toBe('panel-511')
    expect(resolveInstanceId(511, batch.items)?.id).toBe('panel-511')
    expect(new Set(idMap.values()).size).toBe(512)
    expect(elapsedMs).toBeLessThan(500)

    meshes.forEach((mesh) => mesh.dispose())
    geometry.dispose()
    material.dispose()
  })

  it('rejects malformed placement fields before pose calculation', () => {
    const malformed = { ...placement('bad'), localCenter: { x: Number.NaN, y: 1 } } as PanelPlacement
    const overTilt = { ...placement('tilt'), tiltDeg: 91 }
    expect(buildPanelRenderItems({ placements: [malformed, overTilt], panelDefinitions: [panel], surfaces: [surface] })).toEqual([])
  })

  it('threads selected surface edge metadata into placed and preview poses', () => {
    const edge = { surfaceId: surface.id, type: 'gutter' as const, direction: { x: -1, y: 0 } }
    const items = buildPanelRenderItems({
      placements: [placement('placed')],
      panelDefinitions: [panel],
      surfaces: [surface],
      surfaceEdges: [edge],
      autoFillPreview: preview,
    })
    expect(items.find((item) => item.id === 'placed')?.pose.tangentX).toEqual([1, 0, 0])
    expect(items.find((item) => item.id === 'candidate')?.pose.tangentX).toEqual([1, 0, 0])
    expect(items.find((item) => item.id === 'placed')?.pose.tangentY).toEqual([0, 1, 0])
    expect(items.find((item) => item.id === 'candidate')?.pose.tangentY).toEqual([0, 1, 0])

    const requestEdgePreview: AutoFillPreview = {
      ...preview,
      request: { ...preview.request, edge: { type: 'gutter', direction: { x: 1, y: 0 } } },
    }
    const requestItems = buildPanelRenderItems({
      panelDefinitions: [panel],
      surfaces: [surface],
      surfaceEdges: [edge],
      autoFillPreview: requestEdgePreview,
    })
    expect(requestItems[0]?.pose.tangentX).toEqual([1, 0, 0])
    expect(requestItems[0]?.pose.tangentY).toEqual([0, 1, 0])
  })

  it('lets an explicit null edge override suppress an embedded surface edge', () => {
    const embeddedSurface: SurfaceDescriptor = {
      ...surface,
      edge: { type: 'gutter', direction: { x: 0, y: 1 } },
    }
    const fallbackItems = buildPanelRenderItems({
      placements: [placement('embedded')],
      panelDefinitions: [panel],
      surfaces: [embeddedSurface],
    })
    expect(fallbackItems[0]?.pose.tangentX).toEqual([0, -1, 0])
    expect(fallbackItems[0]?.pose.tangentY).toEqual([1, 0, 0])

    const clearedItems = buildPanelRenderItems({
      placements: [placement('cleared')],
      panelDefinitions: [panel],
      surfaces: [embeddedSurface],
      surfaceEdges: { [surface.id]: null },
    })
    expect(clearedItems[0]?.pose.tangentX).toEqual([1, 0, 0])
    expect(clearedItems[0]?.pose.tangentY).toEqual([0, 1, 0])
  })
})
