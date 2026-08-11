import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PanelDefinition, PanelPlacement, SurfaceDescriptor } from '../core'
import { PanelSlotOutlines } from './PanelSlotOutlines'

const panel: PanelDefinition = { id: 'p', manufacturer: 'PV Studio', model: 'Test', widthM: 1, heightM: 2, thicknessM: 0.035, wattageW: 450, weightKg: 20 }
const surface: SurfaceDescriptor = {
  id: 'roof', frame: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, tangentX: { x: 1, y: 0, z: 0 }, tangentY: { x: 0, y: 1, z: 0 } },
  region: { x: 0, y: 0, width: 10, height: 10 }, area: 100, azimuthDeg: 180, tiltDeg: 0, usableArea: 100, faceRefs: [],
}
const placement: PanelPlacement = { id: 'slot-1', panelId: 'p', surfaceId: 'roof', localCenter: { x: 2, y: 2 }, orientation: 'portrait', clearanceM: 0.1, tiltDeg: 0, groupId: 'array-a' }

describe('PanelSlotOutlines', () => {
  it('renders one interactive outline per candidate', () => {
    const onAdd = vi.fn()
    render(<PanelSlotOutlines slots={[{ placement, panel, surface }]} onAdd={onAdd} />)
    fireEvent.pointerDown(screen.getByTestId('panel-slot'), { button: 0 })
    expect(onAdd).toHaveBeenCalledWith(placement)
  })
})
