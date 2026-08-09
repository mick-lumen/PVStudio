import { useState, type ChangeEvent, type SyntheticEvent } from 'react'
import {
  CELL_TYPES,
  FRAME_COLORS,
  CustomPanelValidationError,
  createCustomPanel,
  validateCustomPanel,
  type CustomPanelInput,
  type PanelSpec,
} from '../data'

export interface CustomPanelDraft {
  readonly manufacturer: string
  readonly model: string
  readonly code: string
  readonly family: string
  readonly lengthMm: string
  readonly widthMm: string
  readonly thicknessMm: string
  readonly weightKg: string
  readonly wattageW: string
  readonly cellCount: string
  readonly cellType: string
  readonly frameColor: string
  readonly efficiencyPercent: string
  readonly stcIrradianceWPerM2: string
  readonly stcCellTemperatureC: string
  readonly stcAirMass: string
}

export interface CustomPanelFormProps {
  readonly onSubmit: (panel: PanelSpec) => void
  readonly onCancel?: () => void
  readonly existingPanelIds?: readonly string[]
  readonly initialValues?: Partial<CustomPanelDraft>
}

const EMPTY_DRAFT: CustomPanelDraft = {
  manufacturer: '',
  model: '',
  code: '',
  family: '',
  lengthMm: '',
  widthMm: '',
  thicknessMm: '',
  weightKg: '',
  wattageW: '',
  cellCount: '',
  cellType: CELL_TYPES[0],
  frameColor: FRAME_COLORS[0],
  efficiencyPercent: '',
  // Keep the standard test condition inputs explicit and editable. These
  // values are the conventional STC defaults, but users can provide the
  // conditions that accompany a custom module's datasheet.
  stcIrradianceWPerM2: '1000',
  stcCellTemperatureC: '25',
  stcAirMass: '1.5',
}

const numericValue = (value: string): number => value.trim().length === 0 ? Number.NaN : Number(value)

const toInput = (draft: CustomPanelDraft): CustomPanelInput => ({
  manufacturer: draft.manufacturer,
  model: draft.model,
  code: draft.code,
  family: draft.family,
  lengthMm: numericValue(draft.lengthMm),
  widthMm: numericValue(draft.widthMm),
  thicknessMm: numericValue(draft.thicknessMm),
  weightKg: numericValue(draft.weightKg),
  wattageW: numericValue(draft.wattageW),
  cellCount: numericValue(draft.cellCount),
  cellType: draft.cellType as CustomPanelInput['cellType'],
  frameColor: draft.frameColor as CustomPanelInput['frameColor'],
  efficiencyPercent: numericValue(draft.efficiencyPercent),
  stcRating: {
    irradianceWPerM2: numericValue(draft.stcIrradianceWPerM2),
    cellTemperatureC: numericValue(draft.stcCellTemperatureC),
    airMass: numericValue(draft.stcAirMass),
  },
})

interface FieldProps {
  readonly name: keyof CustomPanelDraft
  readonly label: string
  readonly value: string
  readonly type?: 'text' | 'number'
  readonly placeholder?: string
  readonly error?: string
  readonly describedBy?: string
  readonly invalid?: boolean
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void
}

function TextField({ name, label, value, type = 'text', placeholder, error, describedBy, invalid, onChange }: FieldProps) {
  const errorId = `${name}-error`
  const describedByIds = [error === undefined ? undefined : errorId, describedBy]
    .filter((id): id is string => id !== undefined)
    .join(' ')
  return (
    <label className="custom-panel-form__field" htmlFor={`custom-panel-${name}`}>
      <span>{label}</span>
      <input
        id={`custom-panel-${name}`}
        name={name}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        aria-invalid={invalid ?? error !== undefined}
        aria-describedby={describedByIds.length === 0 ? undefined : describedByIds}
        min={type === 'number' ? '0' : undefined}
        step={type === 'number' ? 'any' : undefined}
      />
      {error === undefined ? null : <small className="custom-panel-form__error" id={errorId}>{error}</small>}
    </label>
  )
}

/** Accessible form for creating and validating a panel outside the shipped catalogue. */
export function CustomPanelForm({ onSubmit, onCancel, existingPanelIds = [], initialValues = {} }: CustomPanelFormProps) {
  const [draft, setDraft] = useState<CustomPanelDraft>({ ...EMPTY_DRAFT, ...initialValues })
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})

  const update = (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>): void => {
    const { name, value } = event.currentTarget
    if (!(name in draft)) return
    setDraft((current) => ({ ...current, [name]: value }))
    setErrors((current) => {
      if (!(name in current)) return current
      return Object.fromEntries(Object.entries(current).filter(([key]) => key !== name))
    })
  }

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const input = toInput(draft)
    const validation = validateCustomPanel(input)
    if (!validation.valid) {
      setErrors(validation.errors)
      return
    }
    try {
      onSubmit(createCustomPanel(validation.value, existingPanelIds))
      setErrors({})
    } catch (error: unknown) {
      if (error instanceof CustomPanelValidationError) setErrors(error.errors)
      else setErrors({ form: 'Unable to save this panel. Check the values and try again.' })
    }
  }

  const field = (
    name: keyof CustomPanelDraft,
    label: string,
    type: 'text' | 'number' = 'text',
    placeholder?: string,
    accessibility?: Pick<FieldProps, 'describedBy' | 'invalid'>,
  ) => (
    <TextField
      name={name}
      label={label}
      type={type}
      value={draft[name]}
      placeholder={placeholder}
      error={errors[name]}
      {...accessibility}
      onChange={update}
    />
  )

  const stcErrorId = 'custom-panel-stc-rating-error'
  const stcError = errors.stcRating
  const stcAccessibility = stcError === undefined
    ? undefined
    : { describedBy: stcErrorId, invalid: true }

  return (
    <form className="custom-panel-form" noValidate onSubmit={submit} data-testid="custom-panel-form">
      <div className="custom-panel-form__heading">
        <div>
          <p className="panel-preview__eyebrow">Panel library</p>
          <h3>Add custom panel</h3>
        </div>
        {onCancel === undefined ? null : <button type="button" className="panel-button panel-button--quiet" onClick={onCancel}>Cancel</button>}
      </div>
      {errors.form === undefined ? null : <p role="alert" className="custom-panel-form__summary">{errors.form}</p>}
      <div className="custom-panel-form__grid">
        {field('manufacturer', 'Manufacturer', 'text', 'e.g. Acme Solar')}
        {field('model', 'Model', 'text', 'e.g. AX-450')}
        {field('code', 'Catalogue code', 'text', 'Optional')}
        {field('family', 'Family', 'text', 'Optional')}
      </div>
      <fieldset>
        <legend>Physical dimensions</legend>
        <div className="custom-panel-form__grid custom-panel-form__grid--three">
          {field('lengthMm', 'Length (mm)', 'number', 'e.g. 1722')}
          {field('widthMm', 'Width (mm)', 'number', 'e.g. 1134')}
          {field('thicknessMm', 'Thickness (mm)', 'number', 'e.g. 30')}
          {field('weightKg', 'Weight (kg)', 'number', 'e.g. 20.5')}
        </div>
      </fieldset>
      <fieldset>
        <legend>Electrical and construction</legend>
        <div className="custom-panel-form__grid custom-panel-form__grid--three">
          {field('wattageW', 'Wattage (W)', 'number', 'e.g. 450')}
          {field('cellCount', 'Cell count', 'number', 'e.g. 144')}
          {field('efficiencyPercent', 'Efficiency (%)', 'number', 'e.g. 22.5')}
          <label className="custom-panel-form__field" htmlFor="custom-panel-cellType">
            <span>Cell technology</span>
            <select
              id="custom-panel-cellType"
              name="cellType"
              value={draft.cellType}
              onChange={update}
              aria-invalid={errors.cellType !== undefined}
              aria-describedby={errors.cellType === undefined ? undefined : 'custom-panel-cellType-error'}
            >
              {CELL_TYPES.map((cellType) => <option key={cellType} value={cellType}>{cellType}</option>)}
            </select>
            {errors.cellType === undefined ? null : <small id="custom-panel-cellType-error" role="alert" className="custom-panel-form__error">{errors.cellType}</small>}
          </label>
          <label className="custom-panel-form__field" htmlFor="custom-panel-frameColor">
            <span>Frame colour</span>
            <select
              id="custom-panel-frameColor"
              name="frameColor"
              value={draft.frameColor}
              onChange={update}
              aria-invalid={errors.frameColor !== undefined}
              aria-describedby={errors.frameColor === undefined ? undefined : 'custom-panel-frameColor-error'}
            >
              {FRAME_COLORS.map((frameColor) => <option key={frameColor} value={frameColor}>{frameColor}</option>)}
            </select>
            {errors.frameColor === undefined ? null : <small id="custom-panel-frameColor-error" role="alert" className="custom-panel-form__error">{errors.frameColor}</small>}
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Standard test conditions (STC)</legend>
        <div className="custom-panel-form__grid custom-panel-form__grid--three">
          {field('stcIrradianceWPerM2', 'Irradiance (W/m²)', 'number', 'e.g. 1000', stcAccessibility)}
          {field('stcCellTemperatureC', 'Cell temperature (°C)', 'number', 'e.g. 25', stcAccessibility)}
          {field('stcAirMass', 'Air mass (AM)', 'number', 'e.g. 1.5', stcAccessibility)}
        </div>
        {stcError === undefined ? null : <small id={stcErrorId} role="alert" className="custom-panel-form__error">{stcError}</small>}
      </fieldset>
      <div className="custom-panel-form__actions">
        <button className="panel-button panel-button--primary" type="submit">Save custom panel</button>
        {onCancel === undefined ? null : <button className="panel-button panel-button--quiet" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  )
}
