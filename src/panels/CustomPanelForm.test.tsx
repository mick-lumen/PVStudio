import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PanelSpec } from '../data'
import { CustomPanelForm, type CustomPanelDraft } from './CustomPanelForm'

const validDraft: CustomPanelDraft = {
  manufacturer: 'Acme Solar',
  model: 'AX-450',
  code: 'AX-450',
  family: 'AX Series',
  lengthMm: '1722',
  widthMm: '1134',
  thicknessMm: '30',
  weightKg: '20.5',
  wattageW: '450',
  cellCount: '144',
  cellType: 'TOPCon',
  frameColor: 'black',
  efficiencyPercent: '22.4',
  stcIrradianceWPerM2: '1000',
  stcCellTemperatureC: '25',
  stcAirMass: '1.5',
}

describe('CustomPanelForm', () => {
  it('shows field-level validation errors for an empty submission', async () => {
    const user = userEvent.setup()
    render(<CustomPanelForm onSubmit={vi.fn<(panel: PanelSpec) => void>()} />)

    await user.click(screen.getByRole('button', { name: 'Save custom panel' }))

    expect(screen.getByText('Manufacturer is required.')).toBeInTheDocument()
    expect(screen.getByText('Length must be greater than 0 mm.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /Manufacturer/ })).toHaveAttribute('aria-invalid', 'true')
  })

  it('creates and submits a validated panel from the accessible form', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(panel: PanelSpec) => void>()
    render(<CustomPanelForm onSubmit={onSubmit} existingPanelIds={['acme-solar-ax-450']} initialValues={validDraft} />)

    await user.click(screen.getByRole('button', { name: 'Save custom panel' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      id: 'acme-solar-ax-450-2',
      wattage: { min: 450, max: 450 },
      stcRating: { irradianceWPerM2: 1000, cellTemperatureC: 25, airMass: 1.5 },
    })
  })

  it('renders editable STC inputs with controlled defaults', () => {
    render(<CustomPanelForm onSubmit={vi.fn<(panel: PanelSpec) => void>()} />)

    expect(screen.getByRole('group', { name: 'Standard test conditions (STC)' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Irradiance (W/m²)' })).toHaveValue(1000)
    expect(screen.getByRole('spinbutton', { name: 'Cell temperature (°C)' })).toHaveValue(25)
    expect(screen.getByRole('spinbutton', { name: 'Air mass (AM)' })).toHaveValue(1.5)
  })

  it('shows and associates invalid STC feedback with every STC input', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(panel: PanelSpec) => void>()
    render(<CustomPanelForm onSubmit={onSubmit} initialValues={{ ...validDraft, stcAirMass: '0' }} />)

    await user.click(screen.getByRole('button', { name: 'Save custom panel' }))

    const stcError = screen.getByText('STC rating values must be valid.')
    expect(stcError).toHaveAttribute('id', 'custom-panel-stc-rating-error')
    expect(stcError).toHaveAttribute('role', 'alert')
    for (const label of ['Irradiance (W/m²)', 'Cell temperature (°C)', 'Air mass (AM)']) {
      const input = screen.getByRole('spinbutton', { name: label })
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAttribute('aria-describedby', 'custom-panel-stc-rating-error')
    }
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('supports cancellation without submitting', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(panel: PanelSpec) => void>()
    const onCancel = vi.fn<() => void>()
    render(<CustomPanelForm onSubmit={onSubmit} onCancel={onCancel} />)

    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' })
    const firstCancel = cancelButtons[0]
    if (firstCancel === undefined) throw new Error('cancel button is missing')
    await user.click(firstCancel)

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
