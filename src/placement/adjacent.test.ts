import { describe, expect, it } from 'vitest'
import type { PanelDefinition, PanelGroupSettings, PanelPlacement } from '../core'
import { createAdjacentPanelSlots } from './adjacent'

const panel: PanelDefinition = {
  id: 'module', manufacturer: 'PV Studio', model: 'Test', widthM: 1, heightM: 2,
  thicknessM: 0.035, wattageW: 450, weightKg: 22,
}
const settings: PanelGroupSettings = {
  orientation: 'portrait', interPanelSpacingM: 0.1, rowSpacingM: 0.2,
  setbackM: 0.2, clearanceM: 0.1, tiltDeg: 0,
}
const placement = (id: string, x: number, y: number): PanelPlacement => ({
  id, panelId: panel.id, surfaceId: 'roof', localCenter: { x, y }, orientation: 'portrait',
  clearanceM: 0.1, tiltDeg: 0, groupId: 'array-a',
})

describe('createAdjacentPanelSlots', () => {
  it('creates a deduplicated outline around a regular array using group spacing', () => {
    const slots = createAdjacentPanelSlots([
      placement('a', 2, 2),
      placement('b', 3.1, 2),
    ], panel, settings)
    expect(slots).toHaveLength(6)
    expect(slots.map((slot) => slot.localCenter)).toContainEqual({ x: 0.8999999999999999, y: 2 })
    expect(slots.map((slot) => slot.localCenter)).toContainEqual({ x: 4.2, y: 2 })
    expect(slots.every((slot) => slot.groupId === 'array-a')).toBe(true)
  })

  it('rejects mixed arrays and honours landscape dimensions', () => {
    const mixed = [{ ...placement('a', 2, 2) }, { ...placement('b', 3.1, 2), groupId: 'array-b' }]
    expect(createAdjacentPanelSlots(mixed, panel, settings)).toEqual([])
    const landscape = { ...placement('a', 2, 2), orientation: 'landscape' as const }
    const slots = createAdjacentPanelSlots([landscape], panel, { ...settings, orientation: 'landscape' })
    expect(slots.map((slot) => slot.localCenter)).toContainEqual({ x: 4.1, y: 2 })
    expect(slots.map((slot) => slot.localCenter)).toContainEqual({ x: 2, y: 3.2 })
  })

  it('rotates every adjacent outline with the complete array azimuth', () => {
    const rotated = { ...placement('a', 2, 2), azimuthDeg: 90 }
    const slots = createAdjacentPanelSlots([rotated], panel, { ...settings, azimuthDeg: 90 })
    expect(slots.map((slot) => slot.localCenter.x)).toEqual(expect.arrayContaining([2, 2]))
    expect(slots.some((slot) => Math.abs(slot.localCenter.y - 0.9) < 1e-9)).toBe(true)
    expect(slots.some((slot) => Math.abs(slot.localCenter.y - 3.1) < 1e-9)).toBe(true)
    expect(slots.every((slot) => slot.azimuthDeg === 90)).toBe(true)
  })
})
