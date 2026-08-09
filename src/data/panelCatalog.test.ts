import { describe, expect, it } from 'vitest'
import {
  CELL_TYPES,
  FRAME_COLORS,
  PANEL_CATALOG,
  filterPanelCatalog,
  formatWattage,
  getCellTypes,
  getManufacturers,
  parsePanelCatalog,
  parsePanelSpec,
  selectPanelWattage,
} from './index'

const requiredPanels = [
  {
    manufacturer: 'JA Solar', model: 'JAM72S30', family: 'JAM72S30', code: 'JAM72S30',
    length: 2278, width: 1134, thickness: 30, weight: 27.5,
    wattage: { min: 540, max: 580 }, cellCount: 144, cellType: 'monocrystalline PERC', frameColor: 'black', efficiency: 22.5,
  },
  {
    manufacturer: 'JA Solar', model: 'JAM60S10', family: 'JAM60S10', code: 'JAM60S10',
    length: 1722, width: 1134, thickness: 30, weight: 19.5,
    wattage: { min: 405, max: 430 }, cellCount: 120, cellType: 'monocrystalline PERC', frameColor: 'black', efficiency: 22.1,
  },
  {
    manufacturer: 'Trina Solar', model: 'TSM-NEG9R.28', family: 'TSM-NEG9R.28', code: 'TSM-NEG9R.28',
    length: 1762, width: 1134, thickness: 30, weight: 21,
    wattage: { min: 430, max: 455 }, cellCount: 144, cellType: 'TOPCon', frameColor: 'black', efficiency: 22.8,
  },
  {
    manufacturer: 'Trina Solar', model: 'Vertex N', family: 'Vertex N', code: 'Vertex N',
    length: 1762, width: 1134, thickness: 30, weight: 21,
    wattage: { min: 445, max: 470 }, cellCount: 144, cellType: 'TOPCon', frameColor: 'black', efficiency: 23.1,
  },
  {
    manufacturer: 'LONGi', model: 'Hi-MO 6', family: 'Hi-MO 6', code: 'Hi-MO 6',
    length: 1722, width: 1134, thickness: 30, weight: 20.8,
    wattage: { min: 435, max: 460 }, cellCount: 144, cellType: 'TOPCon', frameColor: 'black', efficiency: 23,
  },
  {
    manufacturer: 'LONGi', model: 'Hi-MO X6', family: 'Hi-MO X6', code: 'Hi-MO X6',
    length: 1722, width: 1134, thickness: 30, weight: 20.8,
    wattage: { min: 430, max: 460 }, cellCount: 144, cellType: 'TOPCon', frameColor: 'black', efficiency: 23,
  },
  {
    manufacturer: 'Canadian Solar', model: 'TOPHiKu6', family: 'TOPHiKu6', code: 'TOPHiKu6',
    length: 1961, width: 1134, thickness: 30, weight: 22.5,
    wattage: { min: 430, max: 455 }, cellCount: 144, cellType: 'TOPCon', frameColor: 'black', efficiency: 23,
  },
  {
    manufacturer: 'REC', model: 'Alpha Pure-RX', family: 'Alpha Pure-RX', code: 'Alpha Pure-RX',
    length: 1728, width: 1205, thickness: 30, weight: 22.7,
    wattage: { min: 410, max: 430 }, cellCount: 88, cellType: 'HJT', frameColor: 'black', efficiency: 21.4,
  },
] as const

const standardStc = { irradianceWPerM2: 1000, cellTemperatureC: 25, airMass: 1.5 }

describe('panel catalogue', () => {
  it('contains every required real model family and complete specification', () => {
    expect(PANEL_CATALOG).toHaveLength(requiredPanels.length)
    for (const expected of requiredPanels) {
      const panel = PANEL_CATALOG.find((candidate) => candidate.model === expected.model)
      if (panel === undefined) throw new Error(`missing required panel family: ${expected.model}`)
      expect(panel).toMatchObject({
        manufacturer: expected.manufacturer,
        model: expected.model,
        family: expected.family,
        code: expected.code,
        length: expected.length,
        width: expected.width,
        thickness: expected.thickness,
        weight: expected.weight,
        wattage: expected.wattage,
        cellCount: expected.cellCount,
        cellType: expected.cellType,
        frameColor: expected.frameColor,
        efficiency: expected.efficiency,
        stcRating: standardStc,
      })
      expect(panel.dimensions).toEqual({
        lengthMm: expected.length,
        widthMm: expected.width,
        thicknessMm: expected.thickness,
      })
      expect(panel.weightKg).toBe(expected.weight)
      expect(panel.wattageW).toEqual(expected.wattage)
      expect(panel.efficiencyPercent).toBe(expected.efficiency)
    }
  })

  it('loads an immutable catalogue with searchable codes and safe field ranges', () => {
    expect(PANEL_CATALOG.every((panel) => panel.code.length > 0)).toBe(true)
    expect(Object.isFrozen(PANEL_CATALOG)).toBe(true)
    expect(Object.isFrozen(PANEL_CATALOG[0])).toBe(true)
    for (const panel of PANEL_CATALOG) {
      expect(panel.length).toBeGreaterThan(0)
      expect(panel.width).toBeGreaterThan(0)
      expect(panel.thickness).toBeGreaterThan(0)
      expect(panel.weight).toBeGreaterThan(0)
      expect(panel.wattage.min).toBeGreaterThan(0)
      expect(panel.wattage.max).toBeGreaterThanOrEqual(panel.wattage.min)
      expect(panel.cellCount).toBeGreaterThan(0)
      expect(panel.efficiency).toBeGreaterThan(0)
      expect(panel.efficiency).toBeLessThanOrEqual(100)
      expect(panel.stcRating.irradianceWPerM2).toBeGreaterThan(0)
      expect(Number.isFinite(panel.stcRating.cellTemperatureC)).toBe(true)
      expect(panel.stcRating.airMass).toBeGreaterThan(0)
    }
  })

  it('filters by manufacturer, model, code, family, and cell technology', () => {
    expect(filterPanelCatalog(PANEL_CATALOG, { query: 'jam60s10' })).toHaveLength(1)
    expect(filterPanelCatalog(PANEL_CATALOG, { code: 'neg9r' })).toHaveLength(1)
    expect(filterPanelCatalog(PANEL_CATALOG, { model: 'vertex' })).toHaveLength(1)
    expect(filterPanelCatalog(PANEL_CATALOG, { family: 'hi-mo' }).length).toBeGreaterThanOrEqual(2)
    expect(filterPanelCatalog(PANEL_CATALOG, { manufacturer: 'JA Solar', cellType: CELL_TYPES[0] })).toHaveLength(2)
    expect(filterPanelCatalog(PANEL_CATALOG, { query: 'does-not-exist' })).toHaveLength(0)
  })

  it('returns sorted, data-derived filter values', () => {
    expect(getManufacturers(PANEL_CATALOG)).toEqual(['Canadian Solar', 'JA Solar', 'LONGi', 'REC', 'Trina Solar'])
    expect(getCellTypes(PANEL_CATALOG)).toEqual([...CELL_TYPES].sort((left, right) => left.localeCompare(right)))
    expect(FRAME_COLORS).toContain('black')
  })

  it('selects deterministic wattage values from a family range', () => {
    const range = { min: 405, max: 430 }
    expect(selectPanelWattage(range, 'minimum')).toBe(405)
    expect(selectPanelWattage(range, 'maximum')).toBe(430)
    expect(selectPanelWattage(range)).toBe(417.5)
    expect(formatWattage(range)).toBe('405–430 W')
    expect(formatWattage({ min: 450, max: 450 })).toBe('450 W')
  })

  it('rejects malformed records and duplicate ids before exposing the catalogue', () => {
    expect(() => parsePanelSpec({})).toThrow(/length must be a positive number/)
    const panel = PANEL_CATALOG[0]
    if (panel === undefined) throw new Error('catalog is empty')
    expect(() => parsePanelCatalog([panel, panel])).toThrow(/duplicate id/)
  })
})
