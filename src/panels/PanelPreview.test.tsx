import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PANEL_CATALOG } from '../data'
import { PanelPreview } from './PanelPreview'

describe('PanelPreview', () => {
  it('communicates the empty selection state', () => {
    render(<PanelPreview panel={null} />)

    expect(screen.getByRole('region', { name: 'Panel preview' })).toBeInTheDocument()
    expect(screen.getByText('Select a model to preview its dimensions and specifications.')).toBeInTheDocument()
  })

  it('renders an accessible visual and complete panel specifications', () => {
    const panel = PANEL_CATALOG.find((candidate) => candidate.id === 'ja-solar-jam72s30')
    if (panel === undefined) throw new Error('fixture panel is missing')
    const { container } = render(<PanelPreview panel={panel} />)

    expect(screen.getByRole('region', { name: 'JA Solar JAM72S30 preview' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'JAM72S30 solar panel illustration' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'JAM72S30' })).toBeInTheDocument()
    expect(screen.getByText('JAM72S30', { selector: 'dd' })).toBeInTheDocument()
    expect(screen.getByText('2,278 mm × 1,134 mm × 30 mm')).toBeInTheDocument()
    expect(screen.getByText('27.5 kg')).toBeInTheDocument()
    const visual = container.querySelector<HTMLElement>('.panel-preview__visual')
    expect(visual).not.toBeNull()
    expect(visual?.style.getPropertyValue('--panel-aspect-ratio')).toBe(String(panel.width / panel.length))
    expect(container.querySelectorAll('.panel-preview__cell')).toHaveLength(96)
  })
})
