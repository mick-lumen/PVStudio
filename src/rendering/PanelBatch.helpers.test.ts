import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { PanelDefinition, PanelPlacement, Point3, SurfaceDescriptor } from '../core'
import { buildPanelRenderItems } from './layout'
import {
  compactPanelItemsByState,
  finishPanelDrag,
  panelInstanceIndex,
  PANEL_VISUAL_STATE_ORDER,
  pointerCaptureTarget,
  shouldFinishPanelDrag,
  type ActivePanelDrag,
  syncInstancedMeshCount,
  toPanelLocalPoint,
} from './PanelBatch.helpers'
import type { PanelPointerInfo } from './types'

const panel: PanelDefinition = {
  id: 'panel',
  manufacturer: 'Maker',
  model: 'M1',
  widthM: 1,
  heightM: 2,
  thicknessM: 0.04,
  wattageW: 400,
  weightKg: 20,
}

const surface: SurfaceDescriptor = {
  id: 'surface',
  frame: {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    tangentX: { x: 1, y: 0, z: 0 },
    tangentY: { x: 0, y: 1, z: 0 },
  },
  region: { x: 0, y: 0, width: 10, height: 10 },
  area: 100,
  azimuthDeg: 180,
  tiltDeg: 0,
  usableArea: 100,
  faceRefs: [],
}

const placement = (id: string, localCenter = { x: 1, y: 1 }): PanelPlacement => ({
  id,
  panelId: panel.id,
  surfaceId: surface.id,
  localCenter,
  orientation: 'portrait',
  clearanceM: 0.1,
  tiltDeg: 0,
})

const pointerInfo = (point: Point3): PanelPointerInfo => ({
  worldPoint: point,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  button: 0,
  instanceId: 0,
})

describe('panel batch lifecycle helpers', () => {
  it('resolves pointer capture from the native DOM target, never the intersected Object3D', () => {
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    const nativeTarget = { setPointerCapture, releasePointerCapture } as unknown as EventTarget
    const objectTarget = new THREE.Mesh()

    expect(pointerCaptureTarget(nativeTarget)).toBe(nativeTarget)
    expect(pointerCaptureTarget(null)).toBeNull()
    expect(pointerCaptureTarget(objectTarget as unknown as EventTarget)).toBeNull()
  })

  it('compacts 500 all-placed panels to 11 meshes and 150,000 box triangles', () => {
    const placements = Array.from({ length: 500 }, (_, index) => placement(`panel-${String(index)}`))
    const items = buildPanelRenderItems({ placements, panelDefinitions: [panel], surfaces: [surface] })
    const stateItems = compactPanelItemsByState(items)
    const nonEmptyStates = stateItems.filter((state) => state.length > 0)
    const first = nonEmptyStates[0]
    if (first === undefined) throw new Error('expected an all-placed state')

    // Each non-empty state renders nine panel boxes plus one horizontal and
    // one vertical cell mesh. Every box has 12 triangles.
    const drawCalls = nonEmptyStates.length * 11
    const boxesPerPanel = 9 + (first[0]?.cellRows ?? 0) - 1 + (first[0]?.cellColumns ?? 0) - 1
    const triangles = first.length * boxesPerPanel * 12

    expect(stateItems.map((state) => state.length)).toEqual([500, 0, 0])
    expect(PANEL_VISUAL_STATE_ORDER).toEqual(['placed', 'selected', 'ghost'])
    expect(drawCalls).toBe(11)
    expect(triangles).toBe(150_000)
    expect(first[0]?.id).toBe('panel-0')
    expect(first[499]?.id).toBe('panel-499')
  })

  it('keeps mixed-state compact IDs and cell-bar strides aligned during growth and shrink', () => {
    const mixedItems = buildPanelRenderItems({
      placements: [placement('placed-a'), placement('selected-b'), placement('ghost-c'), placement('placed-d')],
      panelDefinitions: [panel],
      surfaces: [surface],
      selectedIds: ['selected-b'],
      draggingIds: ['ghost-c'],
    })
    const mixed = compactPanelItemsByState(mixedItems)
    const placed = mixed[0]
    const selected = mixed[1]
    const ghost = mixed[2]
    if (placed === undefined || selected === undefined || ghost === undefined) throw new Error('expected all visual states')

    expect(placed.map((item) => item.id)).toEqual(['placed-a', 'placed-d'])
    expect(selected.map((item) => item.id)).toEqual(['selected-b'])
    expect(ghost.map((item) => item.id)).toEqual(['ghost-c'])
    const panelHit = panelInstanceIndex(1)
    const horizontalCellHit = panelInstanceIndex(1 * 11 + 10, 11)
    const verticalCellHit = panelInstanceIndex(1 * 5 + 4, 5)
    const selectedHit = panelInstanceIndex(0)
    const ghostHit = panelInstanceIndex(0)
    if (panelHit === undefined || horizontalCellHit === undefined || verticalCellHit === undefined || selectedHit === undefined || ghostHit === undefined) {
      throw new Error('expected valid compact instance IDs')
    }
    expect(placed[panelHit]?.id).toBe('placed-d')
    expect(placed[horizontalCellHit]?.id).toBe('placed-d')
    expect(placed[verticalCellHit]?.id).toBe('placed-d')
    expect(selected[selectedHit]?.id).toBe('selected-b')
    expect(ghost[ghostHit]?.id).toBe('ghost-c')

    const grown = compactPanelItemsByState(buildPanelRenderItems({
      placements: Array.from({ length: 512 }, (_, index) => placement(`grown-${String(index)}`)),
      panelDefinitions: [panel],
      surfaces: [surface],
    }))
    const shrunk = compactPanelItemsByState(buildPanelRenderItems({
      placements: Array.from({ length: 500 }, (_, index) => placement(`grown-${String(index)}`)),
      panelDefinitions: [panel],
      surfaces: [surface],
    }))
    expect(grown[0]?.length).toBe(512)
    expect(shrunk[0]?.length).toBe(500)
    expect(grown[0]?.[511]?.id).toBe('grown-511')
    expect(shrunk[0]?.[499]?.id).toBe('grown-499')
  })

  it('maps center, frame, horizontal-cell, and vertical-cell hits to one panel instance', () => {
    const panelIndex = 2
    expect(panelInstanceIndex(panelIndex)).toBe(panelIndex)
    expect(panelInstanceIndex(panelIndex * 11 + 7, 11)).toBe(panelIndex)
    expect(panelInstanceIndex(panelIndex * 5 + 3, 5)).toBe(panelIndex)
    expect(panelInstanceIndex(undefined, 11)).toBeUndefined()
  })

  it('gates blur, hidden visibility, and lost-capture cleanup by the active pointer', () => {
    const item = buildPanelRenderItems({
      placements: [placement('panel-1')],
      panelDefinitions: [panel],
      surfaces: [surface],
    })[0]
    if (item === undefined) throw new Error('expected a render item')
    const active: ActivePanelDrag = {
      index: 0,
      id: item.id,
      pointerId: 19,
      placement: item.placement,
      target: {},
      lastInfo: pointerInfo({ x: 1, y: 1, z: 0 }),
    }

    expect(shouldFinishPanelDrag(active, { type: 'pointerup', pointerId: 18 })).toBe(false)
    expect(shouldFinishPanelDrag(active, { type: 'lostpointercapture', pointerId: 19 })).toBe(true)
    expect(shouldFinishPanelDrag(active, { type: 'blur' })).toBe(true)
    expect(shouldFinishPanelDrag(active, { type: 'visibilitychange', hidden: false })).toBe(false)
    expect(shouldFinishPanelDrag(active, { type: 'visibilitychange', hidden: true })).toBe(true)
    expect(shouldFinishPanelDrag(null, { type: 'blur' })).toBe(false)

    const dragEnd = vi.fn()
    let current: ActivePanelDrag | null = active
    current = finishPanelDrag(current, [item], dragEnd, active.lastInfo, vi.fn())
    expect(current).toBeNull()
    expect(dragEnd).toHaveBeenCalledTimes(1)
    expect(shouldFinishPanelDrag(current, { type: 'lostpointercapture', pointerId: 19 })).toBe(false)
  })

  it('converts display intersections through a translated and scaled ancestor without mutating the hit', () => {
    const parent = new THREE.Group()
    parent.position.set(8, -3, 5)
    parent.scale.set(2, 3, 4)
    const batchGroup = new THREE.Group()
    parent.add(batchGroup)
    parent.updateMatrixWorld(true)

    const modelPoint = new THREE.Vector3(1.25, -0.5, 0.75)
    const displayPoint = modelPoint.clone().applyMatrix4(batchGroup.matrixWorld)
    const displayBefore = displayPoint.clone()
    const localPoint = toPanelLocalPoint(displayPoint, batchGroup)

    expect(localPoint).toEqual({ x: 1.25, y: -0.5, z: 0.75 })
    expect(displayPoint.toArray()).toEqual(displayBefore.toArray())

    const item = buildPanelRenderItems({
      placements: [placement('panel-1')],
      panelDefinitions: [panel],
      surfaces: [surface],
    })[0]
    if (item === undefined) throw new Error('expected a render item')
    const active: ActivePanelDrag = {
      index: 0,
      id: item.id,
      pointerId: 31,
      placement: item.placement,
      target: {},
      lastInfo: pointerInfo(localPoint),
    }
    const dragEnd = vi.fn()
    const releasePointer = vi.fn()

    const completed = finishPanelDrag(active, [item], dragEnd, pointerInfo(localPoint), releasePointer)
    expect(completed).toBeNull()
    expect(dragEnd).toHaveBeenCalledTimes(1)
    expect(dragEnd).toHaveBeenCalledWith(item.placement, expect.objectContaining({ worldPoint: localPoint }))
    expect(releasePointer).toHaveBeenCalledTimes(1)
    expect(finishPanelDrag(completed, [item], dragEnd, pointerInfo(localPoint), releasePointer)).toBeNull()
    expect(dragEnd).toHaveBeenCalledTimes(1)
  })

  it('uses updated callback/items during a drag and ends once across pointerup and lost capture', () => {
    const initialItem = buildPanelRenderItems({
      placements: [placement('panel-1')],
      panelDefinitions: [panel],
      surfaces: [surface],
    })[0]
    if (initialItem === undefined) throw new Error('expected a render item')
    const updatedPlacement = placement('panel-1', { x: 2, y: 2 })
    const updatedItem = { ...initialItem, placement: updatedPlacement }
    const target = { releasePointerCapture: vi.fn() }
    const active: ActivePanelDrag = {
      index: 0,
      id: initialItem.id,
      pointerId: 17,
      placement: initialItem.placement,
      target,
      lastInfo: pointerInfo({ x: 1, y: 1, z: 0 }),
    }
    const initialDragEnd = vi.fn()
    const updatedDragEnd = vi.fn()
    const releasePointer = vi.fn((drag: ActivePanelDrag): void => {
      drag.target.releasePointerCapture?.(drag.pointerId)
    })

    // A parent rerender can replace both identities while the drag remains active.
    let activeDrag: ActivePanelDrag | null = active
    let latestItems = [initialItem]
    let latestDragEnd = initialDragEnd
    latestItems = [updatedItem]
    latestDragEnd = updatedDragEnd
    expect(initialDragEnd).not.toHaveBeenCalled()
    expect(updatedDragEnd).not.toHaveBeenCalled()

    const pointerUpInfo = pointerInfo({ x: 2, y: 2, z: 0 })
    activeDrag = finishPanelDrag(activeDrag, latestItems, latestDragEnd, pointerUpInfo, releasePointer)
    expect(updatedDragEnd).toHaveBeenCalledTimes(1)
    expect(updatedDragEnd).toHaveBeenCalledWith(updatedPlacement, pointerUpInfo)
    expect(initialDragEnd).not.toHaveBeenCalled()
    expect(releasePointer).toHaveBeenCalledTimes(1)
    expect(target.releasePointerCapture).toHaveBeenCalledTimes(1)

    // The subsequent lost-pointer-capture notification sees the cleared state.
    activeDrag = finishPanelDrag(activeDrag, latestItems, latestDragEnd, pointerUpInfo, releasePointer)
    expect(activeDrag).toBeNull()
    expect(updatedDragEnd).toHaveBeenCalledTimes(1)
    expect(releasePointer).toHaveBeenCalledTimes(1)
    expect(target.releasePointerCapture).toHaveBeenCalledTimes(1)
  })

  it('completes the first lost-capture/cancel path when release throws and never ends twice', () => {
    const item = buildPanelRenderItems({
      placements: [placement('panel-1')],
      panelDefinitions: [panel],
      surfaces: [surface],
    })[0]
    if (item === undefined) throw new Error('expected a render item')
    const active: ActivePanelDrag = {
      index: 0,
      id: item.id,
      pointerId: 23,
      placement: item.placement,
      target: {},
      lastInfo: pointerInfo({ x: 1, y: 1, z: 0 }),
    }
    const latestDragEnd = vi.fn()
    const releasePointer = vi.fn((): void => {
      throw new Error('NotFoundError: pointer capture is no longer active')
    })

    let activeDrag: ActivePanelDrag | null = active
    expect(() => {
      // The first lost-capture/cancel notification consumes the drag even if
      // releasePointerCapture races and throws.
      activeDrag = finishPanelDrag(activeDrag, [item], latestDragEnd, pointerInfo({ x: 2, y: 2, z: 0 }), releasePointer)
    }).not.toThrow()
    expect(activeDrag).toBeNull()
    expect(latestDragEnd).toHaveBeenCalledTimes(1)

    // A subsequent cancel/up notification sees no active drag and is inert.
    activeDrag = finishPanelDrag(activeDrag, [item], latestDragEnd, pointerInfo({ x: 3, y: 3, z: 0 }), releasePointer)
    expect(activeDrag).toBeNull()
    expect(releasePointer).toHaveBeenCalledTimes(1)
    expect(latestDragEnd).toHaveBeenCalledTimes(1)
  })

  it('synchronizes every stable mesh count on batch growth and shrink without stale instances', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshBasicMaterial()
    const panelMeshes = Array.from({ length: 27 }, () => new THREE.InstancedMesh(geometry, material, 1))
    const horizontalCellMeshes = Array.from({ length: 3 }, () => new THREE.InstancedMesh(geometry, material, 1))
    const verticalCellMeshes = Array.from({ length: 3 }, () => new THREE.InstancedMesh(geometry, material, 1))

    const syncBatch = (panelCount: number, cellCount: number): void => {
      panelMeshes.forEach((mesh) => { syncInstancedMeshCount(mesh, panelCount) })
      horizontalCellMeshes.forEach((mesh) => { syncInstancedMeshCount(mesh, cellCount) })
      verticalCellMeshes.forEach((mesh) => { syncInstancedMeshCount(mesh, cellCount) })
    }

    syncBatch(4, 8)
    expect(panelMeshes.every((mesh) => mesh.count === 4)).toBe(true)
    expect(horizontalCellMeshes.every((mesh) => mesh.count === 8)).toBe(true)
    expect(verticalCellMeshes.every((mesh) => mesh.count === 8)).toBe(true)

    syncBatch(7, 14)
    expect(panelMeshes.every((mesh) => mesh.count === 7 && mesh.instanceMatrix.count >= 7)).toBe(true)
    expect(horizontalCellMeshes.every((mesh) => mesh.count === 14 && mesh.instanceMatrix.count >= 14)).toBe(true)
    expect(verticalCellMeshes.every((mesh) => mesh.count === 14 && mesh.instanceMatrix.count >= 14)).toBe(true)

    syncBatch(2, 4)
    expect(panelMeshes.every((mesh) => mesh.count === 2)).toBe(true)
    expect(horizontalCellMeshes.every((mesh) => mesh.count === 4)).toBe(true)
    expect(verticalCellMeshes.every((mesh) => mesh.count === 4)).toBe(true)
    expect(panelMeshes.every((mesh) => mesh.instanceMatrix.count >= 7)).toBe(true)
    expect(horizontalCellMeshes.every((mesh) => mesh.instanceMatrix.count >= 14)).toBe(true)
    expect(verticalCellMeshes.every((mesh) => mesh.instanceMatrix.count >= 14)).toBe(true)

    geometry.dispose()
    material.dispose()
  })
})
