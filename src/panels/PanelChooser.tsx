import { useMemo, useState, type ChangeEvent } from 'react'
import {
  CELL_TYPES,
  PANEL_CATALOG,
  filterPanelCatalog,
  getManufacturers,
  type CellType,
  type PanelSpec,
} from '../data'
import { CustomPanelForm } from './CustomPanelForm'
import { PanelPreview } from './PanelPreview'
import './panelChooser.css'

export interface PanelChooserProps {
  /** Supply another validated catalogue in tests or an application host. */
  readonly panels?: readonly PanelSpec[]
  /** Controlled selected model. Pass null to explicitly clear the selection. */
  readonly selectedPanelId?: string | null
  readonly onPanelSelect?: (panel: PanelSpec | null) => void
  /** Called when the user presses the OpenSolar-style "+ Panel" action. */
  readonly onAddPanel?: (panel: PanelSpec) => void
  readonly onCreateCustomPanel?: (panel: PanelSpec) => void
  readonly className?: string
}

const selectedFromId = (panels: readonly PanelSpec[], id: string | null | undefined): PanelSpec | null =>
  id === null || id === undefined ? null : panels.find((panel) => panel.id === id) ?? null

/** The panel-tab chooser used by the shell's left panel context. */
export function PanelChooser({
  panels = PANEL_CATALOG,
  selectedPanelId,
  onPanelSelect,
  onAddPanel,
  onCreateCustomPanel,
  className = '',
}: PanelChooserProps) {
  const [customPanels, setCustomPanels] = useState<PanelSpec[]>([])
  const allPanels = useMemo(() => [...panels, ...customPanels], [customPanels, panels])
  const [query, setQuery] = useState('')
  const [manufacturer, setManufacturer] = useState('')
  const [cellType, setCellType] = useState<CellType | ''>('')
  const [showCustomForm, setShowCustomForm] = useState(false)
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(() => allPanels[0]?.id ?? null)
  const isControlled = selectedPanelId !== undefined
  const activeId = isControlled ? selectedPanelId : internalSelectedId
  const selectedPanel = selectedFromId(allPanels, activeId)

  const visiblePanels = useMemo(
    () => filterPanelCatalog(allPanels, { query, manufacturer: manufacturer || undefined, cellType: cellType || undefined }),
    [allPanels, cellType, manufacturer, query],
  )
  const manufacturers = useMemo(() => getManufacturers(allPanels), [allPanels])
  const selectPanel = (panel: PanelSpec | null): void => {
    if (!isControlled) setInternalSelectedId(panel?.id ?? null)
    onPanelSelect?.(panel)
  }
  const chooseById = (event: ChangeEvent<HTMLSelectElement>): void => {
    selectPanel(selectedFromId(allPanels, event.currentTarget.value || null))
  }
  const saveCustomPanel = (panel: PanelSpec): void => {
    setCustomPanels((current) => [...current, panel])
    setShowCustomForm(false)
    selectPanel(panel)
    onCreateCustomPanel?.(panel)
  }
  const modelOptions = selectedPanel !== null && !visiblePanels.some((panel) => panel.id === selectedPanel.id)
    ? [selectedPanel, ...visiblePanels]
    : visiblePanels

  return (
    <aside className={`panel-chooser ${className}`.trim()} aria-label="Panel" data-panel-tab="true" data-testid="panel-chooser">
      <header className="panel-chooser__header">
        <div>
          <p className="panel-chooser__eyebrow">Design library</p>
          <h2>Panel</h2>
        </div>
        <button type="button" className="panel-button panel-button--quiet panel-button--small" onClick={() => { setShowCustomForm((current) => !current) }}>
          {showCustomForm ? 'Close' : 'Add custom'}
        </button>
      </header>

      {showCustomForm ? (
        <CustomPanelForm
          onSubmit={saveCustomPanel}
          onCancel={() => { setShowCustomForm(false) }}
          existingPanelIds={allPanels.map((panel) => panel.id)}
        />
      ) : (
        <>
          <div className="panel-chooser__model-row">
            <label htmlFor="panel-model-select">Model</label>
            <div className="panel-chooser__model-control">
              <select id="panel-model-select" aria-label="Selected panel model" value={selectedPanel?.id ?? ''} onChange={chooseById}>
                <option value="">Choose a panel model</option>
                {modelOptions.map((panel) => <option key={panel.id} value={panel.id}>{panel.manufacturer} · {panel.model} · {panel.wattage.min}–{panel.wattage.max} W</option>)}
              </select>
              {selectedPanel === null ? null : <button type="button" className="panel-chooser__clear" onClick={() => { selectPanel(null) }} aria-label="Clear selected model" title="Clear selected model">×</button>}
            </div>
          </div>
          <div className="panel-chooser__filters">
            <label className="panel-chooser__search" htmlFor="panel-search">
              <span className="sr-only">Search panels</span>
              <input id="panel-search" type="search" value={query} onChange={(event) => { setQuery(event.currentTarget.value) }} placeholder="Search manufacturer, model, or code" />
            </label>
            <label className="sr-only" htmlFor="panel-manufacturer">Filter manufacturer</label>
            <select id="panel-manufacturer" aria-label="Filter manufacturer" value={manufacturer} onChange={(event) => { setManufacturer(event.currentTarget.value) }}>
              <option value="">All manufacturers</option>
              {manufacturers.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <label className="sr-only" htmlFor="panel-cell-type">Filter cell technology</label>
            <select id="panel-cell-type" aria-label="Filter cell technology" value={cellType} onChange={(event) => { setCellType(event.currentTarget.value as CellType | '') }}>
              <option value="">All technologies</option>
              {CELL_TYPES.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>

          <div className="panel-chooser__result-meta" aria-live="polite">
            <span>{visiblePanels.length} {visiblePanels.length === 1 ? 'model' : 'models'}</span>
            {selectedPanel === null ? <span>No model selected</span> : <span>{selectedPanel.manufacturer} {selectedPanel.model}</span>}
          </div>
          <div className="panel-chooser__cards" role="list" aria-label="Available panel models">
            {visiblePanels.length === 0 ? <p className="panel-chooser__empty">No panels match those filters.</p> : visiblePanels.map((panel) => (
              <button
                type="button"
                className={`panel-chooser__card${selectedPanel?.id === panel.id ? ' panel-chooser__card--selected' : ''}`}
                key={panel.id}
                aria-pressed={selectedPanel?.id === panel.id}
                onClick={() => { selectPanel(panel) }}
              >
                <span className="panel-chooser__card-swatch" aria-hidden="true" />
                <span className="panel-chooser__card-copy"><strong>{panel.manufacturer}</strong><span>{panel.model}</span><small>{panel.code} · {panel.wattage.min}–{panel.wattage.max} W</small></span>
                {selectedPanel?.id === panel.id ? <span className="panel-chooser__card-check" aria-label="Selected">✓</span> : null}
              </button>
            ))}
          </div>

          <PanelPreview panel={selectedPanel} />
          <div className="panel-chooser__actions">
            <button type="button" className="panel-button panel-button--primary" disabled={selectedPanel === null} onClick={() => { if (selectedPanel !== null) onAddPanel?.(selectedPanel) }}>+ Panel</button>
            <button type="button" className="panel-button panel-button--quiet" onClick={() => { setShowCustomForm(true) }}>Add custom panel</button>
          </div>
        </>
      )}
    </aside>
  )
}
