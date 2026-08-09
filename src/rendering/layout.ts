import type {
  AutoFillPreview,
  PanelDefinition,
  PanelPlacement,
  SurfaceDescriptor,
  SurfaceEdge,
  SurfaceEdgeMetadata,
} from '../core'
import { isAutoFillCandidate, isPanelPlacement } from '../core'
import { computePanelPose, type PanelPose } from './math'
import {
  DEFAULT_PANEL_VISUAL_PROPERTIES,
  type PanelVisualProperties,
  type PanelVisualState,
} from './materials'

export type DefinitionCollection =
  | readonly PanelDefinition[]
  | Readonly<Record<string, PanelDefinition>>

export type SurfaceCollection =
  | readonly SurfaceDescriptor[]
  | Readonly<Record<string, SurfaceDescriptor>>

export type SurfaceEdgeCollection =
  | readonly SurfaceEdge[]
  | Readonly<Record<string, SurfaceEdge | null>>

/** Partial catalogue visual metadata keyed by canonical panel id. */
export type PanelVisualCollection = Readonly<Record<string, Partial<PanelVisualProperties>>>

export interface PanelRenderItem {
  readonly id: string
  readonly placement: PanelPlacement
  readonly panel: PanelDefinition
  readonly surface: SurfaceDescriptor
  readonly pose: PanelPose
  readonly visuals: PanelVisualProperties
  readonly cellColumns: number
  readonly cellRows: number
  readonly state: PanelVisualState
  readonly source: 'placement' | 'preview'
  readonly interactive: boolean
}

export interface PanelRenderBatch {
  readonly key: string
  readonly state: PanelVisualState
  readonly items: readonly PanelRenderItem[]
  readonly widthM: number
  readonly heightM: number
  readonly thicknessM: number
  readonly visuals: PanelVisualProperties
  readonly cellColumns: number
  readonly cellRows: number
  /** Stable geometry identity; visual state and item count are deliberately excluded. */
  readonly geometryKey: string
}

export interface BuildPanelRenderItemsOptions {
  readonly placements?: readonly PanelPlacement[]
  readonly panelDefinitions: DefinitionCollection
  readonly surfaces: SurfaceCollection
  /** Optional typed roof-edge metadata keyed by surface id. */
  readonly surfaceEdges?: SurfaceEdgeCollection
  readonly panelVisuals?: PanelVisualCollection
  readonly selectedIds?: readonly string[]
  readonly draggingIds?: readonly string[]
  readonly ghostPlacements?: readonly PanelPlacement[]
  readonly autoFillPreview?: AutoFillPreview
  readonly interactivePreview?: boolean
}

const isArrayCollection = <T extends { readonly id: string }>(value: readonly T[] | Readonly<Record<string, T>>): value is readonly T[] => Array.isArray(value)

const collectionMap = <T extends { readonly id: string }>(collection: readonly T[] | Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
  if (isArrayCollection(collection)) {
    return Object.fromEntries(collection.map((entry) => [entry.id, entry]))
  }
  return collection
}

const isSurfaceEdgeList = (value: SurfaceEdgeCollection): value is readonly SurfaceEdge[] => Array.isArray(value)

const surfaceEdgeMap = (collection: SurfaceEdgeCollection): Readonly<Record<string, SurfaceEdge | null>> => {
  if (isSurfaceEdgeList(collection)) return Object.fromEntries(collection.map((edge) => [edge.surfaceId, edge]))
  return collection
}

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0

const finiteIntegerAtLeast = (value: number, minimum: number): boolean => Number.isInteger(value) && value >= minimum

const colour = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isInteger(value) && value >= 0 && value <= 0xffffff ? value : fallback

const integerOr = (value: number | undefined, fallback: number, minimum: number): number =>
  value !== undefined && finiteIntegerAtLeast(value, minimum) ? value : fallback

const deriveGrid = (cellCount: number | undefined, widthM: number, heightM: number): { readonly columns: number; readonly rows: number } => {
  if (cellCount === undefined || !finiteIntegerAtLeast(cellCount, 4)) {
    return { columns: DEFAULT_PANEL_VISUAL_PROPERTIES.cellColumns, rows: DEFAULT_PANEL_VISUAL_PROPERTIES.cellRows }
  }
  const targetRows = Math.max(2, Math.round(Math.sqrt(cellCount * heightM / widthM)))
  let rows = targetRows
  while (rows > 2 && cellCount % rows !== 0) rows -= 1
  const columns = Math.max(2, Math.floor(cellCount / rows))
  return rows * columns === cellCount
    ? { columns, rows }
    : { columns: DEFAULT_PANEL_VISUAL_PROPERTIES.cellColumns, rows: DEFAULT_PANEL_VISUAL_PROPERTIES.cellRows }
}

const panelExtras = (panel: PanelDefinition): Readonly<Record<string, unknown>> => panel as unknown as Readonly<Record<string, unknown>>

const resolveVisualProperties = (
  panel: PanelDefinition,
  collection: PanelVisualCollection | undefined,
): PanelVisualProperties => {
  const extras = panelExtras(panel)
  const supplied = collection?.[panel.id] ?? {}
  const catalogCellCount = typeof extras.cellCount === 'number' ? extras.cellCount : undefined
  const cellCount = typeof supplied.cellCount === 'number' ? supplied.cellCount : catalogCellCount
  const derived = deriveGrid(cellCount, panel.widthM, panel.heightM)
  const frameExtra = extras.frameColor
  const frameFromCatalog = frameExtra === 'black' ? 0x1e252b : frameExtra === 'silver' ? DEFAULT_PANEL_VISUAL_PROPERTIES.frameColor : undefined
  const rawColumns = supplied.cellColumns
  const rawRows = supplied.cellRows
  const columns = integerOr(rawColumns, derived.columns, 2)
  const rows = integerOr(rawRows, derived.rows, 2)
  return Object.freeze({
    cellCount: integerOr(cellCount, columns * rows, 4),
    cellColumns: columns,
    cellRows: rows,
    cellLineWidthM: supplied.cellLineWidthM !== undefined && finitePositive(supplied.cellLineWidthM)
      ? supplied.cellLineWidthM
      : DEFAULT_PANEL_VISUAL_PROPERTIES.cellLineWidthM,
    frameColor: colour(supplied.frameColor, frameFromCatalog ?? DEFAULT_PANEL_VISUAL_PROPERTIES.frameColor),
    glassColor: colour(supplied.glassColor, DEFAULT_PANEL_VISUAL_PROPERTIES.glassColor),
    cellColor: colour(supplied.cellColor, DEFAULT_PANEL_VISUAL_PROPERTIES.cellColor),
    outlineColor: colour(supplied.outlineColor, DEFAULT_PANEL_VISUAL_PROPERTIES.outlineColor),
  })
}

const panelGrid = (visuals: PanelVisualProperties, orientation: PanelPlacement['orientation']): { readonly columns: number; readonly rows: number } =>
  orientation === 'portrait'
    ? { columns: visuals.cellColumns, rows: visuals.cellRows }
    : { columns: visuals.cellRows, rows: visuals.cellColumns }

const makeGeometryKey = (item: PanelRenderItem): string => [
  item.panel.id,
  item.panel.manufacturer,
  item.panel.model,
  item.pose.footprint.widthM,
  item.pose.footprint.heightM,
  item.pose.thicknessM,
  item.visuals.cellColumns,
  item.visuals.cellRows,
  item.cellColumns,
  item.cellRows,
  item.visuals.cellLineWidthM,
  item.visuals.frameColor,
  item.visuals.glassColor,
  item.visuals.cellColor,
  item.visuals.outlineColor,
].map((value) => typeof value === 'number' ? value.toPrecision(12) : value).join(':')

const ids = (values: readonly string[] | undefined): ReadonlySet<string> => new Set(values ?? [])

const validPlacement = (placement: unknown): placement is PanelPlacement =>
  isPanelPlacement(placement)
  && placement.tiltDeg >= 0
  && placement.tiltDeg <= 90

const appendItem = (
  target: PanelRenderItem[],
  placement: PanelPlacement,
  panel: PanelDefinition | undefined,
  surface: SurfaceDescriptor | undefined,
  panelVisuals: PanelVisualCollection | undefined,
  surfaceEdge: SurfaceEdgeMetadata | null | undefined,
  state: PanelVisualState,
  source: PanelRenderItem['source'],
  interactive: boolean,
): void => {
  if (panel === undefined || surface === undefined || !validPlacement(placement)) return
  if (!finitePositive(panel.widthM) || !finitePositive(panel.heightM) || !finitePositive(panel.thicknessM)) return
  const visuals = resolveVisualProperties(panel, panelVisuals)
  const grid = panelGrid(visuals, placement.orientation)
  target.push({
    id: placement.id,
    placement,
    panel,
    surface,
    pose: computePanelPose(panel, surface, placement, surfaceEdge),
    visuals,
    cellColumns: grid.columns,
    cellRows: grid.rows,
    state,
    source,
    interactive,
  })
}

/**
 * Convert plain placements and auto-fill candidates into render-ready records.
 * Invalid references are ignored at this boundary so a stale persisted layout
 * cannot crash a Three.js scene.
 */
export function buildPanelRenderItems(options: BuildPanelRenderItemsOptions): readonly PanelRenderItem[] {
  const panels = collectionMap(options.panelDefinitions)
  const surfaces = collectionMap(options.surfaces)
  const surfaceEdges = options.surfaceEdges === undefined ? {} : surfaceEdgeMap(options.surfaceEdges)
  const selected = ids(options.selectedIds)
  const dragging = ids(options.draggingIds)
  const result: PanelRenderItem[] = []
  const seen = new Set<string>()
  for (const placement of options.placements ?? []) {
    if (!validPlacement(placement)) continue
    if (seen.has(placement.id)) continue
    const state: PanelVisualState = dragging.has(placement.id) ? 'ghost' : selected.has(placement.id) ? 'selected' : 'placed'
    const surface = surfaces[placement.surfaceId]
    appendItem(result, placement, panels[placement.panelId], surface, options.panelVisuals, surface === undefined ? undefined : surfaceEdges[surface.id], state, 'placement', true)
    if (result[result.length - 1]?.id === placement.id) seen.add(placement.id)
  }
  for (const placement of options.ghostPlacements ?? []) {
    if (!validPlacement(placement)) continue
    if (seen.has(placement.id)) continue
    const surface = surfaces[placement.surfaceId]
    appendItem(result, placement, panels[placement.panelId], surface, options.panelVisuals, surface === undefined ? undefined : surfaceEdges[surface.id], 'ghost', 'placement', true)
    if (result[result.length - 1]?.id === placement.id) seen.add(placement.id)
  }
  const preview = options.autoFillPreview
  if (preview !== undefined) {
    const panel = panels[preview.request.panelId]
    const surface = surfaces[preview.request.surfaceId]
    for (const candidate of preview.candidates) {
      if (!isAutoFillCandidate(candidate)) continue
      if (seen.has(candidate.id)) continue
      const placement: PanelPlacement = {
        id: candidate.id,
        panelId: preview.request.panelId,
        surfaceId: preview.request.surfaceId,
        localCenter: candidate.localCenter,
        orientation: candidate.orientation,
        clearanceM: candidate.clearanceM,
        tiltDeg: candidate.tiltDeg,
        ...(candidate.groupId === undefined ? {} : { groupId: candidate.groupId }),
      }
      const surfaceEdge = preview.request.edge === undefined
        ? (surface === undefined ? undefined : surfaceEdges[surface.id])
        : preview.request.edge
      appendItem(result, placement, panel, surface, options.panelVisuals, surfaceEdge, 'ghost', 'preview', options.interactivePreview ?? false)
      if (result[result.length - 1]?.id === candidate.id) seen.add(candidate.id)
    }
  }
  return result
}

export const createPanelRenderItems = buildPanelRenderItems

/** Group by static geometry/visual identity; dynamic state stays in instance matrices. */
export function groupPanelRenderItems(items: readonly PanelRenderItem[]): readonly PanelRenderBatch[] {
  const groups = new Map<string, PanelRenderItem[]>()
  for (const item of items) {
    const key = makeGeometryKey(item)
    const current = groups.get(key)
    if (current === undefined) groups.set(key, [item])
    else current.push(item)
  }
  return [...groups.entries()].map(([key, grouped]) => {
    const first = grouped[0]
    if (first === undefined) throw new Error('Panel render batch cannot be empty')
    return {
      key,
      state: first.state,
      items: grouped,
      widthM: first.pose.footprint.widthM,
      heightM: first.pose.footprint.heightM,
      thicknessM: first.pose.thicknessM,
      visuals: first.visuals,
      cellColumns: first.cellColumns,
      cellRows: first.cellRows,
      geometryKey: key,
    }
  })
}

export const buildPanelBatches = groupPanelRenderItems

/** Stable mapping used by instanced pointer events (`instanceId` -> placement id). */
export function createInstanceIdMap(items: readonly PanelRenderItem[]): ReadonlyMap<number, string> {
  return new Map(items.map((item, index) => [index, item.id]))
}

export const instanceIdToPlacementId = createInstanceIdMap

export function resolveInstanceId(
  instanceId: number | undefined,
  items: readonly PanelRenderItem[],
): PanelRenderItem | undefined {
  if (instanceId === undefined || !Number.isInteger(instanceId) || instanceId < 0) return undefined
  return items[instanceId]
}
