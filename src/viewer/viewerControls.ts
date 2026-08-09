import { useEffect, useState } from 'react'
import type { ViewerSurfaceInteractionMode } from './types'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export interface ViewerOrbitControlsConfig {
  readonly enableDamping: boolean
  readonly dampingFactor: number
}

/**
 * OrbitControls must be disabled before a placement or surface-box gesture
 * starts. R3F surface handlers stop synthetic propagation, but OrbitControls
 * listens on the native canvas and can otherwise rotate the camera during a
 * gesture.
 */
export function viewerOrbitControlsEnabled(mode: ViewerSurfaceInteractionMode, surfaceGestureActive = false): boolean {
  return mode === 'select' && !surfaceGestureActive
}

/**
 * Keep camera navigation available for reduced-motion users while removing the
 * inertial settling that can make a gesture continue after the pointer stops.
 */
export function createViewerOrbitControlsConfig(prefersReducedMotion: boolean): ViewerOrbitControlsConfig {
  return prefersReducedMotion
    ? { enableDamping: false, dampingFactor: 0 }
    : { enableDamping: true, dampingFactor: 0.08 }
}

/** Subscribe to the browser preference so an open viewer responds to changes. */
export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY)
    const handleChange = (event: MediaQueryListEvent): void => {
      setPrefersReducedMotion(event.matches)
    }
    mediaQuery.addEventListener('change', handleChange)
    return () => {
      mediaQuery.removeEventListener('change', handleChange)
    }
  }, [])

  return prefersReducedMotion
}
