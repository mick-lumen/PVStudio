import * as THREE from 'three'
import type { Point3 } from '../core'
import type { PanelRenderItem } from './layout'
import { finitePoint3 } from './math'
import type { PanelVisualState } from './materials'
import type { PanelInteractionHandler, PanelPointerInfo } from './types'

/**
 * Keep the visual-state order shared by mesh refs, compact instance arrays,
 * and pointer handlers.  A state with no items is omitted from the scene so
 * it contributes no draw calls (rather than a full count of zero-scaled
 * instances).
 */
export const PANEL_VISUAL_STATE_ORDER: readonly PanelVisualState[] = ['placed', 'selected', 'ghost']

/**
 * Compact each visual state to the items that actually use that material.
 * Relative order is inherited from the canonical batch, making each compact
 * `instanceId` mapping deterministic across every mesh and cell-bar mesh in
 * the state.  Callers must use the returned item list when resolving hits.
 */
export function compactPanelItemsByState(
  items: readonly PanelRenderItem[],
): readonly (readonly PanelRenderItem[])[] {
  return PANEL_VISUAL_STATE_ORDER.map((state) => items.filter((item) => item.state === state))
}

export interface PanelPointerCaptureTarget {
  setPointerCapture?: (pointerId: number) => void
  releasePointerCapture?: (pointerId: number) => void
}

/**
 * Resolve the browser element that owns a native pointer stream.
 *
 * R3F's `ThreeEvent.target` is the intersected Object3D, not the DOM event
 * target.  Pointer capture is a browser API and must therefore be requested
 * on `nativeEvent.target` (normally the canvas).  Keeping this guard at the
 * rendering boundary prevents an Object3D cast from silently turning a drag
 * into a hover-only interaction once the pointer leaves the panel mesh.
 */
export function pointerCaptureTarget(value: EventTarget | null): PanelPointerCaptureTarget | null {
  if (typeof value !== 'object' || value === null || !('setPointerCapture' in value) || typeof value.setPointerCapture !== 'function') return null
  return value as PanelPointerCaptureTarget
}

export interface ActivePanelDrag {
  readonly index: number
  readonly id: string
  readonly pointerId: number
  readonly placement: PanelRenderItem['placement']
  readonly target: PanelPointerCaptureTarget
  lastInfo: PanelPointerInfo
}

export type PanelDragGlobalSignal =
  | { readonly type: 'pointerup' | 'pointercancel' | 'lostpointercapture'; readonly pointerId: number }
  | { readonly type: 'blur' }
  | { readonly type: 'visibilitychange'; readonly hidden: boolean }

/** Decide whether a global browser signal should consume the current drag. */
export function shouldFinishPanelDrag(active: ActivePanelDrag | null, signal: PanelDragGlobalSignal): boolean {
  if (active === null) return false
  if (signal.type === 'blur') return true
  if (signal.type === 'visibilitychange') return signal.hidden
  return signal.pointerId === active.pointerId
}

/**
 * Resolve an instanced mesh hit to its owning panel. Frame/glass/outline
 * meshes allocate one instance per panel, while a cell-line mesh allocates
 * several bars per panel. Keeping this mapping pure lets every visual part
 * share the same interaction callbacks without exposing Three.js objects to
 * the placement layer.
 */
export function panelInstanceIndex(instanceId: number | undefined, barsPerPanel = 1): number | undefined {
  if (instanceId === undefined || !Number.isInteger(instanceId) || instanceId < 0) return undefined
  const stride = Number.isInteger(barsPerPanel) && barsPerPanel > 0 ? barsPerPanel : 1
  return Math.floor(instanceId / stride)
}

/**
 * Convert a display-space Three intersection into the raw model coordinates
 * used by panel placements. The event's Vector3 is cloned before
 * `worldToLocal`, so R3F's immutable event payload is never mutated.
 *
 * Keeping this conversion at the rendering boundary means consumers only see
 * the canonical serialisable Point3 DTO while the Three Object3D seam remains
 * internal to the scene graph.
 */
export function toPanelLocalPoint(
  displayPoint: { readonly x: number; readonly y: number; readonly z: number },
  ancestor: THREE.Object3D | null,
): Point3 {
  const local = new THREE.Vector3(displayPoint.x, displayPoint.y, displayPoint.z)
  if (ancestor !== null) ancestor.worldToLocal(local)
  return finitePoint3(local)
}

/**
 * Keep an instanced mesh's backing attribute and draw count in sync when a
 * stable batch key receives a larger or smaller item array. R3F does not
 * recreate `InstancedMesh` when its `args` change, so relying on the initial
 * constructor count would either omit new instances or retain stale ones.
 */
export function syncInstancedMeshCount(mesh: THREE.InstancedMesh | null, count: number): void {
  if (mesh === null) return
  const nextCount = Math.max(0, Math.floor(count))
  const attribute = mesh.instanceMatrix
  if (attribute.count < nextCount) {
    const nextArray = new Float32Array(nextCount * attribute.itemSize)
    nextArray.set(attribute.array)
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(
      nextArray,
      attribute.itemSize,
      attribute.normalized,
    )
  }
  mesh.count = nextCount
  mesh.instanceMatrix.needsUpdate = true
}

/**
 * Finish an active drag against the latest item/callback snapshot. Returning
 * null gives callers an atomic state transition: subsequent pointer-up,
 * cancel, or lost-capture events cannot invoke drag-end a second time.
 */
export function finishPanelDrag(
  active: ActivePanelDrag | null,
  items: readonly PanelRenderItem[],
  onPanelDragEnd: PanelInteractionHandler | undefined,
  info: PanelPointerInfo,
  releasePointer: (active: ActivePanelDrag) => void,
): ActivePanelDrag | null {
  if (active === null) return null
  const item = items.find((candidate) => candidate.id === active.id)
  try {
    releasePointer(active)
  } catch {
    // Releasing capture is best effort. A pointer can be implicitly released
    // before this completion path runs (for example on cancel/lost-capture).
  } finally {
    // Keep completion in finally so a release failure cannot drop drag-end.
    // The owning component consumes its active ref before entering here, so
    // callback exceptions cannot strand the drag or trigger duplicate cleanup.
    onPanelDragEnd?.(item?.placement ?? active.placement, info)
  }
  return null
}
