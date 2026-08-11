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
export const PANEL_VISUAL_STATE_ORDER: readonly PanelVisualState[] = ['placed', 'selected', 'ghost', 'invalid']

/**
 * Compact location for one item in a visual-state instanced mesh.  The
 * `instanceIndex` is the index used by panel/frame/outline meshes; cell-bar
 * meshes derive their own bar index from this same compact slot.
 */
export interface CompactPanelInstance {
  readonly state: PanelVisualState
  readonly stateIndex: number
  readonly instanceIndex: number
  readonly item: PanelRenderItem
}

export interface CompactPanelItems {
  readonly stateItems: readonly (readonly PanelRenderItem[])[]
  readonly instancesById: ReadonlyMap<string, CompactPanelInstance>
  readonly itemsById: ReadonlyMap<string, PanelRenderItem>
}

/**
 * Build the compact state arrays and a direct id lookup in one pass.  The
 * state arrays retain canonical item order, while the map lets pointer
 * streams resolve a placement without scanning an entire geometry batch.
 */
export function createCompactPanelItems(items: readonly PanelRenderItem[]): CompactPanelItems {
  const stateItems: PanelRenderItem[][] = PANEL_VISUAL_STATE_ORDER.map(() => [])
  const instancesById = new Map<string, CompactPanelInstance>()
  const itemsById = new Map<string, PanelRenderItem>()
  for (const item of items) {
    const stateIndex = PANEL_VISUAL_STATE_ORDER.indexOf(item.state)
    const compactItems = stateItems[stateIndex]
    if (stateIndex < 0 || compactItems === undefined) continue
    const instanceIndex = compactItems.length
    compactItems.push(item)
    // Canonical render items are id-unique. If a defensive caller supplies a
    // duplicate, retain it in the compact arrays for backwards-compatible
    // rendering while keeping the first direct lookup deterministic.
    if (!instancesById.has(item.id)) {
      instancesById.set(item.id, {
        state: item.state,
        stateIndex,
        instanceIndex,
        item,
      })
      itemsById.set(item.id, item)
    }
  }
  return { stateItems, instancesById, itemsById }
}

/**
 * Compact each visual state to the items that actually use that material.
 * Relative order is inherited from the canonical batch, making each compact
 * `instanceId` mapping deterministic across every mesh and cell-bar mesh in
 * the state.  Callers must use the returned item list when resolving hits.
 */
export function compactPanelItemsByState(
  items: readonly PanelRenderItem[],
): readonly (readonly PanelRenderItem[])[] {
  return createCompactPanelItems(items).stateItems
}

/** Stable id-to-compact-instance lookup for event and drag paths. */
export function createCompactInstanceLookup(
  items: readonly PanelRenderItem[],
): ReadonlyMap<string, CompactPanelInstance> {
  return createCompactPanelItems(items).instancesById
}

export const panelIdToCompactInstance = createCompactInstanceLookup

/** Conservatively grow an aggregate sphere to include one changed instance. */
export function expandSphereBySphere(target: THREE.Sphere, source: THREE.Sphere): void {
  const delta = source.center.clone().sub(target.center)
  const distance = delta.length()
  if (distance + source.radius <= target.radius) return
  if (distance + target.radius <= source.radius) {
    target.copy(source)
    return
  }
  if (distance <= Number.EPSILON) {
    target.radius = Math.max(target.radius, source.radius)
    return
  }
  const radius = (target.radius + distance + source.radius) / 2
  target.center.addScaledVector(delta, (radius - target.radius) / distance)
  target.radius = radius
}

/**
 * Compare only matrix-affecting fields.  Placement/render item records are
 * immutable and commonly rebuilt for every store snapshot, so object identity
 * is not a useful change signal here.
 */
export function panelRenderItemsHaveSameMatrix(
  previous: PanelRenderItem | undefined,
  next: PanelRenderItem | undefined,
): boolean {
  if (previous === undefined || next === undefined || previous.id !== next.id) return false
  const previousMatrix = previous.pose.matrix
  const nextMatrix = next.pose.matrix
  for (let index = 0; index < previousMatrix.length; index += 1) {
    if (previousMatrix[index] !== nextMatrix[index]) return false
  }
  return true
}

/**
 * Return compact slots whose matrix must be rewritten.  Unchanged slots are
 * intentionally omitted so a one-item drag writes only that instance's
 * matrices instead of walking the full batch in Three.js.
 */
export function changedPanelInstanceIndices(
  previous: readonly PanelRenderItem[],
  next: readonly PanelRenderItem[],
): readonly number[] {
  const changed: number[] = []
  for (let index = 0; index < next.length; index += 1) {
    if (!panelRenderItemsHaveSameMatrix(previous[index], next[index])) changed.push(index)
  }
  return changed
}

export interface PanelPointerCaptureTarget {
  setPointerCapture?: (pointerId: number) => void
  releasePointerCapture?: (pointerId: number) => void
}

/**
 * Resolve the browser element that owns a native pointer stream.
 *
 * R3F supplies a synthetic `ThreeEvent.target` with its own capture methods;
 * those methods update Fiber's captured-object map and then capture the DOM
 * event target. A native target is retained as a fallback for test hosts and
 * non-Fiber dispatchers. Keeping this guard at the rendering boundary
 * prevents an Object3D cast from silently turning a drag into a hover-only
 * interaction once the pointer leaves the panel mesh.
 */
export function pointerCaptureTarget(value: unknown): PanelPointerCaptureTarget | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as {
    readonly setPointerCapture?: unknown
    readonly releasePointerCapture?: unknown
  }
  if (typeof candidate.setPointerCapture !== 'function' && typeof candidate.releasePointerCapture !== 'function') return null
  return value
}

export interface ActivePanelDrag {
  index: number
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
  let resized = false
  if (attribute.count < nextCount) {
    const nextArray = new Float32Array(nextCount * attribute.itemSize)
    nextArray.set(attribute.array)
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(
      nextArray,
      attribute.itemSize,
      attribute.normalized,
    )
    resized = true
  }
  mesh.count = nextCount
  if (resized) mesh.instanceMatrix.needsUpdate = true
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
  itemsById?: ReadonlyMap<string, PanelRenderItem>,
): ActivePanelDrag | null {
  if (active === null) return null
  const item = itemsById === undefined
    ? items.find((candidate) => candidate.id === active.id)
    : itemsById.get(active.id)
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
