import { describe, expect, it } from 'vitest'
import type { ViewerProps, ViewerSurfacePointerEvent } from './types'

describe('viewer pointer DTO contract', () => {
  it('is serialisable and carries gesture modifiers without renderer objects', () => {
    const event: ViewerSurfacePointerEvent = {
      phase: 'move',
      pointerId: 7,
      button: 0,
      buttons: 1,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      selection: null,
    }
    expect(JSON.parse(JSON.stringify(event)) as ViewerSurfacePointerEvent).toEqual(event)
  })

  it('exposes the callback on the public viewer props contract', () => {
    const props: ViewerProps = {
      onSurfacePointer: (event) => {
        expect(event.phase).toBe('down')
      },
    }
    expect(typeof props.onSurfacePointer).toBe('function')
  })
})
