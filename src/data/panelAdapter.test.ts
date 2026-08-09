import { describe, expect, it } from 'vitest'
import { PANEL_CATALOG, toPanelDefinition } from './index'

describe('toPanelDefinition', () => {
  it('maps millimetre dimensions to the canonical metre contract', () => {
    const panel = PANEL_CATALOG.find((candidate) => candidate.id === 'ja-solar-jam72s30')
    if (panel === undefined) throw new Error('fixture panel is missing')

    const definition = toPanelDefinition(panel)

    expect(definition).toEqual({
      id: panel.id,
      manufacturer: panel.manufacturer,
      model: panel.model,
      widthM: panel.width / 1000,
      heightM: panel.length / 1000,
      thicknessM: panel.thickness / 1000,
      wattageW: (panel.wattage.min + panel.wattage.max) / 2,
      weightKg: panel.weight,
    })
    expect(Object.isFrozen(definition)).toBe(true)
  })

  it('uses an explicitly resolved wattage when supplied', () => {
    const panel = PANEL_CATALOG.find((candidate) => candidate.id === 'ja-solar-jam72s30')
    if (panel === undefined) throw new Error('fixture panel is missing')

    expect(toPanelDefinition(panel, panel.wattage.max).wattageW).toBe(panel.wattage.max)
  })

  it('rejects a non-positive explicit wattage through the canonical validator', () => {
    const panel = PANEL_CATALOG[0]
    if (panel === undefined) throw new Error('catalog is empty')

    expect(() => toPanelDefinition(panel, 0)).toThrow(/PanelDefinition contains invalid/)
  })
})
