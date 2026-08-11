import type { PanelDefinition, PanelPlacement, Point3, SurfaceDescriptor } from '../core'
import { computePanelPose } from './math'

export interface ArrayHandleAnchor {
  readonly position: Point3
  readonly panelCount: number
}

export function selectedArrayHandleAnchor(
  placements: readonly PanelPlacement[],
  panelDefinitions: Readonly<Record<string, PanelDefinition>>,
  surfaces: readonly SurfaceDescriptor[],
): ArrayHandleAnchor | undefined {
  const first = placements[0]
  if (first === undefined) return undefined
  const panel = panelDefinitions[first.panelId]
  const surface = surfaces.find((candidate) => candidate.id === first.surfaceId)
  if (panel === undefined || surface === undefined) return undefined
  const compatible = placements.filter((placement) => placement.surfaceId === first.surfaceId)
  if (compatible.length === 0) return undefined
  const localCenter = compatible.reduce((sum, placement) => ({
    x: sum.x + placement.localCenter.x,
    y: sum.y + placement.localCenter.y,
  }), { x: 0, y: 0 })
  const representative: PanelPlacement = {
    ...first,
    localCenter: {
      x: localCenter.x / compatible.length,
      y: localCenter.y / compatible.length,
    },
  }
  const pose = computePanelPose(panel, surface, representative)
  const lift = Math.max(panel.widthM, panel.heightM) * 0.58 + 0.45
  return {
    position: {
      x: pose.center.x + pose.tangentY[0] * lift + pose.normal[0] * 0.08,
      y: pose.center.y + pose.tangentY[1] * lift + pose.normal[1] * 0.08,
      z: pose.center.z + pose.tangentY[2] * lift + pose.normal[2] * 0.08,
    },
    panelCount: compatible.length,
  }
}
