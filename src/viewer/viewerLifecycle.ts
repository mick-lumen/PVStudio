import type { SurfaceDescriptor } from '../core'
import type {
  ViewerIntersectionLike,
  ViewerSurfaceHit,
  ViewerSurfaceIndex,
} from './surfaceSelection'

/** Hooks used to keep first render independent from the expensive hit index. */
export interface ViewerSurfaceAnalysisHooks {
  readonly isActive: () => boolean
  readonly buildIndex: () => Promise<ViewerSurfaceIndex>
  readonly buildDescriptors: (index: ViewerSurfaceIndex) => Promise<readonly SurfaceDescriptor[]>
  readonly onReady: (index: ViewerSurfaceIndex, surfaces: readonly SurfaceDescriptor[]) => void
  readonly onProgress: (phase: 'started' | 'indexed' | 'complete') => void
}

/**
 * Runs surface analysis after a model has already been published. Every
 * continuation re-checks activity, so replacement/unmount cannot publish
 * stale descriptors; active failures are returned to the owner for disposal.
 */
export async function runViewerSurfaceAnalysis(hooks: ViewerSurfaceAnalysisHooks): Promise<void> {
  if (!hooks.isActive()) return
  hooks.onProgress('started')
  try {
    const index = await hooks.buildIndex()
    if (!hooks.isActive()) return
    hooks.onProgress('indexed')
    const surfaces = await hooks.buildDescriptors(index)
    if (!hooks.isActive()) return
    hooks.onReady(index, surfaces)
    hooks.onProgress('complete')
  } catch (cause: unknown) {
    if (!hooks.isActive()) return
    throw cause
  }
}

/** Selection is intentionally unavailable while the background index is null. */
export function selectViewerSurface(index: ViewerSurfaceIndex | null, intersection: ViewerIntersectionLike): ViewerSurfaceHit | null {
  return index?.selectionForIntersection(intersection) ?? null
}
