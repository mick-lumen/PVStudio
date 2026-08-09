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
  compactPanelItemsByState,
  PANEL_VISUAL_STATE_ORDER,
  pointerCaptureTarget,
  syncInstancedMeshCount,
  toPanelLocalPoint,
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

function setPanelMatrices(
  mesh: InstancedMeshRef,
  items: readonly PanelRenderItem[],
  translation: readonly [number, number, number],
  dimensions: readonly [number, number, number],
): void {
  if (mesh === null) return
  const matrix = new THREE.Matrix4()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === undefined) continue
    instanceMatrix(item.pose, translation, dimensions, matrix)
    mesh.setMatrixAt(index, matrix)
  }
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
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
): void {
  if (mesh === null) return
  const matrix = new THREE.Matrix4()
  let instance = 0
  const barCount = horizontal ? Math.max(0, rows - 1) : Math.max(0, columns - 1)
  for (let panelIndex = 0; panelIndex < items.length; panelIndex += 1) {
    const item = items[panelIndex]
    if (item === undefined) continue
    if (horizontal) {
      for (let row = 1; row < rows; row += 1) {
        const y = -innerHeight / 2 + (innerHeight * row) / rows
        instanceMatrix(item.pose, [0, y, frontOffset + cellDepth / 2], [innerWidth, lineWidth, cellDepth], matrix)
        mesh.setMatrixAt(instance, matrix)
        instance += 1
      }
    } else {
      for (let column = 1; column < columns; column += 1) {
        const x = -innerWidth / 2 + (innerWidth * column) / columns
        instanceMatrix(item.pose, [x, 0, frontOffset + cellDepth / 2], [lineWidth, innerHeight, cellDepth], matrix)
        mesh.setMatrixAt(instance, matrix)
        instance += 1
      }
    }
  }
  if (instance !== items.length * barCount) return
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
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
  } = props
  const materials = useMemo(
    () => PANEL_VISUAL_STATE_ORDER.map((state) => getSharedPanelMaterialSet(state, batch.visuals)),
    [batch.visuals],
  )
  const stateItems = useMemo(() => compactPanelItemsByState(batch.items), [batch.items])
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
  const latestDragEnd = useRef(onPanelDragEnd)
  useLayoutEffect(() => {
    latestBatchItems.current = batch.items
    latestDragEnd.current = onPanelDragEnd
  }, [batch.items, onPanelDragEnd])

  const frameWidth = Math.min(0.026, batch.widthM / 6, batch.heightM / 6)
  const innerWidth = Math.max(0.001, batch.widthM - frameWidth * 2)
  const innerHeight = Math.max(0.001, batch.heightM - frameWidth * 2)
  const frameDepth = Math.max(0.012, batch.thicknessM)
  const glassDepth = Math.max(0.002, batch.thicknessM * 0.58)
  const cellDepth = Math.max(0.001, batch.thicknessM * 0.18)
  const outlineWidth = Math.max(0.004, frameWidth * 0.38)
  const outlineDepth = Math.max(0.002, batch.thicknessM * 0.12)
  const horizontalCellBarsPerPanel = Math.max(1, batch.cellRows - 1)
  const verticalCellBarsPerPanel = Math.max(1, batch.cellColumns - 1)

  useLayoutEffect(() => {
    const frontOffset = frameDepth / 2
    for (let stateIndex = 0; stateIndex < PANEL_VISUAL_STATE_ORDER.length; stateIndex += 1) {
      const items = stateItems[stateIndex]
      if (items === undefined) continue
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
      setPanelMatrices(glassRefs[stateIndex]?.current ?? null, items, [0, 0, 0], [innerWidth, innerHeight, glassDepth])
      setPanelMatrices(frameTopRefs[stateIndex]?.current ?? null, items, [0, (batch.heightM - frameWidth) / 2, 0], [batch.widthM, frameWidth, frameDepth])
      setPanelMatrices(frameBottomRefs[stateIndex]?.current ?? null, items, [0, -(batch.heightM - frameWidth) / 2, 0], [batch.widthM, frameWidth, frameDepth])
      setPanelMatrices(frameLeftRefs[stateIndex]?.current ?? null, items, [-(batch.widthM - frameWidth) / 2, 0, 0], [frameWidth, innerHeight, frameDepth])
      setPanelMatrices(frameRightRefs[stateIndex]?.current ?? null, items, [(batch.widthM - frameWidth) / 2, 0, 0], [frameWidth, innerHeight, frameDepth])
      setPanelMatrices(outlineTopRefs[stateIndex]?.current ?? null, items, [0, (batch.heightM - outlineWidth) / 2, frontOffset + outlineDepth / 2], [batch.widthM, outlineWidth, outlineDepth])
      setPanelMatrices(outlineBottomRefs[stateIndex]?.current ?? null, items, [0, -(batch.heightM - outlineWidth) / 2, frontOffset + outlineDepth / 2], [batch.widthM, outlineWidth, outlineDepth])
      setPanelMatrices(outlineLeftRefs[stateIndex]?.current ?? null, items, [-(batch.widthM - outlineWidth) / 2, 0, frontOffset + outlineDepth / 2], [outlineWidth, Math.max(outlineWidth, batch.heightM - outlineWidth * 2), outlineDepth])
      setPanelMatrices(outlineRightRefs[stateIndex]?.current ?? null, items, [(batch.widthM - outlineWidth) / 2, 0, frontOffset + outlineDepth / 2], [outlineWidth, Math.max(outlineWidth, batch.heightM - outlineWidth * 2), outlineDepth])
      setCellMatrices(horizontalCellRefs[stateIndex]?.current ?? null, items, true, innerWidth, innerHeight, frontOffset, cellDepth, batch.visuals.cellLineWidthM, batch.cellColumns, batch.cellRows)
      setCellMatrices(verticalCellRefs[stateIndex]?.current ?? null, items, false, innerWidth, innerHeight, frontOffset, cellDepth, batch.visuals.cellLineWidthM, batch.cellColumns, batch.cellRows)
    }
  }, [batch.cellColumns, batch.cellRows, batch.heightM, batch.thicknessM, batch.visuals.cellLineWidthM, batch.widthM, frameDepth, frameWidth, glassDepth, innerHeight, innerWidth, cellDepth, outlineDepth, outlineWidth, stateItems, glassRefs, frameTopRefs, frameBottomRefs, frameLeftRefs, frameRightRefs, outlineTopRefs, outlineBottomRefs, outlineLeftRefs, outlineRightRefs, horizontalCellRefs, verticalCellRefs])

  const itemForEvent = useCallback((event: ThreeEvent<PointerEvent>, items: readonly PanelRenderItem[], barsPerPanel = 1): { readonly item: PanelRenderItem; readonly index: number } | undefined => {
    const index = panelInstanceIndex(event.instanceId, barsPerPanel)
    if (index === undefined) return undefined
    const item = items[index]
    return item === undefined ? undefined : { item, index }
  }, [])

  const releasePointer = useCallback((active: ActiveDrag): void => {
    try {
      active.target.releasePointerCapture?.(active.pointerId)
    } catch {
      // Pointer capture can already be gone when a cancel/lost-capture event
      // races the browser's implicit release. Cleanup is best effort; the
      // drag completion callback must still run.
    }
  }, [])

  const finishDragWithInfo = useCallback((info: PanelPointerInfo, stopPropagation: (() => void) | undefined): void => {
    const active = activeDrag.current
    if (active === null) return
    activeDrag.current = null
    stopPropagation?.()
    finishPanelDrag(active, latestBatchItems.current, latestDragEnd.current, info, releasePointer)
  }, [releasePointer])

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
      const info = pointerInfoFromNative(native, active.lastInfo.worldPoint, active.index)
      finishDragWithInfo(info, undefined)
    }
    const finishFromLastInfo = (signal: Extract<PanelDragGlobalSignal, { readonly type: 'blur' | 'visibilitychange' }>): void => {
      const active = activeDrag.current
      if (active === null || !shouldFinishPanelDrag(active, signal)) return
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
  }, [finishDragWithInfo])

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
      const target = pointerCaptureTarget(event.nativeEvent.target) ?? {}
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
    const item = batch.items.find((candidate) => candidate.id === active.id)
    if (item === undefined || !item.interactive) return
    event.stopPropagation()
    const info = pointerInfo(event, active.index, groupRef.current)
    active.lastInfo = info
    onPanelDrag?.(item.placement, info)
  }, [batch.items, interactionsEnabled, onPanelDrag])

  const finishDrag = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled) return
    const active = activeDrag.current
    if (active === null || event.nativeEvent.pointerId !== active.pointerId) return
    const info = pointerInfo(event, active.index, groupRef.current)
    finishDragWithInfo(info, () => { event.stopPropagation() })
  }, [finishDragWithInfo, interactionsEnabled])

  const handleLostPointerCapture = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled) return
    const active = activeDrag.current
    if (active === null || event.nativeEvent.pointerId !== active.pointerId) return
    const info = pointerInfo(event, active.index, groupRef.current)
    finishDragWithInfo(info, () => { event.stopPropagation() })
  }, [finishDragWithInfo, interactionsEnabled])

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
      } : { raycast: NO_PANEL_RAYCAST },
      horizontalCell: stateInteractionsEnabled ? {
        onPointerDown: (event: ThreeEvent<PointerEvent>): void => { handlePointerDown(event, items, horizontalCellBarsPerPanel) },
        onPointerMove: (event: ThreeEvent<PointerEvent>): void => { handlePointerMove(event) },
        onPointerUp: (event: ThreeEvent<PointerEvent>): void => { finishDrag(event) },
        onPointerCancel: (event: ThreeEvent<PointerEvent>): void => { finishDrag(event) },
        onLostPointerCapture: (event: ThreeEvent<PointerEvent>): void => { handleLostPointerCapture(event) },
      } : { raycast: NO_PANEL_RAYCAST },
      verticalCell: stateInteractionsEnabled ? {
        onPointerDown: (event: ThreeEvent<PointerEvent>): void => { handlePointerDown(event, items, verticalCellBarsPerPanel) },
        onPointerMove: (event: ThreeEvent<PointerEvent>): void => { handlePointerMove(event) },
        onPointerUp: (event: ThreeEvent<PointerEvent>): void => { finishDrag(event) },
        onPointerCancel: (event: ThreeEvent<PointerEvent>): void => { finishDrag(event) },
        onLostPointerCapture: (event: ThreeEvent<PointerEvent>): void => { handleLostPointerCapture(event) },
      } : { raycast: NO_PANEL_RAYCAST },
    }
  }), [finishDrag, handleLostPointerCapture, handlePointerDown, handlePointerMove, horizontalCellBarsPerPanel, interactionsEnabled, stateItems, verticalCellBarsPerPanel])

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
            <instancedMesh ref={horizontalCellRefs[stateIndex]} args={[SHARED_GEOMETRY.cellHorizontal, material.cell, horizontalCellCount]} castShadow={false} receiveShadow={false} {...stateProps.horizontalCell} />
            <instancedMesh ref={verticalCellRefs[stateIndex]} args={[SHARED_GEOMETRY.cellVertical, material.cell, verticalCellCount]} castShadow={false} receiveShadow={false} {...stateProps.verticalCell} />
          </group>
        )
      })}
    </group>
  )
})
