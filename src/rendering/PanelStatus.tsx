import type { CSSProperties, ReactNode } from 'react'
import { panelRenderStatusText, summarisePanelRenderItems, type PanelRenderStatusItem, type PanelRenderStatusSummary } from './status'

export interface PanelRenderStatusProps {
  /** Render items are accepted as plain data, making this useful outside Canvas. */
  readonly items?: readonly PanelRenderStatusItem[]
  readonly panelCount?: number
  readonly selectedCount?: number
  readonly previewCount?: number
  readonly draggingCount?: number
  readonly totalKwp?: number
  readonly label?: string
  readonly className?: string
  readonly style?: CSSProperties
}

/** Accessible DOM status for use beside (not inside) the R3F Canvas. */
export function PanelRenderStatus({
  items,
  panelCount,
  selectedCount,
  previewCount,
  draggingCount,
  totalKwp,
  label = 'Panel layout',
  className,
  style,
}: PanelRenderStatusProps): ReactNode {
  const derived = summarisePanelRenderItems(items)
  const summary: PanelRenderStatusSummary = {
    panelCount: panelCount ?? derived.panelCount,
    selectedCount: selectedCount ?? derived.selectedCount,
    previewCount: previewCount ?? derived.previewCount,
    draggingCount: draggingCount ?? derived.draggingCount,
    totalKwp: totalKwp ?? derived.totalKwp,
  }
  return (
    <div
      className={className}
      data-panel-render-status="true"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={style}
    >
      {panelRenderStatusText(summary, label)}
    </div>
  )
}

export const PanelLayerStatus = PanelRenderStatus
