import {
  CELL_TYPES,
  FRAME_COLORS,
  type CellType,
  type FrameColor,
  type PanelSpec,
  type StcRating,
  parsePanelSpec,
} from './panelCatalog'

/** User-entered values for a panel not present in the shipped catalogue. */
export interface CustomPanelInput {
  readonly manufacturer: string
  readonly model: string
  readonly code?: string
  readonly family?: string
  readonly lengthMm: number
  readonly widthMm: number
  readonly thicknessMm: number
  readonly weightKg: number
  readonly wattageW: number
  readonly cellCount: number
  readonly cellType: CellType
  readonly frameColor: FrameColor
  readonly efficiencyPercent: number
  readonly stcRating?: StcRating
}

export interface CustomPanelValidationSuccess {
  readonly valid: true
  readonly value: CustomPanelInput
  readonly errors: Readonly<Record<string, string>>
}

export interface CustomPanelValidationFailure {
  readonly valid: false
  readonly errors: Readonly<Record<string, string>>
}

export type CustomPanelValidation = CustomPanelValidationSuccess | CustomPanelValidationFailure

export class CustomPanelValidationError extends Error {
  readonly errors: Readonly<Record<string, string>>

  constructor(errors: Readonly<Record<string, string>>) {
    super('Custom panel details are invalid')
    this.name = 'CustomPanelValidationError'
    this.errors = errors
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

const readPositive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

const readInteger = (value: unknown): number | undefined => {
  const parsed = readPositive(value)
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined
}

const readEfficiency = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) return undefined
  return value
}

const readStcRating = (value: unknown): StcRating | undefined => {
  if (!isRecord(value)) return undefined
  const irradianceWPerM2 = readPositive(value.irradianceWPerM2)
  const cellTemperatureC = value.cellTemperatureC
  const airMass = readPositive(value.airMass)
  if (
    irradianceWPerM2 === undefined
    || typeof cellTemperatureC !== 'number'
    || !Number.isFinite(cellTemperatureC)
    || airMass === undefined
  ) return undefined
  return { irradianceWPerM2, cellTemperatureC, airMass }
}

const slugify = (value: string): string => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

const readOptionalText = (value: unknown, fallback: string | undefined): string | undefined => {
  if (value === undefined) return fallback
  if (typeof value === 'string' && value.trim().length === 0) return fallback
  return readText(value)
}

/** Validate and normalize custom-panel form data without throwing. */
export const validateCustomPanel = (input: unknown): CustomPanelValidation => {
  if (!isRecord(input)) {
    return { valid: false, errors: { form: 'Enter the panel details before saving.' } }
  }

  const errors: Record<string, string> = {}
  const manufacturer = readText(input.manufacturer)
  const model = readText(input.model)
  const code = readOptionalText(input.code, model)
  const family = readOptionalText(input.family, model)
  const lengthMm = readPositive(input.lengthMm)
  const widthMm = readPositive(input.widthMm)
  const thicknessMm = readPositive(input.thicknessMm)
  const weightKg = readPositive(input.weightKg)
  const wattageW = readPositive(input.wattageW)
  const cellCount = readInteger(input.cellCount)
  const cellType = input.cellType
  const frameColor = input.frameColor
  const efficiencyPercent = readEfficiency(input.efficiencyPercent)
  const stcRating = input.stcRating === undefined ? undefined : readStcRating(input.stcRating)

  if (manufacturer === undefined) errors.manufacturer = 'Manufacturer is required.'
  if (model === undefined) errors.model = 'Model is required.'
  if (code === undefined) errors.code = 'Code is required.'
  if (family === undefined) errors.family = 'Family is required.'
  if (lengthMm === undefined) errors.lengthMm = 'Length must be greater than 0 mm.'
  if (widthMm === undefined) errors.widthMm = 'Width must be greater than 0 mm.'
  if (thicknessMm === undefined) errors.thicknessMm = 'Thickness must be greater than 0 mm.'
  if (weightKg === undefined) errors.weightKg = 'Weight must be greater than 0 kg.'
  if (wattageW === undefined) errors.wattageW = 'Wattage must be greater than 0 W.'
  if (cellCount === undefined) errors.cellCount = 'Cell count must be a positive whole number.'
  if (typeof cellType !== 'string' || !CELL_TYPES.includes(cellType as CellType)) {
    errors.cellType = `Cell technology must be one of: ${CELL_TYPES.join(', ')}.`
  }
  if (typeof frameColor !== 'string' || !FRAME_COLORS.includes(frameColor as FrameColor)) {
    errors.frameColor = `Frame colour must be one of: ${FRAME_COLORS.join(', ')}.`
  }
  if (efficiencyPercent === undefined) errors.efficiencyPercent = 'Efficiency must be greater than 0 and at most 100%.'
  if (input.stcRating !== undefined && stcRating === undefined) errors.stcRating = 'STC rating values must be valid.'

  if (Object.keys(errors).length > 0 || manufacturer === undefined || model === undefined || code === undefined
    || family === undefined || lengthMm === undefined || widthMm === undefined || thicknessMm === undefined
    || weightKg === undefined || wattageW === undefined || cellCount === undefined || efficiencyPercent === undefined
    || typeof cellType !== 'string' || !CELL_TYPES.includes(cellType as CellType)
    || typeof frameColor !== 'string' || !FRAME_COLORS.includes(frameColor as FrameColor)) {
    return { valid: false, errors: Object.freeze(errors) }
  }

  return {
    valid: true,
    errors: Object.freeze({}),
    value: {
      manufacturer,
      model,
      code,
      family,
      lengthMm,
      widthMm,
      thicknessMm,
      weightKg,
      wattageW,
      cellCount,
      cellType: cellType as CellType,
      frameColor: frameColor as FrameColor,
      efficiencyPercent,
      ...(stcRating === undefined ? {} : { stcRating }),
    },
  }
}

const makeUniqueId = (input: CustomPanelInput, existingIds: readonly string[]): string => {
  const base = slugify(`${input.manufacturer}-${input.code ?? input.model}`) || 'custom-panel'
  const existing = new Set(existingIds)
  if (!existing.has(base)) return base
  let suffix = 2
  while (existing.has(`${base}-${String(suffix)}`)) suffix += 1
  return `${base}-${String(suffix)}`
}

/** Create a validated source-shaped panel record suitable for chooser or placement use. */
export const createCustomPanel = (
  input: CustomPanelInput,
  existingIds: readonly string[] = [],
): PanelSpec => {
  const validation = validateCustomPanel(input)
  if (!validation.valid) throw new CustomPanelValidationError(validation.errors)
  const value = validation.value
  return parsePanelSpec({
    id: makeUniqueId(value, existingIds),
    code: value.code,
    manufacturer: value.manufacturer,
    model: value.model,
    family: value.family,
    length: value.lengthMm,
    width: value.widthMm,
    thickness: value.thicknessMm,
    weight: value.weightKg,
    wattage: { min: value.wattageW, max: value.wattageW },
    cellCount: value.cellCount,
    cellType: value.cellType,
    frameColor: value.frameColor,
    efficiency: value.efficiencyPercent,
    stcRating: value.stcRating ?? {
      irradianceWPerM2: 1000,
      cellTemperatureC: 25,
      airMass: 1.5,
    },
  })
}
