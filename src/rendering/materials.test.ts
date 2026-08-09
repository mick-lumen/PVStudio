import { describe, expect, it } from 'vitest'
import {
  PANEL_MATERIAL_PALETTE,
  createPanelMaterialSet,
  disposePanelMaterialSet,
} from './materials'

describe('panel material sets', () => {
  it('creates shared opaque realistic materials for placed modules', () => {
    const materials = createPanelMaterialSet('placed')
    expect(materials.frame.color.getHex()).toBe(PANEL_MATERIAL_PALETTE.frame)
    expect(materials.glass.color.getHex()).toBe(PANEL_MATERIAL_PALETTE.glass)
    expect(materials.cell.color.getHex()).toBe(PANEL_MATERIAL_PALETTE.cell)
    expect(materials.glass.transparent).toBe(false)
    disposePanelMaterialSet(materials)
  })

  it('uses a blue emissive frame and dark glass for selected panels', () => {
    const materials = createPanelMaterialSet('selected')
    expect(materials.frame.color.getHex()).toBe(PANEL_MATERIAL_PALETTE.outline)
    expect(materials.glass.emissive.getHex()).toBe(0x073a69)
    expect(materials.glass.emissiveIntensity).toBeGreaterThan(0)
    disposePanelMaterialSet(materials)
  })

  it('makes previews transparent and keeps the palette immutable', () => {
    const materials = createPanelMaterialSet('ghost')
    expect(materials.frame.transparent).toBe(true)
    expect(materials.glass.opacity).toBeLessThan(1)
    expect(materials.cell.depthWrite).toBe(false)
    expect(Object.isFrozen(PANEL_MATERIAL_PALETTE)).toBe(true)
    disposePanelMaterialSet(materials)
  })
})
