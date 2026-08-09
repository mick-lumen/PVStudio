import type { ViewerSurfaceInteractionMode } from './types'

/**
 * OrbitControls must be disabled before a placement gesture starts.  R3F
 * surface handlers stop synthetic propagation, but OrbitControls listens on
 * the native canvas and can otherwise rotate the camera during array drawing.
 */
export function viewerOrbitControlsEnabled(mode: ViewerSurfaceInteractionMode): boolean {
  return mode === 'select'
}
