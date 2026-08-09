import { describe, expect, it } from 'vitest'
import {
  CustomPanelValidationError,
  createCustomPanel,
  validateCustomPanel,
  type CustomPanelInput,
} from './index'

const validInput: CustomPanelInput = {
  manufacturer: 'Acme Solar',
  model: 'AX-450',
  lengthMm: 1722,
  widthMm: 1134,
  thicknessMm: 30,
  weightKg: 20.5,
  wattageW: 450,
  cellCount: 144,
  cellType: 'TOPCon',
  frameColor: 'black',
  efficiencyPercent: 22.4,
}

describe('custom panel validation and creation', () => {
  it('normalizes optional identity fields and returns immutable error collections', () => {
    const result = validateCustomPanel(validInput)
    expect(result.valid).toBe(true)
    if (!result.valid) throw new Error('expected valid input')
    expect(result.value.code).toBe(validInput.model)
    expect(result.value.family).toBe(validInput.model)
    expect(result.errors).toEqual({})
    expect(Object.isFrozen(result.errors)).toBe(true)
  })

  it('normalizes optional identity whitespace to the model name', () => {
    const result = validateCustomPanel({ ...validInput, code: '  \t', family: '   ' })
    expect(result.valid).toBe(true)
    if (!result.valid) throw new Error('expected valid input')
    expect(result.value.code).toBe(validInput.model)
    expect(result.value.family).toBe(validInput.model)
  })

  it('reports all invalid fields without throwing', () => {
    const result = validateCustomPanel({
      manufacturer: '',
      model: '',
      lengthMm: -1,
      widthMm: Number.NaN,
      thicknessMm: 0,
      weightKg: 0,
      wattageW: -2,
      cellCount: 12.5,
      cellType: 'unknown',
      frameColor: 'blue',
      efficiencyPercent: 101,
    })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('expected invalid input')
    expect(Object.keys(result.errors)).toEqual(expect.arrayContaining([
      'manufacturer', 'model', 'lengthMm', 'widthMm', 'thicknessMm', 'weightKg',
      'wattageW', 'cellCount', 'cellType', 'frameColor', 'efficiencyPercent',
    ]))
  })

  it('creates a source-shaped panel with a stable collision-safe id', () => {
    const first = createCustomPanel(validInput)
    const second = createCustomPanel(validInput, [first.id])
    expect(first.id).toBe('acme-solar-ax-450')
    expect(second.id).toBe('acme-solar-ax-450-2')
    expect(first.wattage).toEqual({ min: 450, max: 450 })
    expect(first.stcRating).toEqual({ irradianceWPerM2: 1000, cellTemperatureC: 25, airMass: 1.5 })
  })

  it('throws a typed validation error when creation input is invalid', () => {
    expect(() => createCustomPanel({ ...validInput, wattageW: 0 })).toThrow(CustomPanelValidationError)
    const result = validateCustomPanel({ ...validInput, efficiencyPercent: 0 })
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error('expected zero efficiency to be invalid')
    expect(result.errors.efficiencyPercent).toMatch(/greater than 0/)
  })
})
