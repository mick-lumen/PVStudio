import type { ReactNode } from 'react'
import { useMemo } from 'react'
import {
  buildPanelRenderItems,
  groupPanelRenderItems,
  type BuildPanelRenderItemsOptions,
} from './layout'
import { PanelBatch } from './PanelBatch'
import type { PanelLayerInteractionProps } from './types'

export interface PanelLayerProps extends BuildPanelRenderItemsOptions, PanelLayerInteractionProps {
  readonly name?: string
  readonly children?: ReactNode
}

/**
 * R3F scene layer for all panel placements. Store/viewer code supplies only
 * serialisable core records and receives serialisable pointer callback data.
 */
export function PanelLayer(props: PanelLayerProps): ReactNode {
  const {
    placements,
    panelDefinitions,
    surfaces,
    panelVisuals,
    selectedIds,
    draggingIds,
    ghostPlacements,
    autoFillPreview,
    interactivePreview,
    interactionsEnabled = true,
    onPanelSelect,
    onPanelDragStart,
    onPanelDrag,
    onPanelDragEnd,
    children,
    name = 'pv-panel-layer',
  } = props
  const cursorGhostIds = useMemo(
    () => new Set((ghostPlacements ?? []).map((placement) => placement.id)),
    [ghostPlacements],
  )
  const items = useMemo(() => buildPanelRenderItems({
    placements,
    panelDefinitions,
    panelVisuals,
    surfaces,
    selectedIds,
    draggingIds,
    ghostPlacements,
    autoFillPreview,
    interactivePreview,
  }).map((item) => {
    // A cursor ghost or auto-fill candidate is a visual preview, never a
    // pointer target.  A dragged, committed placement remains interactive
    // even while it is rendered in the ghost state, so use the source/id
    // boundary rather than the visual state alone here.
    const isCursorGhost = cursorGhostIds.has(item.id)
    return isCursorGhost || item.source === 'preview' ? { ...item, interactive: false } : item
  }), [autoFillPreview, cursorGhostIds, draggingIds, ghostPlacements, interactivePreview, panelDefinitions, panelVisuals, placements, selectedIds, surfaces])
  const batches = useMemo(() => groupPanelRenderItems(items), [items])

  // While a preview is active, all preview meshes are inert.  This keeps a
  // raycast over a ghost/candidate flowing through to the viewer's packed
  // surface picker.  Existing committed placements remain draggable whenever
  // the caller has enabled panel interactions.
  const panelInteractionsEnabled = interactionsEnabled && !interactivePreview

  return (
    <group name={name}>
      {batches.map((batch) => (
        <PanelBatch
          key={batch.key}
          batch={batch}
          interactionsEnabled={panelInteractionsEnabled}
          onPanelSelect={onPanelSelect}
          onPanelDragStart={onPanelDragStart}
          onPanelDrag={onPanelDrag}
          onPanelDragEnd={onPanelDragEnd}
        />
      ))}
      {children}
    </group>
  )
}

export const PanelRenderer = PanelLayer
export const PanelPlacementLayer = PanelLayer
