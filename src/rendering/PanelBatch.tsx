import type { ThreeEvent } from '@react-three/fiber'
import {
  type ForwardedRef,
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import * as THREE from 'three'
import type { PanelRenderBatch, PanelRenderItem } from './layout'
import {
  finishPanelDrag,
  panelInstanceIndex,
  shouldFinishPanelDrag,
  type ActivePanelDrag,
  type PanelDragGlobalSignal,
  changedPanelInstanceIndices,
  createCompactPanelItems,
  expandSphereBySphere,
  PANEL_VISUAL_STATE_ORDER,
  pointerCaptureTarget,
  syncInstancedMeshCount,
  toPanelLocalPoint,
  type CompactPanelItems,
} from './PanelBatch.helpers'
import {
  getSharedPanelMaterialSet,
} from './materials'
import { composePanelLocalMatrix } from './math'
import type { PanelLayerInteractionProps, PanelPointerInfo } from './types'

export interface PanelBatchProps extends PanelLayerInteractionProps {
  readonly batch: PanelRenderBatch
}

type ActiveDrag = ActivePanelDrag

interface PanelGeometry {
  readonly glass: THREE.BoxGeometry
  readonly frameHorizontal: THREE.BoxGeometry
  readonly frameVertical: THREE.BoxGeometry
  readonly cellHorizontal: THREE.BoxGeometry
  readonly cellVertical: THREE.BoxGeometry
  readonly outlineHorizontal: THREE.BoxGeometry
  readonly outlineVertical: THREE.BoxGeometry
}

type InstancedMeshRef = THREE.InstancedMesh | null

/** Unit boxes are immutable and shared by every batch, including StrictMode remounts. */
const SHARED_GEOMETRY: PanelGeometry = Object.freeze({
  glass: new THREE.BoxGeometry(1, 1, 1),
  frameHorizontal: new THREE.BoxGeometry(1, 1, 1),
  frameVertical: new THREE.BoxGeometry(1, 1, 1),
  cellHorizontal: new THREE.BoxGeometry(1, 1, 1),
  cellVertical: new THREE.BoxGeometry(1, 1, 1),
  outlineHorizontal: new THREE.BoxGeometry(1, 1, 1),
  outlineVertical: new THREE.BoxGeometry(1, 1, 1),
})

/** Typed no-op raycast used while another scene tool owns pointer input. */
export const NO_PANEL_RAYCAST: THREE.Mesh['raycast'] = (): void => {}

/** Cell details are visual-only and must never become pointer targets. */
export const PANEL_CELL_INTERACTION_PROPS: Readonly<{ readonly raycast: THREE.Mesh['raycast'] }> = Object.freeze({
  raycast: NO_PANEL_RAYCAST,
})

function useMeshRefTuple() {
  const first = useRef<InstancedMeshRef>(null)
  const second = useRef<InstancedMeshRef>(null)
  const third = useRef<InstancedMeshRef>(null)
  return useMemo(() => [first, second, third] as const, [first, second, third])
}

function instanceMatrix(
  pose: PanelRenderItem['pose'],
  translation: readonly [number, number, number],
  dimensions: readonly [number, number, number],
  target: THREE.Matrix4,
): void {
  target.fromArray(composePanelLocalMatrix(pose.matrix, translation, dimensions))
}

/**
 * Update raycast/frustum bounds for changed instances only. The first write
 * computes the complete sphere; subsequent writes expand the existing sphere
 * from each changed instance and never scan untouched instance matrices.
 */
function updateChangedPanelBounds(
  mesh: THREE.InstancedMesh,
  changedIndices: readonly number[] | undefined,
): void {
  if (changedIndices === undefined || mesh.boundingSphere === null) {
    mesh.computeBoundingSphere()
    return
  }
  const bounds = mesh.boundingSphere
  if (changedIndices.length === 0) return
  if (mesh.geometry.boundingSphere === null) mesh.geometry.computeBoundingSphere()
  const geometrySphere = mesh.geometry.boundingSphere
  if (geometrySphere === null) {
    mesh.computeBoundingSphere()
    return
  }
  const matrix = new THREE.Matrix4()
  const instanceSphere = new THREE.Sphere()
  for (const index of changedIndices) {
    if (index < 0 || index >= mesh.count) continue
    matrix.fromArray(mesh.instanceMatrix.array, index * mesh.instanceMatrix.itemSize)
    instanceSphere.copy(geometrySphere).applyMatrix4(matrix)
    expandSphereBySphere(bounds, instanceSphere)
  }
}

function setPanelMatrices(
  mesh: InstancedMeshRef,
  items: readonly PanelRenderItem[],
  translation: readonly [number, number, number],
  dimensions: readonly [number, number, number],
  changedIndices?: readonly number[],
): number {
  if (mesh === null) return 0
  const matrix = new THREE.Matrix4()
  let writes = 0
  if (changedIndices === undefined) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (item === undefined) continue
      instanceMatrix(item.pose, translation, dimensions, matrix)
      mesh.setMatrixAt(index, matrix)
      writes += 1
    }
  } else {
    for (const index of changedIndices) {
      const item = items[index]
      if (item === undefined) continue
      instanceMatrix(item.pose, translation, dimensions, matrix)
      mesh.setMatrixAt(index, matrix)
      writes += 1
    }
  }
  if (writes > 0) {
    mesh.instanceMatrix.needsUpdate = true
    // Every panel mesh is raycastable, so its aggregate sphere must follow a
    // moved instance. The incremental update expands only changed slots.
    updateChangedPanelBounds(mesh, changedIndices)
  }
  return writes
}

function setCellMatrices(
  mesh: InstancedMeshRef,
  items: readonly PanelRenderItem[],
  horizontal: boolean,
  innerWidth: number,
  innerHeight: number,
  frontOffset: number,
  cellDepth: number,
  lineWidth: number,
  columns: number,
  rows: number,
  changedPanelIndices?: readonly number[],
): number {
  if (mesh === null) return 0
  const matrix = new THREE.Matrix4()
  const barCount = horizontal ? Math.max(0, rows - 1) : Math.max(0, columns - 1)
  let writes = 0
  const writePanel = (panelIndex: number): void => {
    const item = items[panelIndex]
    if (item === undefined) return
    if (horizontal) {
      for (let row = 1; row < rows; row += 1) {
        const y = -innerHeight / 2 + (innerHeight * row) / rows
        const instance = panelIndex * barCount + row - 1
        instanceMatrix(item.pose, [0, y, frontOffset + cellDepth / 2], [innerWidth, lineWidth, cellDepth], matrix)
        mesh.setMatrixAt(instance, matrix)
        writes += 1
      }
    } else {
      for (let column = 1; column < columns; column += 1) {
        const x = -innerWidth / 2 + (innerWidth * column) / columns
        const instance = panelIndex * barCount + column - 1
        instanceMatrix(item.pose, [x, 0, frontOffset + cellDepth / 2], [lineWidth, innerHeight, cellDepth], matrix)
        mesh.setMatrixAt(instance, matrix)
        writes += 1
      }
    }
  }
  if (changedPanelIndices === undefined) {
    for (let panelIndex = 0; panelIndex < items.length; panelIndex += 1) writePanel(panelIndex)
  } else {
    for (const panelIndex of changedPanelIndices) writePanel(panelIndex)
  }
  if (writes > 0) mesh.instanceMatrix.needsUpdate = true
  // Cell bars are deliberately non-raycastable, so they do not need a
  // bounding sphere for pointer interaction. Their compact matrices still
  // update for only the affected panel slots.
  return writes
}

function pointerInfo(
  event: ThreeEvent<PointerEvent>,
  instanceId: number | undefined,
  ancestor: THREE.Object3D | null,
): PanelPointerInfo {
  const native = event.nativeEvent
  return {
    worldPoint: toPanelLocalPoint(event.point, ancestor),
    shiftKey: native.shiftKey,
    altKey: native.altKey,
    ctrlKey: native.ctrlKey,
    metaKey: native.metaKey,
    button: native.button,
    ...(instanceId === undefined ? {} : { instanceId }),
  }
}

function pointerInfoFromNative(native: PointerEvent, lastPoint: PanelPointerInfo['worldPoint'], instanceId: number): PanelPointerInfo {
  return {
    worldPoint: lastPoint,
    shiftKey: native.shiftKey,
    altKey: native.altKey,
    ctrlKey: native.ctrlKey,
    metaKey: native.metaKey,
    button: native.button,
    instanceId,
  }
}

/**
 * Render one geometry group. Static geometry is shared across batches; each
 * visual state owns only the instances that use its material. Empty states
 * are omitted, while the state item arrays keep compact pointer identities
 * stable across every panel and cell mesh.
 */
export const PanelBatch = forwardRef(function PanelBatch(
  props: PanelBatchProps,
  forwardedRef: ForwardedRef<THREE.Group>,
): ReactNode {
  const {
    batch,
    interactionsEnabled = true,
    onPanelSelect,
    onPanelDragStart,
    onPanelDrag,
    onPanelDragEnd,
    onPanelContextMenu,
  } = props
  const materials = useMemo(
    () => PANEL_VISUAL_STATE_ORDER.map((state) => getSharedPanelMaterialSet(state, batch.visuals)),
    [batch.visuals],
  )
  const compactItems = useMemo<CompactPanelItems>(() => createCompactPanelItems(batch.items), [batch.items])
  const stateItems = compactItems.stateItems
  const glassRefs = useMeshRefTuple()
  const frameTopRefs = useMeshRefTuple()
  const frameBottomRefs = useMeshRefTuple()
  const frameLeftRefs = useMeshRefTuple()
  const frameRightRefs = useMeshRefTuple()
  const outlineTopRefs = useMeshRefTuple()
  const outlineBottomRefs = useMeshRefTuple()
  const outlineLeftRefs = useMeshRefTuple()
  const outlineRightRefs = useMeshRefTuple()
  const horizontalCellRefs = useMeshRefTuple()
  const verticalCellRefs = useMeshRefTuple()
  const groupRef = useRef<THREE.Group>(null)
  const activeDrag = useRef<ActiveDrag | null>(null)
  const latestBatchItems = useRef(batch.items)
  const latestCompactItems = useRef(compactItems)
  const latestDragEnd = useRef(onPanelDragEnd)
  useLayoutEffect(() => {
    latestBatchItems.current = batch.items
    latestCompactItems.current = compactItems
    latestDragEnd.current = onPanelDragEnd
  }, [batch.items, compactItems, onPanelDragEnd])

  const frameWidth = Math.min(0.026, batch.widthM / 6, batch.heightM / 6)
  const innerWidth = Math.max(0.001, batch.widthM - frameWidth * 2)
  const innerHeight = Math.max(0.001, batch.heightM - frameWidth * 2)
  const frameDepth = Math.max(0.012, batch.thicknessM)
  const glassDepth = Math.max(0.002, batch.thicknessM * 0.58)
  const cellDepth = Math.max(0.001, batch.thicknessM * 0.18)
  const outlineWidth = Math.max(0.004, frameWidth * 0.38)
  const outlineDepth = Math.max(0.002, batch.thicknessM * 0.12)
  const previousStateItems = useRef<readonly (readonly PanelRenderItem[])[] | null>(null)

  useLayoutEffect(() => {
    const frontOffset = frameDepth / 2
    const previous = previousStateItems.current
    for (let stateIndex = 0; stateIndex < PANEL_VISUAL_STATE_ORDER.length; stateIndex += 1) {
      const items = stateItems[stateIndex]
      if (items === undefined) continue
      const changedIndices = previous === null
        ? undefined
        : changedPanelInstanceIndices(previous[stateIndex] ?? [], items)
      const count = items.length
      const horizontalCellCount = count * Math.max(0, batch.cellRows - 1)
      const verticalCellCount = count * Math.max(0, batch.cellColumns - 1)
      syncInstancedMeshCount(glassRefs[stateIndex]?.current ?? null, count)
      syncInstancedMeshCount(frameTopRefs[stateIndex]?.current ?? null, count)
      syncInstancedMeshCount(frameBottomRefs[stateIndex]?.current ?? null, count)
      syncInstancedMeshCount(frameLeftRefs[stateIndex]?.current ?? null, count)
      syncInstancedMeshCount(frameRightRefs[stateIndex]?.current ?? null, count)
      syncInstancedMeshCount(outlineTopRefs[stateIndex]?.current ?? null, count)
      syncInstancedMeshCount(outlineBottomRefs[stateIndex]?.current ?? null, count)
      syncInstancedMeshCount(outlineLeftRefs[stateIndex]?.current ?? null, count)
      syncInstancedMeshCount(outlineRightRefs[stateIndex]?.current ?? null, count)
      syncInstancedMeshCount(horizontalCellRefs[stateIndex]?.current ?? null, horizontalCellCount)
      syncInstancedMeshCount(verticalCellRefs[stateIndex]?.current ?? null, verticalCellCount)
      setPanelMatrices(glassRefs[stateIndex]?.current ?? null, items, [0, 0, 0], [innerWidth, innerHeight, glassDepth], changedIndices)
      setPanelMatrices(frameTopRefs[stateIndex]?.current ?? null, items, [0, (batch.heightM - frameWidth) / 2, 0], [batch.widthM, frameWidth, frameDepth], changedIndices)
      setPanelMatrices(frameBottomRefs[stateIndex]?.current ?? null, items, [0, -(batch.heightM - frameWidth) / 2, 0], [batch.widthM, frameWidth, frameDepth], changedIndices)
      setPanelMatrices(frameLeftRefs[stateIndex]?.current ?? null, items, [-(batch.widthM - frameWidth) / 2, 0, 0], [frameWidth, innerHeight, frameDepth], changedIndices)
      setPanelMatrices(frameRightRefs[stateIndex]?.current ?? null, items, [(batch.widthM - frameWidth) / 2, 0, 0], [frameWidth, innerHeight, frameDepth], changedIndices)
      setPanelMatrices(outlineTopRefs[stateIndex]?.current ?? null, items, [0, (batch.heightM - outlineWidth) / 2, frontOffset + outlineDepth / 2], [batch.widthM, outlineWidth, outlineDepth], changedIndices)
      setPanelMatrices(outlineBottomRefs[stateIndex]?.current ?? null, items, [0, -(batch.heightM - outlineWidth) / 2, frontOffset + outlineDepth / 2], [batch.widthM, outlineWidth, outlineDepth], changedIndices)
      setPanelMatrices(outlineLeftRefs[stateIndex]?.current ?? null, items, [-(batch.widthM - outlineWidth) / 2, 0, frontOffset + outlineDepth / 2], [outlineWidth, Math.max(outlineWidth, batch.heightM - outlineWidth * 2), outlineDepth], changedIndices)
      setPanelMatrices(outlineRightRefs[stateIndex]?.current ?? null, items, [(batch.widthM - outlineWidth) / 2, 0, frontOffset + outlineDepth / 2], [outlineWidth, Math.max(outlineWidth, batch.heightM - outlineWidth * 2), outlineDepth], changedIndices)
      setCellMatrices(horizontalCellRefs[stateIndex]?.current ?? null, items, true, innerWidth, innerHeight, frontOffset, cellDepth, batch.visuals.cellLineWidthM, batch.cellColumns, batch.cellRows, changedIndices)
      setCellMatrices(verticalCellRefs[stateIndex]?.current ?? null, items, false, innerWidth, innerHeight, frontOffset, cellDepth, batch.visuals.cellLineWidthM, batch.cellColumns, batch.cellRows, changedIndices)
    }
    previousStateItems.current = stateItems
  }, [batch.cellColumns, batch.cellRows, batch.heightM, batch.thicknessM, batch.visuals.cellLineWidthM, batch.widthM, frameDepth, frameWidth, glassDepth, innerHeight, innerWidth, cellDepth, outlineDepth, outlineWidth, stateItems, glassRefs, frameTopRefs, frameBottomRefs, frameLeftRefs, frameRightRefs, outlineTopRefs, outlineBottomRefs, outlineLeftRefs, outlineRightRefs, horizontalCellRefs, verticalCellRefs])

  const itemForEvent = useCallback((event: { readonly instanceId?: number }, items: readonly PanelRenderItem[], barsPerPanel = 1): { readonly item: PanelRenderItem; readonly index: number } | undefined => {
    const index = panelInstanceIndex(event.instanceId, barsPerPanel)
    if (index === undefined) return undefined
    const item = items[index]
    return item === undefined ? undefined : { item, index }
  }, [])

  const handleContextMenu = useCallback((event: ThreeEvent<MouseEvent>, items: readonly PanelRenderItem[]) => {
    if (!interactionsEnabled) return
    const resolved = itemForEvent(event, items)
    if (resolved === undefined || !resolved.item.interactive) return
    event.stopPropagation()
    event.nativeEvent.preventDefault()
    const native = event.nativeEvent
    onPanelContextMenu?.(resolved.item.placement, {
      worldPoint: toPanelLocalPoint(event.point, groupRef.current),
      shiftKey: native.shiftKey,
      altKey: native.altKey,
      ctrlKey: native.ctrlKey,
      metaKey: native.metaKey,
      button: native.button,
      clientX: native.clientX,
      clientY: native.clientY,
      instanceId: resolved.index,
    })
  }, [interactionsEnabled, itemForEvent, onPanelContextMenu])

  const releasePointer = useCallback((active: ActiveDrag): void => {
    try {
      active.target.releasePointerCapture?.(active.pointerId)
    } catch {
      // Pointer capture can already be gone when a cancel/lost-capture event
      // races the browser's implicit release. Cleanup is best effort; the
      // drag completion callback must still run.
    }
  }, [])

  const syncActiveDragIndex = useCallback((active: ActiveDrag): void => {
    const resolved = latestCompactItems.current.instancesById.get(active.id)
    if (resolved === undefined) return
    active.index = resolved.instanceIndex
    active.lastInfo = { ...active.lastInfo, instanceId: resolved.instanceIndex }
  }, [])

  const finishDragWithInfo = useCallback((info: PanelPointerInfo, stopPropagation: (() => void) | undefined): void => {
    const active = activeDrag.current
    if (active === null) return
    syncActiveDragIndex(active)
    activeDrag.current = null
    stopPropagation?.()
    finishPanelDrag(active, latestBatchItems.current, latestDragEnd.current, { ...info, instanceId: active.index }, releasePointer, latestCompactItems.current.itemsById)
  }, [releasePointer, syncActiveDragIndex])

  const setGroupRef = useCallback((group: THREE.Group | null): void => {
    groupRef.current = group
    if (typeof forwardedRef === 'function') forwardedRef(group)
    else if (forwardedRef !== null) forwardedRef.current = group
  }, [forwardedRef])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const finishFromPointer = (native: PointerEvent): void => {
      const active = activeDrag.current
      const signalType = native.type
      if (signalType !== 'pointerup' && signalType !== 'pointercancel' && signalType !== 'lostpointercapture') return
      const signal: PanelDragGlobalSignal = { type: signalType, pointerId: native.pointerId }
      if (active === null || !shouldFinishPanelDrag(active, signal)) return
      syncActiveDragIndex(active)
      const info = pointerInfoFromNative(native, active.lastInfo.worldPoint, active.index)
      finishDragWithInfo(info, undefined)
    }
    const finishFromLastInfo = (signal: Extract<PanelDragGlobalSignal, { readonly type: 'blur' | 'visibilitychange' }>): void => {
      const active = activeDrag.current
      if (active === null || !shouldFinishPanelDrag(active, signal)) return
      syncActiveDragIndex(active)
      finishDragWithInfo(active.lastInfo, undefined)
    }
    const finishOnBlur = (): void => { finishFromLastInfo({ type: 'blur' }) }
    const finishWhenVisibilityChanges = (): void => {
      finishFromLastInfo({ type: 'visibilitychange', hidden: document.visibilityState === 'hidden' })
    }
    window.addEventListener('pointerup', finishFromPointer)
    window.addEventListener('pointercancel', finishFromPointer)
    window.addEventListener('lostpointercapture', finishFromPointer)
    window.addEventListener('blur', finishOnBlur)
    document.addEventListener('visibilitychange', finishWhenVisibilityChanges)
    return () => {
      window.removeEventListener('pointerup', finishFromPointer)
      window.removeEventListener('pointercancel', finishFromPointer)
      window.removeEventListener('lostpointercapture', finishFromPointer)
      window.removeEventListener('blur', finishOnBlur)
      document.removeEventListener('visibilitychange', finishWhenVisibilityChanges)
      const active = activeDrag.current
      if (active !== null) finishDragWithInfo(active.lastInfo, undefined)
    }
  }, [finishDragWithInfo, syncActiveDragIndex])

  const handlePointerDown = useCallback((event: ThreeEvent<PointerEvent>, items: readonly PanelRenderItem[], barsPerPanel = 1) => {
    if (!interactionsEnabled) return
    const resolved = itemForEvent(event, items, barsPerPanel)
    if (resolved === undefined || !resolved.item.interactive) return
    // R3F's stopPropagation only affects its synthetic intersection walk.
    // OrbitControls listens to the native canvas event as well, so an
    // interactive panel drag must suppress that same pointerdown before it
    // can start a camera rotation.  Inert preview items return above and do
    // not block the viewer's surface picker.
    event.stopPropagation()
    event.nativeEvent.stopImmediatePropagation()
    const info = pointerInfo(event, resolved.index, groupRef.current)
    onPanelSelect?.(resolved.item.placement, info)
    if (onPanelDragStart !== undefined || onPanelDrag !== undefined || onPanelDragEnd !== undefined) {
      // R3F's `event.target` is the intersected THREE.Object3D. Native
      // pointer capture belongs to the DOM canvas target so moves continue
      // to arrive after the pointer leaves this panel's geometry.
      // Prefer Fiber's synthetic target: its capture method records this
      // eventObject in `internal.capturedMap` and delegates DOM capture to
      // the canvas. A native DOM target remains a safe fallback for hosts
      // that dispatch pointer events without Fiber's synthetic interface.
      const target = pointerCaptureTarget(event.target)
        ?? pointerCaptureTarget(event.nativeEvent.target)
        ?? {}
      target.setPointerCapture?.(event.nativeEvent.pointerId)
      activeDrag.current = {
        index: resolved.index,
        id: resolved.item.id,
        pointerId: event.nativeEvent.pointerId,
        placement: resolved.item.placement,
        target,
        lastInfo: info,
      }
      onPanelDragStart?.(resolved.item.placement, info)
    }
  }, [interactionsEnabled, itemForEvent, onPanelDrag, onPanelDragEnd, onPanelDragStart, onPanelSelect])

  const handlePointerMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled) return
    const active = activeDrag.current
    if (active === null || event.nativeEvent.pointerId !== active.pointerId) return
    const resolved = latestCompactItems.current.instancesById.get(active.id)
    const item = resolved?.item
    if (resolved === undefined || item === undefined || !item.interactive) return
    // A state transition can compact the item into a different slot while a
    // native pointer capture keeps the same drag alive. Keep callback metadata
    // aligned with the latest compact instance without scanning the batch.
    active.index = resolved.instanceIndex
    event.stopPropagation()
    const info = pointerInfo(event, active.index, groupRef.current)
    active.lastInfo = info
    onPanelDrag?.(item.placement, info)
  }, [interactionsEnabled, onPanelDrag])

  const finishDrag = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled) return
    const active = activeDrag.current
    if (active === null || event.nativeEvent.pointerId !== active.pointerId) return
    syncActiveDragIndex(active)
    const info = pointerInfo(event, active.index, groupRef.current)
    finishDragWithInfo(info, () => { event.stopPropagation() })
  }, [finishDragWithInfo, interactionsEnabled, syncActiveDragIndex])

  const handleLostPointerCapture = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled) return
    const active = activeDrag.current
    if (active === null || event.nativeEvent.pointerId !== active.pointerId) return
    syncActiveDragIndex(active)
    const info = pointerInfo(event, active.index, groupRef.current)
    finishDragWithInfo(info, () => { event.stopPropagation() })
  }, [finishDragWithInfo, interactionsEnabled, syncActiveDragIndex])

  const stateInteractionProps = useMemo(() => stateItems.map((items, stateIndex) => {
    const state = PANEL_VISUAL_STATE_ORDER[stateIndex] ?? 'placed'
    // A pure ghost state is a visual preview and should disappear from the
    // raycast list entirely.  Keep the handlers on a mixed ghost state when
    // it contains a committed placement currently being dragged: pointer
    // capture still routes move/up events to that item, while the guard in
    // handlePointerDown lets inert items fall through to the surface.
    const stateHasInteractiveItems = items.some((item) => item.interactive)
    const stateInteractionsEnabled = interactionsEnabled && (state !== 'ghost' || stateHasInteractiveItems)
    return {
      panel: stateInteractionsEnabled ? {
        onPointerDown: (event: ThreeEvent<PointerEvent>): void => { handlePointerDown(event, items) },
        onPointerMove: (event: ThreeEvent<PointerEvent>): void => { handlePointerMove(event) },
        onPointerUp: (event: ThreeEvent<PointerEvent>): void => { finishDrag(event) },
        onPointerCancel: (event: ThreeEvent<PointerEvent>): void => { finishDrag(event) },
        onLostPointerCapture: (event: ThreeEvent<PointerEvent>): void => { handleLostPointerCapture(event) },
        onContextMenu: (event: ThreeEvent<MouseEvent>): void => { handleContextMenu(event, items) },
      } : { raycast: NO_PANEL_RAYCAST },
      // Cell bars sit on top of the glass but are visual details only. Keep
      // them out of the raycast list so the panel's glass/frame receives one
      // stable pointer target regardless of the cell grid density.
      horizontalCell: PANEL_CELL_INTERACTION_PROPS,
      verticalCell: PANEL_CELL_INTERACTION_PROPS,
    }
  }), [finishDrag, handleContextMenu, handleLostPointerCapture, handlePointerDown, handlePointerMove, interactionsEnabled, stateItems])

  return (
    <group ref={setGroupRef} name={`pv-panel-batch-${batch.key}`}>
      {PANEL_VISUAL_STATE_ORDER.map((state, stateIndex) => {
        const material = materials[stateIndex]
        const items = stateItems[stateIndex]
        const stateProps = stateInteractionProps[stateIndex]
        if (material === undefined || items === undefined || items.length === 0 || stateProps === undefined) return null
        const count = items.length
        const horizontalCellCount = count * Math.max(0, batch.cellRows - 1)
        const verticalCellCount = count * Math.max(0, batch.cellColumns - 1)
        const castShadow = state !== 'ghost'
        return (
          <group key={state}>
            <instancedMesh ref={glassRefs[stateIndex]} args={[SHARED_GEOMETRY.glass, material.glass, count]} castShadow={castShadow} receiveShadow={castShadow} {...stateProps.panel} />
            <instancedMesh ref={frameTopRefs[stateIndex]} args={[SHARED_GEOMETRY.frameHorizontal, material.frame, count]} castShadow={castShadow} receiveShadow={castShadow} {...stateProps.panel} />
            <instancedMesh ref={frameBottomRefs[stateIndex]} args={[SHARED_GEOMETRY.frameHorizontal, material.frame, count]} castShadow={castShadow} receiveShadow={castShadow} {...stateProps.panel} />
            <instancedMesh ref={frameLeftRefs[stateIndex]} args={[SHARED_GEOMETRY.frameVertical, material.frame, count]} castShadow={castShadow} receiveShadow={castShadow} {...stateProps.panel} />
            <instancedMesh ref={frameRightRefs[stateIndex]} args={[SHARED_GEOMETRY.frameVertical, material.frame, count]} castShadow={castShadow} receiveShadow={castShadow} {...stateProps.panel} />
            <instancedMesh ref={outlineTopRefs[stateIndex]} args={[SHARED_GEOMETRY.outlineHorizontal, material.frame, count]} castShadow={castShadow} receiveShadow={castShadow} {...stateProps.panel} />
            <instancedMesh ref={outlineBottomRefs[stateIndex]} args={[SHARED_GEOMETRY.outlineHorizontal, material.frame, count]} castShadow={castShadow} receiveShadow={castShadow} {...stateProps.panel} />
            <instancedMesh ref={outlineLeftRefs[stateIndex]} args={[SHARED_GEOMETRY.outlineVertical, material.frame, count]} castShadow={castShadow} receiveShadow={castShadow} {...stateProps.panel} />
            <instancedMesh ref={outlineRightRefs[stateIndex]} args={[SHARED_GEOMETRY.outlineVertical, material.frame, count]} castShadow={castShadow} receiveShadow={castShadow} {...stateProps.panel} />
            <instancedMesh ref={horizontalCellRefs[stateIndex]} args={[SHARED_GEOMETRY.cellHorizontal, material.cell, horizontalCellCount]} castShadow={false} receiveShadow={false} frustumCulled={false} {...stateProps.horizontalCell} />
            <instancedMesh ref={verticalCellRefs[stateIndex]} args={[SHARED_GEOMETRY.cellVertical, material.cell, verticalCellCount]} castShadow={false} receiveShadow={false} frustumCulled={false} {...stateProps.verticalCell} />
          </group>
        )
      })}
    </group>
  )
})
