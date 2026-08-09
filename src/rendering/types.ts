import type { PanelPlacement, Point3 } from '../core'

export interface PanelPointerInfo {
  readonly worldPoint: Point3
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly button: number
  readonly instanceId?: number
}

export type PanelInteractionHandler = (placement: PanelPlacement, info: PanelPointerInfo) => void

export interface PanelLayerInteractionProps {
  /** Disable all panel pointer interception while another scene tool is active. */
  readonly interactionsEnabled?: boolean
  readonly onPanelSelect?: PanelInteractionHandler
  readonly onPanelDragStart?: PanelInteractionHandler
  readonly onPanelDrag?: PanelInteractionHandler
  readonly onPanelDragEnd?: PanelInteractionHandler
}
