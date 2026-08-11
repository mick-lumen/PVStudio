import type { PanelArray, PanelGroupSettings, PanelPlacement } from '../core'

const settingsForPlacement = (placement: PanelPlacement, inherited: PanelGroupSettings): PanelGroupSettings => ({
  ...inherited,
  orientation: placement.orientation,
  clearanceM: placement.clearanceM,
  tiltDeg: placement.tiltDeg,
  ...(placement.azimuthDeg === undefined ? {} : { azimuthDeg: placement.azimuthDeg }),
})

/**
 * Build the explicit array view used by the editor and persistence boundary.
 * Legacy ungrouped modules are represented as stable single-panel arrays.
 */
export function derivePanelArrays(
  placements: Readonly<Record<string, PanelPlacement>>,
  groupSettings: Readonly<Record<string, PanelGroupSettings>>,
  defaults: PanelGroupSettings,
): readonly PanelArray[] {
  const grouped = new Map<string, PanelPlacement[]>()
  for (const placement of Object.values(placements)) {
    const arrayId = placement.groupId ?? `single:${placement.id}`
    const entries = grouped.get(arrayId) ?? []
    entries.push(placement)
    grouped.set(arrayId, entries)
  }
  return [...grouped.entries()].sort(([first], [second]) => first.localeCompare(second)).flatMap(([id, entries]) => {
    const first = entries[0]
    if (first === undefined) return []
    const inherited = first.groupId === undefined ? defaults : groupSettings[first.groupId] ?? defaults
    return [{
      id,
      surfaceId: first.surfaceId,
      panelId: first.panelId,
      placementIds: entries.map((placement) => placement.id).sort(),
      settings: settingsForPlacement(first, inherited),
    }]
  })
}
