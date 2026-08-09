import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PANEL_CATALOG, type PanelSpec } from '../data'
import { PanelChooser } from './PanelChooser'

const panels: readonly PanelSpec[] = PANEL_CATALOG.slice(0, 2)

describe('PanelChooser', () => {
  it('starts in the Panel tab context with a model, preview, and add action', () => {
    const onAddPanel = vi.fn<(panel: PanelSpec) => void>()
    render(<PanelChooser panels={panels} onAddPanel={onAddPanel} />)

    expect(screen.getByRole('complementary', { name: 'Panel' })).toHaveAttribute('data-panel-tab', 'true')
    expect(screen.getByRole('combobox', { name: 'Selected panel model' })).toHaveValue(panels[0]?.id)
    expect(screen.getByRole('region', { name: /preview/ })).toBeInTheDocument()

    return userEvent.setup().click(screen.getByRole('button', { name: '+ Panel' })).then(() => {
      expect(onAddPanel).toHaveBeenCalledWith(panels[0])
    })
  })

  it('searches by code, clears the selected model, and emits null', async () => {
    const user = userEvent.setup()
    const onPanelSelect = vi.fn<(panel: PanelSpec | null) => void>()
    render(<PanelChooser panels={panels} onPanelSelect={onPanelSelect} />)

    await user.clear(screen.getByRole('searchbox', { name: 'Search panels' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search panels' }), 'JAM60S10')
    const cards = screen.getByRole('list', { name: 'Available panel models' })
    expect(within(cards).getByText('JAM60S10')).toBeInTheDocument()
    expect(within(cards).queryByText('JAM72S30')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear selected model' }))
    expect(onPanelSelect).toHaveBeenLastCalledWith(null)
    expect(screen.getByRole('combobox', { name: 'Selected panel model' })).toHaveValue('')
  })

  it('supports controlled selection and selecting a different model', async () => {
    const user = userEvent.setup()
    const onPanelSelect = vi.fn<(panel: PanelSpec | null) => void>()
    const selected = panels[1]
    if (selected === undefined) throw new Error('fixture panel is missing')
    render(<PanelChooser panels={panels} selectedPanelId={selected.id} onPanelSelect={onPanelSelect} />)

    const cardList = screen.getByRole('list', { name: 'Available panel models' })
    await user.click(within(cardList).getByRole('button', { name: /JA Solar.*JAM72S30/ }))
    expect(onPanelSelect).toHaveBeenCalledWith(panels[0])
    expect(screen.getByRole('combobox', { name: 'Selected panel model' })).toHaveValue(selected.id)
  })

  it('creates a custom panel from the chooser flow and selects it', { timeout: 10_000 }, async () => {
    const user = userEvent.setup()
    const onCreateCustomPanel = vi.fn<(panel: PanelSpec) => void>()
    render(<PanelChooser panels={panels} onCreateCustomPanel={onCreateCustomPanel} />)

    await user.click(screen.getByRole('button', { name: 'Add custom panel' }))
    await user.type(screen.getByLabelText('Manufacturer'), 'Acme Solar')
    await user.type(screen.getByLabelText('Model'), 'AX-450')
    await user.type(screen.getByLabelText('Length (mm)'), '1722')
    await user.type(screen.getByLabelText('Width (mm)'), '1134')
    await user.type(screen.getByLabelText('Thickness (mm)'), '30')
    await user.type(screen.getByLabelText('Weight (kg)'), '20.5')
    await user.type(screen.getByLabelText('Wattage (W)'), '450')
    await user.type(screen.getByLabelText('Cell count'), '144')
    await user.type(screen.getByLabelText('Efficiency (%)'), '22.4')
    await user.click(screen.getByRole('button', { name: 'Save custom panel' }))

    expect(onCreateCustomPanel).toHaveBeenCalledWith(expect.objectContaining({ model: 'AX-450', wattage: { min: 450, max: 450 } }))
    expect(screen.getByRole('region', { name: /Acme Solar AX-450 preview/ })).toBeInTheDocument()
  })
})
