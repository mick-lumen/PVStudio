import rawPanelCatalog from './panels.json'

export const CELL_TYPES = ['monocrystalline PERC', 'TOPCon', 'HJT'] as const
export type CellType = (typeof CELL_TYPES)[number]

export const FRAME_COLORS = ['black', 'silver'] as const
export type FrameColor = (typeof FRAME_COLORS)[number]

export interface WattageRange {
  readonly min: number
  readonly max: number
}

export interface StcRating {
  /** Irradiance used by the standard test condition, in watts per square metre. */
  readonly irradianceWPerM2: number
  /** Cell temperature used by the standard test condition, in degrees Celsius. */
  readonly cellTemperatureC: number
  /** Air-mass value used by the standard test condition. */
  readonly airMass: number
}

export interface PanelDimensions {
  readonly lengthMm: number
  readonly widthMm: number
  readonly thicknessMm: number
}

/**
 * A panel specification used by the chooser and the placement engine.
 *
 * The first group of fields mirrors the catalog file and intentionally keeps
 * units in the field documentation close to the values users edit. The
 * aliases at the bottom make geometry code explicit about its units without
 * duplicating those values in the source catalog.
 */
export interface PanelSpec {
  readonly id: string
  /** Manufacturer's catalogue code. This is searchable independently of the display model name. */
  readonly code: string
  readonly manufacturer: string
  readonly model: string
  readonly family: string
  readonly length: number
  readonly width: number
  readonly thickness: number
  readonly weight: number
  readonly wattage: WattageRange
  readonly cellCount: number
  readonly cellType: CellType
  readonly frameColor: FrameColor
  /** Maximum module efficiency in percent for the listed family. */
  readonly efficiency: number
  readonly stcRating: StcRating
  readonly dimensions: PanelDimensions
  readonly weightKg: number
  readonly wattageW: WattageRange
  readonly efficiencyPercent: number
}

export interface PanelFilters {
  readonly query?: string
  readonly manufacturer?: string
  readonly model?: string
  readonly code?: string
  readonly family?: string
  readonly cellType?: CellType
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readString = (record: Record<string, unknown>, key: string, context: string): string => {
  const value = record[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context}.${key} must be a non-empty string`)
  }
  return value.trim()
}

const readOptionalString = (record: Record<string, unknown>, key: string, fallback: string, context: string): string => {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context}.${key} must be a non-empty string when provided`)
  }
  return value.trim()
}

const readPositiveNumber = (record: Record<string, unknown>, key: string, context: string): number => {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${context}.${key} must be a positive number`)
  }
  return value
}

const readInteger = (record: Record<string, unknown>, key: string, context: string): number => {
  const value = readPositiveNumber(record, key, context)
  if (!Number.isInteger(value)) {
    throw new Error(`${context}.${key} must be an integer`)
  }
  return value
}

const readEnum = <T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[],
  context: string,
): T => {
  const value = record[key]
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${context}.${key} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

const parseWattage = (value: unknown, context: string): WattageRange => {
  if (!isRecord(value)) {
    throw new Error(`${context}.wattage must be an object`)
  }
  const min = readPositiveNumber(value, 'min', `${context}.wattage`)
  const max = readPositiveNumber(value, 'max', `${context}.wattage`)
  if (min > max) {
    throw new Error(`${context}.wattage.min cannot exceed max`)
  }
  return { min, max }
}

const parseStcRating = (value: unknown, context: string): StcRating => {
  if (!isRecord(value)) {
    throw new Error(`${context}.stcRating must be an object`)
  }
  return {
    irradianceWPerM2: readPositiveNumber(value, 'irradianceWPerM2', `${context}.stcRating`),
    cellTemperatureC: (() => {
      const temperature = value.cellTemperatureC
      if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
        throw new Error(`${context}.stcRating.cellTemperatureC must be a finite number`)
      }
      return temperature
    })(),
    airMass: readPositiveNumber(value, 'airMass', `${context}.stcRating`),
  }
}

/** Parse and validate one source-catalog record. */
export const parsePanelSpec = (value: unknown, index = 0): PanelSpec => {
  if (!isRecord(value)) {
    throw new Error(`Panel catalog entry ${String(index + 1)} must be an object`)
  }
  const context = `Panel catalog entry ${String(index + 1)}`
  const length = readPositiveNumber(value, 'length', context)
  const width = readPositiveNumber(value, 'width', context)
  const thickness = readPositiveNumber(value, 'thickness', context)
  const weight = readPositiveNumber(value, 'weight', context)
  const wattage = parseWattage(value.wattage, context)
  const efficiency = readPositiveNumber(value, 'efficiency', context)
  if (efficiency > 100) {
    throw new Error(`${context}.efficiency cannot exceed 100 percent`)
  }

  return {
    id: readString(value, 'id', context),
    code: readOptionalString(value, 'code', readString(value, 'model', context), context),
    manufacturer: readString(value, 'manufacturer', context),
    model: readString(value, 'model', context),
    family: readString(value, 'family', context),
    length,
    width,
    thickness,
    weight,
    wattage,
    cellCount: readInteger(value, 'cellCount', context),
    cellType: readEnum(value, 'cellType', CELL_TYPES, context),
    frameColor: readEnum(value, 'frameColor', FRAME_COLORS, context),
    efficiency,
    stcRating: parseStcRating(value.stcRating, context),
    dimensions: { lengthMm: length, widthMm: width, thicknessMm: thickness },
    weightKg: weight,
    wattageW: wattage,
    efficiencyPercent: efficiency,
  }
}

/** Parse and validate a complete source catalog. */
export const parsePanelCatalog = (value: unknown): readonly PanelSpec[] => {
  if (!Array.isArray(value)) {
    throw new Error('Panel catalog must be an array')
  }
  const seenIds = new Set<string>()
  return value.map((entry, index) => {
    const panel = parsePanelSpec(entry, index)
    if (seenIds.has(panel.id)) {
      throw new Error(`Panel catalog contains duplicate id: ${panel.id}`)
    }
    seenIds.add(panel.id)
    return panel
  })
}

const freezePanelSpec = (panel: PanelSpec): PanelSpec => Object.freeze({
  ...panel,
  wattage: Object.freeze({ ...panel.wattage }),
  stcRating: Object.freeze({ ...panel.stcRating }),
  dimensions: Object.freeze({ ...panel.dimensions }),
})

/** The validated, immutable catalog shipped with PV Studio. */
export const PANEL_CATALOG: readonly PanelSpec[] = Object.freeze(parsePanelCatalog(rawPanelCatalog).map(freezePanelSpec))

export const getManufacturers = (panels: readonly PanelSpec[] = PANEL_CATALOG): readonly string[] =>
  [...new Set(panels.map((panel) => panel.manufacturer))].sort((left, right) => left.localeCompare(right))

export const getCellTypes = (panels: readonly PanelSpec[] = PANEL_CATALOG): readonly CellType[] =>
  [...new Set(panels.map((panel) => panel.cellType))].sort((left, right) => left.localeCompare(right))

export const normalizePanelSearch = (query: string): string => query.trim().toLocaleLowerCase()

export type WattageSelection = 'minimum' | 'maximum' | 'midpoint'

/**
 * Resolve a catalogue range to one reproducible rating for placement totals.
 * Callers may choose a documented endpoint or midpoint; midpoint is the
 * neutral default for families whose catalogue entry spans several binning
 * variants.
 */
export const selectPanelWattage = (
  wattage: WattageRange,
  selection: WattageSelection = 'midpoint',
): number => {
  if (selection === 'minimum') return wattage.min
  if (selection === 'maximum') return wattage.max
  return (wattage.min + wattage.max) / 2
}

/**
 * Search by manufacturer, model, and family while optionally narrowing by
 * manufacturer and cell technology. A new array is returned so callers can
 * safely sort or paginate results without mutating the catalog.
 */
export const filterPanelCatalog = (
  panels: readonly PanelSpec[],
  filters: PanelFilters = {},
): PanelSpec[] => {
  const query = normalizePanelSearch(filters.query ?? '')
  return panels.filter((panel) => {
    const matchesQuery =
      query.length === 0 ||
      [panel.manufacturer, panel.model, panel.code, panel.id, panel.family, panel.cellType]
        .some((field) => normalizePanelSearch(field).includes(query))
    const matchesManufacturer = !filters.manufacturer || panel.manufacturer === filters.manufacturer
    const matchesModel = !filters.model || normalizePanelSearch(panel.model).includes(normalizePanelSearch(filters.model))
    const matchesCode = !filters.code || normalizePanelSearch(panel.code).includes(normalizePanelSearch(filters.code))
    const matchesFamily = !filters.family || normalizePanelSearch(panel.family).includes(normalizePanelSearch(filters.family))
    const matchesCellType = !filters.cellType || panel.cellType === filters.cellType
    return matchesQuery && matchesManufacturer && matchesModel && matchesCode && matchesFamily && matchesCellType
  })
}

export const formatWattage = (wattage: WattageRange): string =>
  wattage.min === wattage.max
    ? `${String(wattage.min)} W`
    : `${String(wattage.min)}–${String(wattage.max)} W`
