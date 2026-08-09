import { describe, expect, it } from 'vitest'
import { cancelViewerPointers, createViewerPointerTracker } from './pointerTracker'

describe('viewer pointer termination tracker', () => {
  it('terminates an active pointer exactly once', () => {
    const tracker = createViewerPointerTracker()
    tracker.begin(11)
    expect(tracker.finish(11)).toBe(true)
    expect(tracker.finish(11)).toBe(false)
    expect(tracker.drain()).toEqual([])
  })

  it('drains pointers for unmount/lost-capture cancellation', () => {
    const tracker = createViewerPointerTracker()
    tracker.begin(3)
    tracker.begin(8)
    expect(tracker.drain()).toEqual([3, 8])
    expect(tracker.finish(3)).toBe(false)
  })

  it('cancels active pointers exactly once for blur and visibility changes', () => {
    const tracker = createViewerPointerTracker()
    tracker.begin(13)
    tracker.begin(21)
    const cancelled: number[] = []
    const cancel = (pointerId: number): void => { cancelled.push(pointerId) }

    // Both browser lifecycle events can arrive back-to-back.  The first drain
    // owns termination; the second must be a no-op rather than a duplicate up.
    cancelViewerPointers(tracker, cancel) // window blur
    cancelViewerPointers(tracker, cancel) // document visibilitychange

    expect(cancelled).toEqual([13, 21])
  })
})
