/**
 * Tracks active pointer ids independently of renderer objects. Pointer-up,
 * pointer-cancel, and lost-capture notifications can therefore terminate a
 * gesture exactly once even when the pointer has left the model or Canvas.
 */
export interface ViewerPointerTracker {
  readonly begin: (pointerId: number) => void
  readonly finish: (pointerId: number) => boolean
  readonly drain: () => readonly number[]
}

/**
 * Cancels every active pointer exactly once.  Viewer uses this from both the
 * window blur and document visibility handlers; keeping the drain operation
 * here makes those lifecycle paths deterministic and unit-testable without a
 * WebGL canvas.
 */
export function cancelViewerPointers(tracker: ViewerPointerTracker, onCancel: (pointerId: number) => void): void {
  for (const pointerId of tracker.drain()) onCancel(pointerId)
}

export function createViewerPointerTracker(): ViewerPointerTracker {
  const active = new Set<number>()
  return {
    begin: (pointerId) => {
      active.add(pointerId)
    },
    finish: (pointerId) => active.delete(pointerId),
    drain: () => {
      const pointerIds = [...active]
      active.clear()
      return pointerIds
    },
  }
}
