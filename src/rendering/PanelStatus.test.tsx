import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PanelRenderStatus } from './PanelStatus'
import { panelRenderStatusText, summarisePanelRenderItems } from './status'

describe('PanelRenderStatus', () => {
  it('summarises plain render items and exposes a polite accessible status', () => {
    const summary = summarisePanelRenderItems([
      { state: 'selected', source: 'placement', panel: { wattageW: 400 } },
      { state: 'ghost', source: 'placement', panel: { wattageW: 800 } },
      { state: 'ghost', source: 'preview', panel: { wattageW: 0 } },
    ])
    expect(summary).toEqual({ panelCount: 3, selectedCount: 1, previewCount: 1, draggingCount: 1, totalKwp: 1.2 })
    expect(panelRenderStatusText(summary)).toBe('Panel layout: 3 panels · 1 selected · 1 preview · 1 dragging · 1.20 kWp')

    render(<PanelRenderStatus items={[
      { state: 'selected', source: 'placement' },
      { state: 'placed', source: 'placement' },
    ]} />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('status')).toHaveTextContent('Panel layout: 2 panels · 1 selected · 0.00 kWp')
  })
})
