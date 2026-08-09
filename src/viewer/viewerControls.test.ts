import { describe, expect, it } from 'vitest'
import { viewerOrbitControlsEnabled } from './viewerControls'

describe('viewer OrbitControls arbitration', () => {
  it('keeps ordinary Select camera navigation enabled', () => {
    expect(viewerOrbitControlsEnabled('select')).toBe(true)
  })

  it('reserves the native pointer stream for Place and Obstacle gestures', () => {
    expect(viewerOrbitControlsEnabled('place')).toBe(false)
    expect(viewerOrbitControlsEnabled('obstacle')).toBe(false)
  })
})
