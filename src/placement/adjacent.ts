import type { PanelDefinition, PanelGroupSettings, PanelPlacement, Point2 } from '../core'
import { orientedFootprint } from './geometry'
import type { AddPlacementInput } from './state'

const POSITION_PRECISION = 1_000_000

const pointKey = (point: Point2): string => `${String(Math.round(point.x * POSITION_PRECISION))}:${String(Math.round(point.y * POSITION_PRECISION))}`

/**
 * Return the empty, immediately-adjacent module positions around an array.
 * Surface boundaries, obstacles and collisions with other arrays are checked
 * by PlacementStore.previewPanel before these positions are displayed.
 */
export function createAdjacentPanelSlots(
  placements: readonly PanelPlacement[],
  panel: PanelDefinition,
  settings: PanelGroupSettings,
): readonly AddPlacementInput[] {
  const anchor = placements[0]
  if (anchor === undefined) return []
  const compatible = placements.filter((placement) => placement.panelId === anchor.panelId
    && placement.surfaceId === anchor.surfaceId
    && placement.orientation === anchor.orientation
    && placement.groupId === anchor.groupId)
  if (compatible.length !== placements.length) return []

  const footprint = orientedFootprint(panel, anchor.orientation)
  const stepX = footprint.widthM + settings.interPanelSpacingM
  const stepY = footprint.heightM + settings.rowSpacingM
  if (!Number.isFinite(stepX) || !Number.isFinite(stepY) || stepX <= 0 || stepY <= 0) return []

  const occupied = new Set(placements.map((placement) => pointKey(placement.localCenter)))
  const candidates = new Map<string, AddPlacementInput>()
  const canonicalOffsets: readonly Point2[] = [
    { x: -stepX, y: 0 },
    { x: stepX, y: 0 },
    { x: 0, y: -stepY },
    { x: 0, y: stepY },
  ]
  const radians = (anchor.azimuthDeg ?? settings.azimuthDeg ?? 0) * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const offsets = canonicalOffsets.map((offset): Point2 => ({
    x: offset.x * cosine - offset.y * sine,
    y: offset.x * sine + offset.y * cosine,
  }))
  for (const placement of placements) {
    for (const offset of offsets) {
      const localCenter = { x: placement.localCenter.x + offset.x, y: placement.localCenter.y + offset.y }
      const key = pointKey(localCenter)
      if (occupied.has(key) || candidates.has(key)) continue
      candidates.set(key, {
        panelId: placement.panelId,
        surfaceId: placement.surfaceId,
        localCenter,
        orientation: placement.orientation,
        clearanceM: placement.clearanceM,
        tiltDeg: placement.tiltDeg,
        ...(placement.azimuthDeg === undefined ? {} : { azimuthDeg: placement.azimuthDeg }),
        ...(placement.groupId === undefined ? {} : { groupId: placement.groupId }),
      })
    }
  }
  return [...candidates.values()]
}
