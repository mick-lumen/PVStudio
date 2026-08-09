import type {
  PanelDefinition,
  PanelPlacement,
  SurfaceDescriptor,
} from '../core'
import { PANEL_CATALOG, toPanelDefinition, type PanelSpec } from '../data'
import type { PlacementState, PlacementStore } from '../placement'
import type { PanelVisualProperties } from '../rendering'
import type {
  PanelPlacementSummary,
  ShellPanel,
  ShellSurface,
} from '../shell/Shell'
import type { ViewerModelSource } from '../viewer'

/** The canonical catalogue definitions shared by the placement and render layers. */
export const CATALOG_PANEL_DEFINITIONS: readonly PanelDefinition[] = Object.freeze(
  PANEL_CATALOG.map((panel) => toPanelDefinition(panel)),
)

const frameColour = (panel: PanelSpec): number => panel.frameColor === 'black' ? 0x1e252b : 0x4f5f68

/**
 * Preserve catalogue-only visual metadata at the rendering boundary.  Core
 * panel definitions intentionally stay framework-free and do not carry cell
 * grids or frame colours.
 */
export function createPanelVisuals(
  panels: readonly PanelSpec[] = PANEL_CATALOG,
): Readonly<Record<string, Partial<PanelVisualProperties>>> {
  const visuals: Record<string, Partial<PanelVisualProperties>> = {}
  for (const panel of panels) {
    visuals[panel.id] = Object.freeze({ cellCount: panel.cellCount, frameColor: frameColour(panel) })
  }
  return Object.freeze(visuals)
}

export function toShellSurface(surface: SurfaceDescriptor): ShellSurface {
  return {
    id: surface.id,
    area: surface.area,
    usableArea: surface.usableArea,
    azimuthDeg: surface.azimuthDeg,
    tiltDeg: surface.tiltDeg,
    label: surface.id,
  }
}

export function toShellPanel(panel: PanelSpec): ShellPanel {
  return {
    id: panel.id,
    manufacturer: panel.manufacturer,
    model: panel.model,
    wattageW: (panel.wattage.min + panel.wattage.max) / 2,
    efficiencyPct: panel.efficiency,
  }
}

export interface AppPlacementSummary extends PanelPlacementSummary {
  readonly totalKwp: number
}

export interface AppPlacementTotals {
  readonly count: number
  readonly wattageW: number
  readonly kwp: number
}

export interface PlacementTotalsStore {
  totals(ids?: unknown): AppPlacementTotals
}

/** Derive truthful, accessible placement metrics without touching Three.js. */
export function summarisePlacementState(
  state: Readonly<PlacementState>,
  store: PlacementTotalsStore | Pick<PlacementStore, 'totals'>,
): AppPlacementSummary {
  const totals = store.totals()
  const previewCount = state.autoFillPreview?.candidates.length ?? 0
  const draggingCount = state.arrayDrag === undefined && state.manualPlacement === undefined ? 0 : 1
  return {
    count: totals.count,
    selectedCount: state.selectedIds.length,
    previewCount,
    draggingCount,
    totalWattageW: totals.wattageW,
    totalKwp: totals.kwp,
  }
}

export function placementValues(state: Readonly<PlacementState>): readonly PanelPlacement[] {
  return Object.values(state.placements)
}

export type ViewerImportResult =
  | { readonly ok: true; readonly source: ViewerModelSource; readonly obj: File }
  | { readonly ok: false; readonly message: string }

const fileExtension = (file: File): string => {
  const dot = file.name.lastIndexOf('.')
  return dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase()
}

/**
 * Build one renderer-neutral OBJ source from a multi-file selection.  The
 * loader accepts one OBJ, one optional MTL, and any number of image textures;
 * duplicate model/material files are rejected because their pairing is
 * ambiguous at this boundary.
 */
export function buildViewerSourceFromFiles(files: readonly File[]): ViewerImportResult {
  const objFiles = files.filter((file) => fileExtension(file) === 'obj')
  const mtlFiles = files.filter((file) => fileExtension(file) === 'mtl')
  const textures = files.filter((file) => ['jpg', 'jpeg', 'png'].includes(fileExtension(file)))
  if (objFiles.length === 0) return { ok: false, message: 'Import requires one OBJ model file.' }
  if (objFiles.length > 1) return { ok: false, message: 'Choose one OBJ model file; multiple OBJ files are ambiguous.' }
  if (mtlFiles.length > 1) return { ok: false, message: 'Choose one MTL material file; multiple MTL files are ambiguous.' }
  const recognised = new Set([...objFiles, ...mtlFiles, ...textures])
  const unsupported = files.filter((file) => !recognised.has(file))
  if (unsupported.length > 0) {
    const names = unsupported.map((file) => file.name).join(', ')
    return { ok: false, message: `Unsupported import file${unsupported.length === 1 ? '' : 's'}: ${names}` }
  }
  const obj = objFiles[0]
  if (obj === undefined) return { ok: false, message: 'Import requires one OBJ model file.' }
  const mtl = mtlFiles[0]
  const source: ViewerModelSource = {
    obj,
    ...(mtl === undefined ? {} : { mtl }),
    ...(textures.length === 0 ? {} : { textures: Object.freeze([...textures]) }),
    name: obj.name,
  }
  return { ok: true, source, obj }
}
