import { unzip, type Unzipped } from 'fflate'
import type {
  PanelDefinition,
  PanelPlacement,
  SurfaceDescriptor,
} from '../core'
import { PANEL_CATALOG, toPanelDefinition, type PanelSpec } from '../data'
import type { PlacementState } from '../placement'
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

const surfaceDirection = (azimuthDeg: number): string | undefined => {
  if (!Number.isFinite(azimuthDeg)) return undefined
  const normalized = ((azimuthDeg % 360) + 360) % 360
  const directions = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'] as const
  const index = Math.round(normalized / 45) % directions.length
  return directions[index]
}

/**
 * Surface ids are renderer UUIDs and are useful only for internal joins. Keep
 * them out of the shell copy by deriving a stable label from the geometric
 * metadata that the viewer already exposes.
 */
export function formatSurfaceLabel(surface: Pick<SurfaceDescriptor, 'tiltDeg' | 'azimuthDeg'>): string {
  const kind = surface.tiltDeg <= 5 ? 'Ground plane' : surface.tiltDeg >= 80 ? 'Wall' : 'Roof face'
  const direction = kind === 'Ground plane' ? undefined : surfaceDirection(surface.azimuthDeg)
  return direction === undefined ? kind : `${kind} · ${direction}`
}

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
    label: formatSurfaceLabel(surface),
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
  getArrays?(): readonly { readonly id: string; readonly placementIds: readonly string[] }[]
}

/** Derive truthful, accessible placement metrics without touching Three.js. */
export function summarisePlacementState(
  state: Readonly<PlacementState>,
  store: PlacementTotalsStore,
): AppPlacementSummary {
  const totals = store.totals()
  const previewCount = state.autoFillPreview?.candidates.length ?? 0
  const draggingCount = state.arrayDrag === undefined && state.manualPlacement === undefined ? 0 : 1
  const arrays = store.getArrays?.() ?? []
  const selectedGroups = new Set(state.selectedIds.map((id) => {
    const placement = state.placements[id]
    return placement === undefined ? undefined : placement.groupId ?? `single:${placement.id}`
  }).filter((id): id is string => id !== undefined))
  const selectedArray = selectedGroups.size === 1 ? arrays.find((array) => selectedGroups.has(array.id)) : undefined
  return {
    count: totals.count,
    selectedCount: state.selectedIds.length,
    previewCount,
    draggingCount,
    totalWattageW: totals.wattageW,
    totalKwp: totals.kwp,
    arrayCount: arrays.length,
    selectedArrayPanelCount: selectedArray?.placementIds.length ?? 0,
    individualSelectedCount: state.selectedIds.length,
  }
}

export function placementValues(state: Readonly<PlacementState>): readonly PanelPlacement[] {
  return Object.values(state.placements)
}

export type ViewerImportResult =
  | { readonly ok: true; readonly source: ViewerModelSource; readonly obj: File }
  | { readonly ok: false; readonly message: string }

const MAX_ZIP_BYTES = 1_073_741_824
const MAX_ZIP_ENTRIES = 4_096
const MAX_ZIP_EXPANDED_BYTES = 2_147_483_648
const MODEL_FILE_EXTENSIONS = new Set(['obj', 'mtl', 'jpg', 'jpeg', 'png'])

const fileExtension = (file: File): string => {
  const dot = file.name.lastIndexOf('.')
  return dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase()
}

const archiveEntryExtension = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

const archiveEntryBasename = (name: string): string => name.replaceAll('\\', '/').split('/').at(-1) ?? ''

const mediaTypeForExtension = (extension: string): string => {
  switch (extension) {
    case 'obj': return 'model/obj'
    case 'mtl': return 'model/mtl'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    default: return 'application/octet-stream'
  }
}

function unzipArchive(file: File): Promise<Unzipped> {
  const bufferPromise = typeof file.arrayBuffer === 'function'
    ? file.arrayBuffer()
    : new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => {
          reject(reader.error ?? new Error('Unable to read ZIP archive.'))
        }
        reader.onload = () => {
          if (reader.result instanceof ArrayBuffer) resolve(reader.result)
          else reject(new Error('ZIP archive did not produce binary data.'))
        }
        reader.readAsArrayBuffer(file)
      })
  return bufferPromise.then((buffer) => new Promise<Unzipped>((resolve, reject) => {
    let entryCount = 0
    let expandedBytes = 0
    let limitError: string | undefined
    unzip(new Uint8Array(buffer), {
      filter: (entry) => {
        entryCount += 1
        expandedBytes += entry.originalSize
        if (entryCount > MAX_ZIP_ENTRIES) limitError = `ZIP contains more than ${String(MAX_ZIP_ENTRIES)} entries.`
        if (expandedBytes > MAX_ZIP_EXPANDED_BYTES) limitError = 'ZIP expands beyond the 2 GB safety limit.'
        return limitError === undefined && MODEL_FILE_EXTENSIONS.has(archiveEntryExtension(entry.name))
      },
    }, (error, result) => {
      if (limitError !== undefined) reject(new Error(limitError))
      else if (error !== null) reject(error)
      else resolve(result)
    })
  }))
}

async function buildViewerSourceFromZip(file: File): Promise<ViewerImportResult> {
  if (file.size > MAX_ZIP_BYTES) return { ok: false, message: 'ZIP exceeds the 1 GB compressed-file safety limit.' }
  let entries: Unzipped
  try {
    entries = await unzipArchive(file)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown archive error'
    return { ok: false, message: `Unable to open ZIP: ${detail}` }
  }

  const files: File[] = []
  const basenames = new Set<string>()
  for (const [path, bytes] of Object.entries(entries)) {
    const name = archiveEntryBasename(path)
    const extension = archiveEntryExtension(name)
    if (name.length === 0 || !MODEL_FILE_EXTENSIONS.has(extension)) continue
    const key = name.toLowerCase()
    if (basenames.has(key)) {
      return { ok: false, message: `ZIP contains duplicate model resource name: ${name}` }
    }
    basenames.add(key)
    const exactBytes = new Uint8Array(bytes)
    files.push(new File([exactBytes.buffer], name, {
      type: mediaTypeForExtension(extension),
      lastModified: file.lastModified,
    }))
  }
  return buildViewerSourceFromFiles(files)
}

/**
 * Accept either one WebODM ZIP or the traditional extracted OBJ/MTL/texture
 * selection. ZIP expansion uses fflate's asynchronous worker path so a large
 * survey does not synchronously freeze the viewer thread.
 */
export async function buildViewerSourceFromSelection(files: readonly File[]): Promise<ViewerImportResult> {
  const archives = files.filter((file) => fileExtension(file) === 'zip')
  if (archives.length === 0) return buildViewerSourceFromFiles(files)
  if (archives.length > 1 || files.length !== 1) {
    return { ok: false, message: 'Choose one ZIP archive by itself, or select the extracted OBJ/MTL/textures together.' }
  }
  const archive = archives[0]
  if (archive === undefined) return { ok: false, message: 'Choose a ZIP archive to import.' }
  return buildViewerSourceFromZip(archive)
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
    upAxis: 'auto',
  }
  return { ok: true, source, obj }
}
