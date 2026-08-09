import type { CSSProperties } from 'react'
import { formatWattage, type PanelSpec } from '../data'

export interface PanelPreviewProps {
  readonly panel: PanelSpec | null
  readonly compact?: boolean
}

const formatMillimetres = (value: number): string => `${Math.round(value).toLocaleString()} mm`

/** A lightweight, accessible visual preview used by both chooser and custom-panel flows. */
export function PanelPreview({ panel, compact = false }: PanelPreviewProps) {
  if (panel === null) {
    return (
      <section className="panel-preview panel-preview--empty" aria-label="Panel preview" data-testid="panel-preview">
        <div className="panel-preview__placeholder" aria-hidden="true" />
        <p>Select a model to preview its dimensions and specifications.</p>
      </section>
    )
  }

  const cellCount = Math.min(Math.max(panel.cellCount, 12), 96)
  // CSS aspect-ratio is width / height, while the catalogue stores the
  // module's long and short dimensions separately in millimetres.
  const aspectRatio = panel.width / Math.max(panel.length, 1)
  const visualStyle = {
    '--panel-aspect-ratio': String(aspectRatio),
  } as CSSProperties

  return (
    <section className={`panel-preview${compact ? ' panel-preview--compact' : ''}`} aria-label={`${panel.manufacturer} ${panel.model} preview`} data-testid="panel-preview">
      <div className="panel-preview__visual-wrap">
        <div className="panel-preview__visual" style={visualStyle} role="img" aria-label={`${panel.model} solar panel illustration`}>
          {Array.from({ length: cellCount }, (_, index) => <span className="panel-preview__cell" key={index} aria-hidden="true" />)}
        </div>
        <span className="panel-preview__dimension panel-preview__dimension--long" aria-hidden="true">{formatMillimetres(panel.length)}</span>
        <span className="panel-preview__dimension panel-preview__dimension--wide" aria-hidden="true">{formatMillimetres(panel.width)}</span>
      </div>
      <div className="panel-preview__heading">
        <div>
          <p className="panel-preview__eyebrow">{panel.manufacturer}</p>
          <h3>{panel.model}</h3>
        </div>
        <strong>{formatWattage(panel.wattage)}</strong>
      </div>
      <dl className="panel-preview__specs">
        <div><dt>Code</dt><dd>{panel.code}</dd></div>
        <div><dt>Dimensions</dt><dd>{formatMillimetres(panel.length)} × {formatMillimetres(panel.width)} × {formatMillimetres(panel.thickness)}</dd></div>
        <div><dt>Weight</dt><dd>{panel.weight.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</dd></div>
        <div><dt>Cells</dt><dd>{panel.cellCount} · {panel.cellType}</dd></div>
        <div><dt>Efficiency</dt><dd>{panel.efficiency.toLocaleString(undefined, { maximumFractionDigits: 1 })}%</dd></div>
        <div><dt>STC</dt><dd>{panel.stcRating.irradianceWPerM2.toLocaleString()} W/m² · {panel.stcRating.cellTemperatureC}°C · AM {panel.stcRating.airMass}</dd></div>
      </dl>
    </section>
  )
}
