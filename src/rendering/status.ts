import type { PanelRenderItem } from './layout'

export type PanelRenderStatusItem = Pick<PanelRenderItem, 'state' | 'source'> & {
  readonly panel?: Pick<PanelRenderItem['panel'], 'wattageW'>
}

export interface PanelRenderStatusSummary {
  readonly panelCount: number
  readonly selectedCount: number
  readonly previewCount: number
  readonly draggingCount: number
  readonly totalKwp: number
}

export function summarisePanelRenderItems(
  items: readonly PanelRenderStatusItem[] = [],
): PanelRenderStatusSummary {
  let selectedCount = 0
  let previewCount = 0
  let draggingCount = 0
  let totalKwp = 0
  for (const item of items) {
    if (item.state === 'selected') selectedCount += 1
    if (item.source === 'preview') previewCount += 1
    if (item.state === 'ghost' && item.source === 'placement') draggingCount += 1
    const wattageW = item.panel?.wattageW
    if (wattageW !== undefined && Number.isFinite(wattageW) && wattageW > 0) totalKwp += wattageW / 1000
  }
  return { panelCount: items.length, selectedCount, previewCount, draggingCount, totalKwp: Math.round(totalKwp * 1_000_000) / 1_000_000 }
}

export function panelRenderStatusText(summary: PanelRenderStatusSummary, label = 'Panel layout'): string {
  const panelWord = summary.panelCount === 1 ? 'panel' : 'panels'
  const parts = [`${String(summary.panelCount)} ${panelWord}`]
  if (summary.selectedCount > 0) parts.push(`${String(summary.selectedCount)} selected`)
  if (summary.previewCount > 0) parts.push(`${String(summary.previewCount)} preview`)
  if (summary.draggingCount > 0) parts.push(`${String(summary.draggingCount)} dragging`)
  parts.push(`${(Number.isFinite(summary.totalKwp) && summary.totalKwp >= 0 ? summary.totalKwp : 0).toFixed(2)} kWp`)
  return `${label}: ${parts.join(' · ')}`
}
