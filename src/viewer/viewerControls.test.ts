import { describe, expect, it } from 'vitest'
import { createViewerOrbitControlsConfig, viewerOrbitControlsEnabled } from './viewerControls'

describe('viewer OrbitControls arbitration', () => {
  it('keeps ordinary Select camera navigation enabled', () => {
    expect(viewerOrbitControlsEnabled('select')).toBe(true)
  })

  it('locks Select camera navigation only while a surface gesture is active', () => {
    expect(viewerOrbitControlsEnabled('select', true)).toBe(false)
    expect(viewerOrbitControlsEnabled('select', false)).toBe(true)
  })

  it('reserves the native pointer stream for Place and Obstacle gestures', () => {
    expect(viewerOrbitControlsEnabled('place')).toBe(false)
    expect(viewerOrbitControlsEnabled('obstacle')).toBe(false)
  })

  it('removes OrbitControls inertia for reduced-motion users without disabling navigation', () => {
    expect(createViewerOrbitControlsConfig(true)).toEqual({ enableDamping: false, dampingFactor: 0 })
    expect(createViewerOrbitControlsConfig(false)).toEqual({ enableDamping: true, dampingFactor: 0.08 })
  })
})
