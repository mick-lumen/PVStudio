import {
  DEFAULT_PANEL_GROUP_SETTINGS,
  deepFreeze,
  isPanelGroupSettings,
  isPanelDefinition,
  isPanelPlacement,
  isPoint2,
  isRectangularObstacle,
  isSurfaceRegion,
  isSurfaceEdgeType,
  isSurfaceEdgeSide,
  SURFACE_EDGE_DIRECTION_EPSILON,
  type AutoFillCandidate,
  type AutoFillPreview,
  type AutoFillRequest,
  type Orientation,
  type PanelDefinition,
  type PanelGroupSettings,
  type PanelPlacement,
  type Point2,
  type Point3,
  type Rect,
  type RectangularObstacle,
  type SurfaceDescriptor,
  type SurfaceEdgeLine,
  type SurfaceEdgeMetadata,
  type SurfaceEdgeSide,
  type SurfaceEdgeType,
  type SurfaceNormal,
  type SurfaceRegion,
} from '../core'
import {
  boundsOfRegion,
  calculateTotalKwp,
  calculateTotalWattage,
  deriveSurfaceEdgeAxes,
  GEOMETRY_EPSILON,
  generateAutoFill,
  isValidSurfaceDescriptor,
  normaliseRect,
  orientedFootprint,
  orientedFootprintCorners,
  orientedCandidateInsideRegion,
  orientedObstacleOverlap,
  polygonOverlap,
  pointOnSurface,
  rectangleInsideSurfaceRegion,
  rectangleCorners,
  rectanglesOverlap,
  rectanglesOverlapWithSpacing,
} from './geometry'

const isFinitePoint = (point: unknown): point is Point2 => isPoint2(point)
const clonePoint = (point: Point2): Point2 => ({ x: point.x, y: point.y })
const clonePoint3 = (point: Point3): Point3 => ({ x: point.x, y: point.y, z: point.z })
const isOrientation = (value: unknown): value is Orientation => value === 'portrait' || value === 'landscape'
const validString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const isFiniteSelectionPolygon = (value: unknown): value is readonly Point2[] => {
  if (!Array.isArray(value) || value.length < 3 || !value.every(isFinitePoint)) return false
  let signedArea = 0
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]
    const next = value[(index + 1) % value.length]
    if (current === undefined || next === undefined) return false
    signedArea += current.x * next.y - next.x * current.y
  }
  return Math.abs(signedArea) > GEOMETRY_EPSILON
}

const validPanel = (panel: PanelDefinition | undefined): panel is PanelDefinition =>
  panel !== undefined && isPanelDefinition(panel)

const isPanelList = (value: unknown): value is readonly PanelDefinition[] =>
  Array.isArray(value)

const validSettings = (settings: unknown): settings is PanelGroupSettings => isPanelGroupSettings(settings)

type SettingsPatch = Partial<PanelGroupSettings>

const mergeSettings = (base: PanelGroupSettings, patch: unknown): PanelGroupSettings | undefined => {
  const safePatch = typeof patch === 'object' && patch !== null ? patch as SettingsPatch : {}
  // Optional auto-fill controls intentionally distinguish an omitted property
  // (keep the inherited value) from an explicit `undefined` (clear the value).
  // The inspector uses the latter when a user returns a field to its legacy
  // automatic mode. Required settings retain the usual nullish merge below.
  const optionalSetting = <K extends 'modulesPerRow' | 'rowOffsetM' | 'obstacleClearanceM'>(
    key: K,
  ): PanelGroupSettings[K] => Object.prototype.hasOwnProperty.call(safePatch, key)
    ? safePatch[key]
    : base[key]
  const modulesPerRow = optionalSetting('modulesPerRow')
  const rowOffsetM = optionalSetting('rowOffsetM')
  const obstacleClearanceM = optionalSetting('obstacleClearanceM')
  const candidate: PanelGroupSettings = {
    orientation: safePatch.orientation ?? base.orientation,
    interPanelSpacingM: safePatch.interPanelSpacingM ?? base.interPanelSpacingM,
    rowSpacingM: safePatch.rowSpacingM ?? base.rowSpacingM,
    setbackM: safePatch.setbackM ?? base.setbackM,
    clearanceM: safePatch.clearanceM ?? base.clearanceM,
    tiltDeg: safePatch.tiltDeg ?? base.tiltDeg,
    ...(modulesPerRow === undefined ? {} : { modulesPerRow }),
    ...(rowOffsetM === undefined ? {} : { rowOffsetM }),
    ...(obstacleClearanceM === undefined ? {} : { obstacleClearanceM }),
  }
  return validSettings(candidate) ? candidate : undefined
}

const cloneSettings = (settings: PanelGroupSettings): PanelGroupSettings => ({ ...settings })
const settingsEqual = (first: PanelGroupSettings, second: PanelGroupSettings): boolean =>
  first.orientation === second.orientation
  && first.interPanelSpacingM === second.interPanelSpacingM
  && first.rowSpacingM === second.rowSpacingM
  && first.setbackM === second.setbackM
  && first.clearanceM === second.clearanceM
  && first.tiltDeg === second.tiltDeg
  && first.modulesPerRow === second.modulesPerRow
  && first.rowOffsetM === second.rowOffsetM
  && first.obstacleClearanceM === second.obstacleClearanceM
const clonePanel = (panel: PanelDefinition): PanelDefinition => ({ ...panel })
const clonePlacement = (placement: PanelPlacement): PanelPlacement => ({
  ...placement,
  localCenter: clonePoint(placement.localCenter),
})
const cloneObstacle = (obstacle: RectangularObstacle): RectangularObstacle => ({ ...obstacle })
function cloneRegion(region: SurfaceRegion): SurfaceRegion
function cloneRegion(region: unknown): SurfaceRegion | undefined
function cloneRegion(region: unknown): SurfaceRegion | undefined {
  if (!isSurfaceRegion(region)) return undefined
  return 'points' in region
    ? { points: region.points.map(clonePoint) }
    : { ...region }
}

const normalisePlacement = (placement: PanelPlacement): PanelPlacement | undefined => {
  if (!isPanelPlacement(placement) || !validString(placement.id) || !validString(placement.panelId)
    || !validString(placement.surfaceId) || !isFinitePoint(placement.localCenter)
    || !Number.isFinite(placement.tiltDeg) || placement.tiltDeg < 0 || placement.tiltDeg > 90) return undefined
  return clonePlacement(placement)
}

const panelMap = (
  panels: readonly PanelDefinition[] | Readonly<Record<string, PanelDefinition>> | undefined,
): Readonly<Record<string, PanelDefinition>> => {
  const result: Record<string, PanelDefinition> = {}
  if (panels === undefined || !isRecord(panels)) return Object.freeze(result)
  if (isPanelList(panels)) {
    for (const panel of panels) {
      if (validPanel(panel) && validString(panel.id)) result[panel.id] = deepFreeze(clonePanel(panel))
    }
  } else {
    for (const id of Object.keys(panels)) {
      const panel = panels[id]
      if (panel !== undefined && validString(id) && validPanel(panel) && panel.id === id) {
        result[id] = deepFreeze(clonePanel(panel))
      }
    }
  }
  return Object.freeze(result)
}

const isSurfaceList = (value: unknown): value is readonly SurfaceDescriptor[] =>
  Array.isArray(value)

const surfaceMap = (
  surfaces: readonly SurfaceDescriptor[] | Readonly<Record<string, SurfaceDescriptor>> | undefined,
): Readonly<Record<string, SurfaceDescriptor>> => {
  const result: Record<string, SurfaceDescriptor> = {}
  if (surfaces === undefined) return Object.freeze(result)
  const addSurface = (id: unknown, surface: unknown): void => {
    if (!validString(id) || !isValidSurfaceDescriptor(surface) || id !== surface.id) return
    const region = cloneRegion(surface.region)
    const cloned: SurfaceDescriptor = {
      ...surface,
      frame: {
        origin: clonePoint3(surface.frame.origin),
        normal: clonePoint3(surface.frame.normal),
        tangentX: clonePoint3(surface.frame.tangentX),
        tangentY: clonePoint3(surface.frame.tangentY),
      },
      region,
      faceRefs: surface.faceRefs.map((ref) => ({ ...ref, faceIndices: [...ref.faceIndices] })),
      ...(surface.edge === undefined ? {} : {
        edge: {
          type: surface.edge.type,
          direction: clonePoint(surface.edge.direction),
          ...(surface.edge.line === undefined ? {} : {
            line: {
              origin: clonePoint(surface.edge.line.origin),
              direction: clonePoint(surface.edge.line.direction),
            },
          }),
          ...(surface.edge.side === undefined ? {} : { side: surface.edge.side }),
        },
      }),
    }
    result[id] = deepFreeze(cloned)
  }
  if (isSurfaceList(surfaces)) {
    for (const surface of surfaces) addSurface(isRecord(surface) ? surface.id : undefined, surface)
  } else {
    if (!isRecord(surfaces)) return Object.freeze(result)
    for (const id of Object.keys(surfaces)) addSurface(id, surfaces[id])
  }
  return Object.freeze(result)
}

export type GutterLine = SurfaceEdgeLine

export interface SurfaceGutter {
  readonly surfaceId: string
  readonly direction: Point2
  readonly line?: GutterLine
  readonly side?: SurfaceEdgeSide
  /** Omitted by legacy gutter payloads; normalisation defaults to gutter. */
  readonly type?: SurfaceEdgeType
}

type SurfaceGutterOverride = SurfaceGutter | null

const isGutterList = (value: unknown): value is readonly SurfaceGutter[] =>
  Array.isArray(value)

export interface PlacementContext {
  readonly panels?: readonly PanelDefinition[] | Readonly<Record<string, PanelDefinition>>
  readonly surfaces?: readonly SurfaceDescriptor[] | Readonly<Record<string, SurfaceDescriptor>>
  readonly obstacles?: readonly RectangularObstacle[] | Readonly<Record<string, readonly RectangularObstacle[]>>
  readonly surfaceObstacles?: readonly RectangularObstacle[] | Readonly<Record<string, readonly RectangularObstacle[]>>
  readonly gutters?: readonly SurfaceGutter[] | Readonly<Record<string, SurfaceGutterOverride>>
}

export interface PlacementTotals {
  readonly count: number
  readonly wattageW: number
  readonly kwp: number
}

export interface ManualPlacementDraft {
  readonly panelId: string
  readonly surfaceId: string
  readonly localCenter?: Point2
  readonly orientation: Orientation
  readonly clearanceM: number
  readonly tiltDeg: number
  readonly groupId?: string
}

export interface ArrayDragDraft {
  readonly panelId: string
  readonly surfaceId: string
  readonly start: Point2
  readonly end?: Point2
  readonly orientation: Orientation
  readonly groupId?: string
}

export interface AlignState {
  readonly enabled: boolean
  readonly anchorId?: string
}

export interface PlacementSnapshot {
  readonly placements: Readonly<Record<string, PanelPlacement>>
  readonly selectedIds: readonly string[]
  readonly activeSurfaceIds: readonly string[]
  readonly activeSurfaceId?: string
  readonly settings: PanelGroupSettings
  readonly groupSettings: Readonly<Record<string, PanelGroupSettings>>
  readonly nextId: number
  readonly align: AlignState
}

export interface AlignPreview {
  readonly anchorId: string
  readonly placements: readonly PanelPlacement[]
  readonly invalidIds: readonly string[]
  readonly valid: boolean
  readonly reason?: string
}

export interface PlacementState extends PlacementSnapshot {
  readonly manualPlacement?: ManualPlacementDraft
  readonly arrayDrag?: ArrayDragDraft
  readonly autoFillPreview?: AutoFillPreview
  readonly alignPreview?: AlignPreview
  readonly undoDepth: number
  readonly redoDepth: number
}

/**
 * Return the only group represented by the current selection. A selection
 * containing ungrouped placements, no placements, or more than one group is
 * edited through the global defaults instead of accidentally changing one
 * group's settings.
 */
export function editableGroupIdFor(
  state: Pick<PlacementSnapshot, 'placements' | 'selectedIds'>,
): string | undefined {
  const selected = state.selectedIds
    .map((id) => state.placements[id])
    .filter((placement): placement is PanelPlacement => placement !== undefined)
  const first = selected[0]
  const groupId = first?.groupId
  if (groupId === undefined || selected.length === 0) return undefined
  return selected.every((placement) => placement.groupId === groupId) ? groupId : undefined
}

/** Backwards-compatible descriptive alias for hosts that prefer a getter name. */
export const getEditableGroupId = editableGroupIdFor

export interface PlacementStoreOptions extends PlacementContext {
  readonly settings?: Partial<PanelGroupSettings>
  readonly groupSettings?: Readonly<Record<string, Partial<PanelGroupSettings>>>
  readonly initial?: Partial<PlacementSnapshot>
}

export interface AddPlacementInput {
  readonly panelId: string
  readonly surfaceId?: string
  readonly localCenter: Point2
  readonly orientation?: Orientation
  readonly clearanceM?: number
  readonly tiltDeg?: number
  readonly groupId?: string
  readonly id?: string
}

export interface PlacementTransform {
  readonly placement: PanelPlacement
  readonly footprint: { readonly widthM: number; readonly heightM: number }
  readonly worldCenter: Point3
  readonly normal: SurfaceNormal
  readonly gutterDirection: Point2
}

export interface GutterFacingData {
  readonly surfaceId: string
  readonly direction: Point2
  readonly line?: GutterLine
  readonly side?: SurfaceEdgeSide
  readonly orientation: Orientation
  readonly azimuthDeg: number
}

export interface SurfaceEdgeSummary {
  readonly surfaceId: string
  readonly type: SurfaceEdgeType
  readonly label: string
  readonly path: string
  readonly direction: Point2
  readonly line?: GutterLine
  readonly side?: SurfaceEdgeSide
}

const edgeLabel = (type: SurfaceEdgeType): string => type.charAt(0).toUpperCase() + type.slice(1)

export interface AutoFillPreviewOptions {
  readonly panelId: string
  readonly surfaceId: string
  readonly region?: SurfaceRegion
  readonly obstacles?: readonly RectangularObstacle[]
  readonly settings?: Partial<PanelGroupSettings>
  readonly groupId?: string
  readonly edge?: SurfaceEdgeMetadata
}

const cloneManual = (draft: ManualPlacementDraft): ManualPlacementDraft => ({
  ...draft,
  ...(draft.localCenter === undefined ? {} : { localCenter: clonePoint(draft.localCenter) }),
})
const cloneArray = (draft: ArrayDragDraft): ArrayDragDraft => ({
  ...draft,
  start: clonePoint(draft.start),
  ...(draft.end === undefined ? {} : { end: clonePoint(draft.end) }),
})
const cloneCandidate = (candidate: AutoFillCandidate): AutoFillCandidate => ({
  ...candidate,
  localCenter: clonePoint(candidate.localCenter),
  footprint: { ...candidate.footprint },
})
const cloneAutoFillPreview = (preview: AutoFillPreview): AutoFillPreview => ({
  request: {
    ...preview.request,
    region: cloneRegion(preview.request.region),
    obstacles: preview.request.obstacles.map(cloneObstacle),
    settings: cloneSettings(preview.request.settings),
    ...(preview.request.edge === undefined ? {} : {
      edge: {
        type: preview.request.edge.type,
        direction: clonePoint(preview.request.edge.direction),
        ...(preview.request.edge.line === undefined ? {} : {
          line: {
            origin: clonePoint(preview.request.edge.line.origin),
            direction: clonePoint(preview.request.edge.line.direction),
          },
        }),
        ...(preview.request.edge.side === undefined ? {} : { side: preview.request.edge.side }),
      },
    }),
  },
  candidates: preview.candidates.map(cloneCandidate),
  totalWattageW: preview.totalWattageW,
  totalKwp: preview.totalKwp,
})
const cloneAlignPreview = (preview: AlignPreview): AlignPreview => ({
  ...preview,
  placements: preview.placements.map(clonePlacement),
  invalidIds: [...preview.invalidIds],
})

const freezeState = (state: PlacementState): PlacementState => {
  const placements: Record<string, PanelPlacement> = {}
  for (const [id, placement] of Object.entries(state.placements)) placements[id] = deepFreeze(clonePlacement(placement))
  const groupSettings: Record<string, PanelGroupSettings> = {}
  for (const [id, settings] of Object.entries(state.groupSettings)) groupSettings[id] = deepFreeze(cloneSettings(settings))
  return deepFreeze({
    ...state,
    placements: Object.freeze(placements),
    selectedIds: Object.freeze([...state.selectedIds]),
    activeSurfaceIds: Object.freeze([...state.activeSurfaceIds]),
    settings: deepFreeze(cloneSettings(state.settings)),
    groupSettings: Object.freeze(groupSettings),
    align: deepFreeze({ ...state.align }),
    ...(state.manualPlacement === undefined ? {} : { manualPlacement: deepFreeze(cloneManual(state.manualPlacement)) }),
    ...(state.arrayDrag === undefined ? {} : { arrayDrag: deepFreeze(cloneArray(state.arrayDrag)) }),
    ...(state.autoFillPreview === undefined ? {} : { autoFillPreview: deepFreeze(cloneAutoFillPreview(state.autoFillPreview)) }),
    ...(state.alignPreview === undefined ? {} : { alignPreview: deepFreeze(cloneAlignPreview(state.alignPreview)) }),
  })
}

const cloneSnapshot = (snapshot: PlacementSnapshot): PlacementSnapshot => {
  const placements: Record<string, PanelPlacement> = {}
  for (const [id, placement] of Object.entries(snapshot.placements)) placements[id] = clonePlacement(placement)
  const groupSettings: Record<string, PanelGroupSettings> = {}
  for (const [id, settings] of Object.entries(snapshot.groupSettings)) groupSettings[id] = cloneSettings(settings)
  return deepFreeze({
    placements,
    selectedIds: [...snapshot.selectedIds],
    activeSurfaceIds: [...snapshot.activeSurfaceIds],
    ...(snapshot.activeSurfaceId === undefined ? {} : { activeSurfaceId: snapshot.activeSurfaceId }),
    settings: cloneSettings(snapshot.settings),
    groupSettings,
    nextId: snapshot.nextId,
    align: { ...snapshot.align },
  })
}

/** Compare the frozen, JSON-like state graph while treating omitted/undefined
 * optional properties as equivalent. This keeps no-op actions from replacing
 * the useSyncExternalStore snapshot or polluting undo history. */
const equalValue = (first: unknown, second: unknown): boolean => {
  if (Object.is(first, second)) return true
  if (first === null || second === null || typeof first !== 'object' || typeof second !== 'object') return false
  if (Array.isArray(first) || Array.isArray(second)) {
    if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) return false
    return first.every((value, index) => equalValue(value, second[index]))
  }
  const firstRecord = first as Record<string, unknown>
  const secondRecord = second as Record<string, unknown>
  const firstKeys = Object.keys(firstRecord).filter((key) => firstRecord[key] !== undefined)
  const secondKeys = Object.keys(secondRecord).filter((key) => secondRecord[key] !== undefined)
  if (firstKeys.length !== secondKeys.length) return false
  return firstKeys.every((key) => Object.prototype.hasOwnProperty.call(secondRecord, key)
    && equalValue(firstRecord[key], secondRecord[key]))
}

const panelRect = (placement: PanelPlacement, panel: PanelDefinition): Rect => {
  const footprint = orientedFootprint(panel, placement.orientation)
  return {
    x: placement.localCenter.x - footprint.widthM / 2,
    y: placement.localCenter.y - footprint.heightM / 2,
    width: footprint.widthM,
    height: footprint.heightM,
  }
}

/** Convert the backwards-compatible gutter record into the strict edge shape
 * consumed by the oriented placement helpers. */
const edgeMetadataFromGutter = (edge: SurfaceGutter | undefined): SurfaceEdgeMetadata | undefined => {
  if (edge === undefined) return undefined
  const type = edge.type ?? 'gutter'
  return {
    type,
    direction: { ...edge.direction },
    ...(edge.line === undefined ? {} : {
      line: {
        origin: { ...edge.line.origin },
        direction: { ...edge.line.direction },
      },
    }),
    ...(edge.side === undefined ? {} : { side: edge.side }),
  }
}

const expandedObstacle = (obstacle: RectangularObstacle, clearanceM: number): Rect => ({
  x: obstacle.x - clearanceM,
  y: obstacle.y - clearanceM,
  width: obstacle.width + 2 * clearanceM,
  height: obstacle.height + 2 * clearanceM,
})

type SurfaceLookup = (surfaceId: string) => SurfaceDescriptor | undefined
type SurfaceEdgeLookup = (surfaceId: string) => SurfaceEdgeMetadata | undefined

/** Test a pair using the same edge-oriented footprints used by generation. */
const pairwiseSpacingConflict = (
  first: PanelPlacement,
  second: PanelPlacement,
  panelFirst: PanelDefinition,
  panelSecond: PanelDefinition,
  settingsFirst: PanelGroupSettings,
  settingsSecond: PanelGroupSettings,
  surface: SurfaceDescriptor | undefined,
  edge: SurfaceEdgeMetadata | undefined,
): boolean => {
  // Match rectanglesOverlapWithSpacing's inclusive-boundary convention: a
  // pair whose edge gap is exactly the requested spacing remains valid.
  const horizontal = Math.max(0, Math.max(settingsFirst.interPanelSpacingM, settingsSecond.interPanelSpacingM) - 2 * GEOMETRY_EPSILON)
  const vertical = Math.max(0, Math.max(settingsFirst.rowSpacingM, settingsSecond.rowSpacingM) - 2 * GEOMETRY_EPSILON)
  if (surface !== undefined && edge !== undefined) {
    const axes = deriveSurfaceEdgeAxes(edge, surface.region)
    const firstFootprint = orientedFootprint(panelFirst, first.orientation)
    const secondFootprint = orientedFootprint(panelSecond, second.orientation)
    const firstCorners = orientedFootprintCorners(
      first.localCenter,
      firstFootprint.widthM + 2 * horizontal,
      firstFootprint.heightM + 2 * vertical,
      axes,
    )
    const secondCorners = orientedFootprintCorners(
      second.localCenter,
      secondFootprint.widthM,
      secondFootprint.heightM,
      axes,
    )
    return polygonOverlap(firstCorners, secondCorners)
  }
  return rectanglesOverlapWithSpacing(
    panelRect(first, panelFirst),
    panelRect(second, panelSecond),
    horizontal,
    vertical,
  )
}

const pairwiseSpacingValid = (
  placements: readonly PanelPlacement[],
  definitions: Readonly<Record<string, PanelDefinition>>,
  settingsFor: (groupId: string | undefined) => PanelGroupSettings,
  surfaceFor?: SurfaceLookup,
  edgeFor?: SurfaceEdgeLookup,
): boolean => {
  for (let first = 0; first < placements.length; first += 1) {
    const a = placements[first]
    const panelA = a === undefined ? undefined : definitions[a.panelId]
    if (a === undefined || !validPanel(panelA)) return false
    for (let second = first + 1; second < placements.length; second += 1) {
      const b = placements[second]
      const panelB = b === undefined ? undefined : definitions[b.panelId]
      if (b === undefined || !validPanel(panelB) || a.surfaceId !== b.surfaceId) continue
      const settingsA = settingsFor(a.groupId)
      const settingsB = settingsFor(b.groupId)
      if (pairwiseSpacingConflict(
        a,
        b,
        panelA,
        panelB,
        settingsA,
        settingsB,
        surfaceFor?.(a.surfaceId),
        edgeFor?.(a.surfaceId),
      )) return false
    }
  }
  return true
}

/**
 * The auto-fill confirmation path accepts candidates in preview order.  A
 * full pairwise scan for every accepted candidate is needlessly quadratic (and
 * allocates a new array on every iteration).  This broad-phase index stores
 * accepted rectangles in local surface/grid buckets; the exact spacing test is
 * still run for every bucket hit, so the result is identical to
 * `pairwiseSpacingValid` while avoiding distant candidates.
 */
interface SpacingIndexEntry {
  readonly placement: PanelPlacement
  readonly rectangle: Rect
  readonly settings: PanelGroupSettings
}

interface SpacingIndex {
  readonly cellSizeX: number
  readonly cellSizeY: number
  readonly originX: number
  readonly originY: number
  readonly maxInterPanelSpacingM: number
  readonly maxRowSpacingM: number
  readonly cells: Map<string, Map<number, Map<number, SpacingIndexEntry[]>>>
  readonly entries: SpacingIndexEntry[]
  readonly fallbackEntries: SpacingIndexEntry[]
}

interface SpacingCellRange {
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
}

interface AutoFillCandidateCache {
  readonly candidate: AutoFillCandidate
  readonly rectangle: Rect | undefined
  readonly settings: PanelGroupSettings
}

const candidateRectangle = (candidate: AutoFillCandidate, panel: PanelDefinition): Rect | undefined => {
  const footprint = orientedFootprint(panel, candidate.orientation)
  const rectangle: Rect = {
    x: candidate.localCenter.x - footprint.widthM / 2,
    y: candidate.localCenter.y - footprint.heightM / 2,
    width: footprint.widthM,
    height: footprint.heightM,
  }
  return Number.isFinite(rectangle.x) && Number.isFinite(rectangle.y)
    && Number.isFinite(rectangle.width) && Number.isFinite(rectangle.height)
    && rectangle.width > 0 && rectangle.height > 0
    ? rectangle
    : undefined
}

const buildSpacingIndex = (candidates: readonly AutoFillCandidateCache[]): SpacingIndex | undefined => {
  let maxWidth = 0
  let maxHeight = 0
  let maxInterPanelSpacingM = 0
  let maxRowSpacingM = 0
  let originX = Number.POSITIVE_INFINITY
  let originY = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const rectangle = candidate.rectangle
    // A malformed preview candidate must not be silently omitted from the
    // broad phase: an accepted candidate with no cached rectangle would then
    // be invisible to subsequent indexed checks.  Falling back to the exact
    // pairwise path for the whole batch preserves the original semantics.
    if (rectangle === undefined) return undefined
    maxWidth = Math.max(maxWidth, rectangle.width)
    maxHeight = Math.max(maxHeight, rectangle.height)
    maxInterPanelSpacingM = Math.max(maxInterPanelSpacingM, candidate.settings.interPanelSpacingM)
    maxRowSpacingM = Math.max(maxRowSpacingM, candidate.settings.rowSpacingM)
    originX = Math.min(originX, rectangle.x)
    originY = Math.min(originY, rectangle.y)
  }
  const cellSizeX = maxWidth + 2 * maxInterPanelSpacingM
  const cellSizeY = maxHeight + 2 * maxRowSpacingM
  if (!Number.isFinite(cellSizeX) || !Number.isFinite(cellSizeY)
    || cellSizeX <= 0 || cellSizeY <= 0
    || !Number.isFinite(originX) || !Number.isFinite(originY)) return undefined
  return {
    cellSizeX,
    cellSizeY,
    originX,
    originY,
    maxInterPanelSpacingM,
    maxRowSpacingM,
    cells: new Map(),
    entries: [],
    fallbackEntries: [],
  }
}

const spacingCellRange = (rectangle: Rect, index: SpacingIndex): SpacingCellRange | undefined => {
  const minX = rectangle.x - index.maxInterPanelSpacingM
  const maxX = rectangle.x + rectangle.width + index.maxInterPanelSpacingM
  const minY = rectangle.y - index.maxRowSpacingM
  const maxY = rectangle.y + rectangle.height + index.maxRowSpacingM
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) return undefined
  const range = {
    minX: Math.floor((minX - index.originX) / index.cellSizeX),
    maxX: Math.floor((maxX - index.originX) / index.cellSizeX),
    minY: Math.floor((minY - index.originY) / index.cellSizeY),
    maxY: Math.floor((maxY - index.originY) / index.cellSizeY),
  }
  // Coordinates outside the safe integer range cannot be incremented reliably
  // in a bucket loop.  Returning no range makes the caller use its exact
  // fallback scan for that rare, pathological input.
  return Object.values(range).every((value) => Number.isSafeInteger(value)) ? range : undefined
}

const addSpacingIndexEntry = (index: SpacingIndex, entry: SpacingIndexEntry): boolean => {
  index.entries.push(entry)
  const range = spacingCellRange(entry.rectangle, index)
  if (range === undefined || range.maxX - range.minX > 8 || range.maxY - range.minY > 8) return false
  let surfaceCells = index.cells.get(entry.placement.surfaceId)
  if (surfaceCells === undefined) {
    surfaceCells = new Map()
    index.cells.set(entry.placement.surfaceId, surfaceCells)
  }
  for (let cellX = range.minX; cellX <= range.maxX; cellX += 1) {
    let column = surfaceCells.get(cellX)
    if (column === undefined) {
      column = new Map()
      surfaceCells.set(cellX, column)
    }
    for (let cellY = range.minY; cellY <= range.maxY; cellY += 1) {
      const bucket = column.get(cellY)
      if (bucket === undefined) column.set(cellY, [entry])
      else bucket.push(entry)
    }
  }
  return true
}

const spacingIndexHasConflict = (
  index: SpacingIndex,
  placement: PanelPlacement,
  rectangle: Rect,
  settings: PanelGroupSettings,
): boolean => {
  const range = spacingCellRange(rectangle, index)
  const surfaceCells = index.cells.get(placement.surfaceId)
  const checked = new Set<SpacingIndexEntry>()
  const check = (entry: SpacingIndexEntry): boolean => {
    if (checked.has(entry)) return false
    checked.add(entry)
    const horizontal = Math.max(settings.interPanelSpacingM, entry.settings.interPanelSpacingM)
    const vertical = Math.max(settings.rowSpacingM, entry.settings.rowSpacingM)
    return rectanglesOverlapWithSpacing(entry.rectangle, rectangle, horizontal, vertical)
  }
  if (range !== undefined && surfaceCells !== undefined) {
    for (let cellX = range.minX; cellX <= range.maxX; cellX += 1) {
      const column = surfaceCells.get(cellX)
      if (column === undefined) continue
      for (let cellY = range.minY; cellY <= range.maxY; cellY += 1) {
        const bucket = column.get(cellY)
        if (bucket === undefined) continue
        for (const entry of bucket) if (check(entry)) return true
      }
    }
  } else if (range === undefined) {
    for (const entry of index.entries) {
      if (entry.placement.surfaceId === placement.surfaceId && check(entry)) return true
    }
  }
  // An entry can be omitted from the grid only for non-standard, very large
  // coordinates.  Keep an exact fallback list so the index never changes
  // placement acceptance semantics.
  for (const entry of index.fallbackEntries) if (check(entry)) return true
  return false
}

const idsWithout = (ids: readonly string[], excluded: ReadonlySet<string>): readonly string[] => ids.filter((id) => !excluded.has(id))

const allocateGeneratedId = (used: ReadonlySet<string>, start: number): { readonly id: string; readonly nextId: number } => {
  let next = Number.isInteger(start) && start > 0 ? start : 1
  let id = `panel-${String(next)}`
  while (used.has(id)) {
    next += 1
    id = `panel-${String(next)}`
  }
  return { id, nextId: next + 1 }
}

/** Allocate a stable, collision-free group id for a newly generated batch. */
const allocateGeneratedGroupId = (
  placements: Readonly<Record<string, PanelPlacement>>,
  groupSettings: Readonly<Record<string, PanelGroupSettings>>,
  start: number,
): string => {
  const used = new Set<string>(Object.keys(groupSettings))
  for (const placement of Object.values(placements)) {
    if (placement.groupId !== undefined) used.add(placement.groupId)
  }
  let suffix = Number.isInteger(start) && start > 0 ? start : 1
  let groupId = `group-${String(suffix)}`
  while (used.has(groupId)) {
    suffix += 1
    groupId = `group-${String(suffix)}`
  }
  return groupId
}

const validDirection = (direction: unknown): direction is Point2 => isFinitePoint(direction) && Math.hypot(direction.x, direction.y) > SURFACE_EDGE_DIRECTION_EPSILON
const normaliseDirection = (direction: Point2): Point2 => {
  const length = Math.hypot(direction.x, direction.y)
  return { x: direction.x / length, y: direction.y / length }
}

type ObstacleSource = readonly RectangularObstacle[] | Readonly<Record<string, readonly RectangularObstacle[]>>

interface PlacementHistorySnapshot {
  readonly design: PlacementSnapshot
  readonly obstacles?: ObstacleSource
}

const isObstacleList = (source: unknown): source is readonly RectangularObstacle[] => Array.isArray(source)

const cloneObstacleSource = (source: unknown): ObstacleSource | undefined => {
  if (source === undefined) return undefined
  if (isObstacleList(source)) {
    if (!source.every(isRectangularObstacle)) return undefined
    return Object.freeze(source.map((obstacle) => deepFreeze(cloneObstacle(obstacle))))
  }
  if (!isRecord(source)) return undefined
  const result: Record<string, readonly RectangularObstacle[]> = {}
  for (const id of Object.keys(source)) {
    const obstacles = source[id]
    if (!Array.isArray(obstacles) || !obstacles.every(isRectangularObstacle)) return undefined
    result[id] = Object.freeze(obstacles.map((obstacle) => deepFreeze(cloneObstacle(obstacle))))
  }
  return Object.freeze(result)
}

const validPointLine = (line: unknown): line is GutterLine => {
  if (!isRecord(line)) return false
  return validDirection(line.direction) && isFinitePoint(line.origin)
}

const validGutterType = (value: unknown): value is SurfaceEdgeType | undefined => value === undefined || isSurfaceEdgeType(value)
const validGutterSide = (value: unknown): value is SurfaceEdgeSide | undefined => value === undefined || isSurfaceEdgeSide(value)

const normaliseSurfaceEdgeMetadata = (value: unknown): SurfaceEdgeMetadata | undefined => {
  if (!isRecord(value) || !validDirection(value.direction) || !validGutterType(value.type)
    || !validGutterSide(value.side)
    || (value.side !== undefined && value.line === undefined)
    || (value.line !== undefined && !validPointLine(value.line))) return undefined
  const type: SurfaceEdgeType = value.type === undefined ? 'gutter' : value.type
  const direction = normaliseDirection(value.direction)
  const line = value.line
  return {
    type,
    direction,
    ...(line === undefined ? {} : {
      line: {
        origin: clonePoint(line.origin),
        direction: normaliseDirection(line.direction),
      },
    }),
    ...(value.side === undefined ? {} : { side: value.side }),
  }
}

const cloneGutters = (gutters: unknown): Readonly<Record<string, SurfaceGutterOverride>> => {
  const result: Record<string, SurfaceGutterOverride> = {}
  if (gutters === undefined) return Object.freeze(result)
  const addGutter = (id: unknown, gutter: unknown): void => {
    if (!validString(id)) return
    if (gutter === null) {
      result[id] = null
      return
    }
    if (!isRecord(gutter)) return
    if (!validString(id) || id !== gutter.surfaceId || !validDirection(gutter.direction) || !validGutterType(gutter.type)) return
    if (!validGutterSide(gutter.side)
      || (gutter.side !== undefined && gutter.line === undefined)
      || (gutter.line !== undefined && !validPointLine(gutter.line))) return
    result[id] = deepFreeze({
      surfaceId: id,
      type: gutter.type ?? 'gutter',
      direction: normaliseDirection(gutter.direction),
      ...(gutter.line === undefined ? {} : { line: deepFreeze({ origin: clonePoint(gutter.line.origin), direction: normaliseDirection(gutter.line.direction) }) }),
      ...(gutter.side === undefined ? {} : { side: gutter.side }),
    })
  }
  if (isGutterList(gutters)) {
    for (const gutter of gutters) addGutter(isRecord(gutter) ? gutter.surfaceId : undefined, gutter)
  } else {
    if (!isRecord(gutters)) return Object.freeze(result)
    for (const id of Object.keys(gutters)) addGutter(id, gutters[id])
  }
  return Object.freeze(result)
}

/**
 * The store only accepts canonical context values at its public boundaries.
 * Constructors remain forgiving (malformed sources become an empty context),
 * while replacement APIs can reject the input without mutating the design.
 */
const isPanelSource = (value: unknown): boolean => {
  if (value === undefined) return true
  if (isPanelList(value)) return value.every((panel) => validPanel(panel) && validString(panel.id))
  if (!isRecord(value)) return false
  return Object.entries(value).every(([id, panel]) => validString(id) && validPanel(panel as PanelDefinition) && (panel as PanelDefinition).id === id)
}

const isSurfaceSource = (value: unknown): boolean => {
  if (value === undefined) return true
  if (isSurfaceList(value)) return value.every((surface) => isValidSurfaceDescriptor(surface) && isRecord(surface) && surface.id === (surface as SurfaceDescriptor).id)
  if (!isRecord(value)) return false
  return Object.entries(value).every(([id, surface]) => validString(id) && isValidSurfaceDescriptor(surface) && isRecord(surface) && (surface as SurfaceDescriptor).id === id)
}

const isObstacleSource = (value: unknown): boolean => {
  if (value === undefined) return true
  if (isObstacleList(value)) return value.every(isRectangularObstacle)
  if (!isRecord(value)) return false
  return Object.entries(value).every(([id, obstacles]) => validString(id) && Array.isArray(obstacles) && obstacles.every(isRectangularObstacle))
}

const isGutterSource = (value: unknown): boolean => {
  if (value === undefined) return true
  if (isGutterList(value)) return value.every((gutter) => isRecord(gutter)
    && validString(gutter.surfaceId)
    && gutter.surfaceId === (gutter as SurfaceGutter).surfaceId
    && validDirection(gutter.direction)
    && validGutterType(gutter.type)
    && validGutterSide(gutter.side)
    && (gutter.side === undefined || gutter.line !== undefined)
    && (gutter.line === undefined || validPointLine(gutter.line)))
  if (!isRecord(value)) return false
  return Object.entries(value).every(([id, gutter]) => isRecord(gutter)
    ? validString(id)
      && gutter.surfaceId === id
      && validDirection(gutter.direction)
      && validGutterType(gutter.type)
      && validGutterSide(gutter.side)
      && (gutter.side === undefined || gutter.line !== undefined)
      && (gutter.line === undefined || validPointLine(gutter.line))
    : gutter === null && validString(id))
}

interface NormalisedContext {
  readonly definitions: Readonly<Record<string, PanelDefinition>>
  readonly surfaces: Readonly<Record<string, SurfaceDescriptor>>
  readonly gutters: Readonly<Record<string, SurfaceGutterOverride>>
  readonly obstacleSource: ObstacleSource | undefined
  readonly context: PlacementContext
}

const contextFromParts = (
  definitions: Readonly<Record<string, PanelDefinition>>,
  surfaces: Readonly<Record<string, SurfaceDescriptor>>,
  gutters: Readonly<Record<string, SurfaceGutterOverride>>,
  obstacleSource: ObstacleSource | undefined,
): PlacementContext => deepFreeze({
  panels: Object.freeze(Object.values(definitions)),
  surfaces: Object.freeze(Object.values(surfaces)),
  ...(obstacleSource === undefined ? {} : { obstacles: obstacleSource }),
  ...(Object.keys(gutters).length === 0 ? {} : { gutters }),
})

const normaliseContext = (input: unknown): NormalisedContext | undefined => {
  if (!isRecord(input)) return undefined
  const obstacleInput = input.surfaceObstacles ?? input.obstacles
  if (!isPanelSource(input.panels) || !isSurfaceSource(input.surfaces)
    || !isObstacleSource(obstacleInput) || !isGutterSource(input.gutters)) return undefined
  const definitions = panelMap(input.panels as PlacementContext['panels'])
  const surfaces = surfaceMap(input.surfaces as PlacementContext['surfaces'])
  const gutters = cloneGutters(input.gutters)
  const obstacleSource = cloneObstacleSource(obstacleInput)
  if (obstacleInput !== undefined && obstacleSource === undefined) return undefined
  return {
    definitions,
    surfaces,
    gutters,
    obstacleSource,
    context: contextFromParts(definitions, surfaces, gutters, obstacleSource),
  }
}

const withActiveSurface = (state: PlacementState, ids: readonly string[]): PlacementState => {
  const activeSurfaceIds = [...new Set(ids)]
  return {
    ...state,
    activeSurfaceIds,
    ...(activeSurfaceIds[0] === undefined ? { activeSurfaceId: undefined } : { activeSurfaceId: activeSurfaceIds[0] }),
  }
}

export type PlacementStoreListener = () => void

export class PlacementStore {
  private contextValue: PlacementContext
  private definitions: Readonly<Record<string, PanelDefinition>>
  private surfaces: Readonly<Record<string, SurfaceDescriptor>>
  private gutters: Readonly<Record<string, SurfaceGutterOverride>>
  private obstacleSource: ObstacleSource | undefined
  private state: PlacementState
  private undoStack: PlacementHistorySnapshot[]
  private redoStack: PlacementHistorySnapshot[]
  private readonly listeners = new Set<PlacementStoreListener>()

  public constructor(options: unknown = {}) {
    const safeOptions = isRecord(options) ? options as PlacementStoreOptions : {}
    const normalised = normaliseContext(safeOptions) ?? normaliseContext({})
    // The empty context fallback is guaranteed by the literal above.
    this.definitions = normalised?.definitions ?? Object.freeze({})
    this.surfaces = normalised?.surfaces ?? Object.freeze({})
    this.gutters = normalised?.gutters ?? Object.freeze({})
    this.obstacleSource = normalised?.obstacleSource
    this.contextValue = normalised?.context ?? deepFreeze({ panels: Object.freeze([]), surfaces: Object.freeze([]) })
    this.state = this.emptyState(safeOptions)
    this.undoStack = []
    this.redoStack = []
  }

  /** Frozen context data consumed by host/viewer adapters. */
  public get context(): PlacementContext { return this.contextValue }

  /** Subscribe to externally visible state/context changes. */
  public subscribe(listener: PlacementStoreListener): () => void {
    if (typeof listener !== 'function') return () => undefined
    this.listeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.listeners.delete(listener)
    }
  }

  /** Stable snapshot reference for React's useSyncExternalStore contract. */
  public getSnapshot(): Readonly<PlacementState> { return this.state }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private setContext(normalised: NormalisedContext): void {
    this.definitions = normalised.definitions
    this.surfaces = normalised.surfaces
    this.gutters = normalised.gutters
    this.obstacleSource = normalised.obstacleSource
    this.contextValue = normalised.context
  }

  /**
   * Register one new panel definition while retaining placements, selection,
   * transient drafts, and undo history. Existing ids are intentionally not
   * replaced because changing a definition could invalidate stored geometry.
   */
  public registerPanel(panel: unknown): boolean {
    if (!isRecord(panel) || !isPanelDefinition(panel) || !validString(panel.id)) return false
    if (this.definitions[panel.id] !== undefined) return false
    const definition = deepFreeze(clonePanel(panel))
    const definitions = Object.freeze({ ...this.definitions, [definition.id]: definition })
    const context = contextFromParts(definitions, this.surfaces, this.gutters, this.obstacleSource)
    this.definitions = definitions
    this.contextValue = context
    // Context changes are visible through getSnapshot even though design state
    // fields remain equal; do not record this registration in undo history.
    this.state = freezeState({ ...this.state })
    this.notify()
    return true
  }

  /**
   * Replace the obstacle context used by placement validation. Obstacles are
   * user-authored design data, so each effective replacement is one undoable
   * history step alongside panel placement and array edits. Surface-keyed
   * sources must refer to surfaces currently known to the store; malformed
   * sources are rejected without notifying subscribers.
   */
  public setObstacles(source: unknown): boolean {
    if (!isObstacleSource(source)) return false
    if (isRecord(source) && !isObstacleList(source)) {
      for (const id of Object.keys(source)) {
        if (!this.knownSurface(id)) return false
      }
    }
    const next = cloneObstacleSource(source)
    if (source !== undefined && next === undefined) return false
    if (equalValue(this.obstacleSource, next)) return false
    const previous = this.historySnapshot()
    this.obstacleSource = next
    this.contextValue = contextFromParts(this.definitions, this.surfaces, this.gutters, next)
    this.undoStack.push(previous)
    this.redoStack = []
    this.state = freezeState({
      ...this.state,
      manualPlacement: undefined,
      arrayDrag: undefined,
      autoFillPreview: undefined,
      alignPreview: undefined,
      undoDepth: this.undoStack.length,
      redoDepth: 0,
    })
    this.notify()
    return true
  }

  /**
   * Set or remove the selected surface edge. Edge annotations are source
   * context, not design edits: they notify renderers but deliberately do not
   * enter placement undo/redo history. Legacy payloads may omit `type`, which
   * is canonicalised to `gutter` here.
   */
  public setSurfaceEdge(surfaceId: unknown, metadata: unknown): boolean {
    if (!validString(surfaceId) || !this.knownSurface(surfaceId)) return false
    const nextSource: Record<string, SurfaceGutterOverride> = {}
    for (const [id, gutter] of Object.entries(this.gutters)) {
      if (id !== surfaceId) nextSource[id] = gutter
    }
    if (metadata !== undefined) {
      if (!isRecord(metadata)) return false
      if (metadata.surfaceId !== undefined && metadata.surfaceId !== surfaceId) return false
      const candidate = normaliseSurfaceEdgeMetadata(metadata)
      if (candidate === undefined) return false
      nextSource[surfaceId] = {
        surfaceId,
        type: candidate.type,
        direction: candidate.direction,
        ...(candidate.line === undefined ? {} : { line: candidate.line }),
        ...(candidate.side === undefined ? {} : { side: candidate.side }),
      }
    } else {
      // Keep an explicit tombstone so embedded edge metadata cannot silently
      // reappear after a user clears the selected surface's annotation.
      nextSource[surfaceId] = null
    }
    const next = cloneGutters(nextSource)
    if (equalValue(this.gutters, next)) return false
    this.gutters = next
    this.contextValue = contextFromParts(this.definitions, this.surfaces, this.gutters, this.obstacleSource)
    this.state = freezeState({ ...this.state })
    this.notify()
    return true
  }

  /** Read a cloned, immutable edge record for a selected surface. */
  public getSurfaceEdge(surfaceId: unknown): SurfaceGutter | undefined {
    if (!validString(surfaceId)) return undefined
    const edge = this.surfaceEdge(surfaceId)
    if (edge === undefined) return undefined
    return deepFreeze({
      surfaceId: edge.surfaceId,
      type: edge.type ?? 'gutter',
      direction: { ...edge.direction },
      ...(edge.line === undefined ? {} : { line: { origin: { ...edge.line.origin }, direction: { ...edge.line.direction } } }),
      ...(edge.side === undefined ? {} : { side: edge.side }),
    })
  }

  /** Human-readable path used by the shell's selected-edge inspector. */
  public surfaceEdgeSummary(surfaceId: unknown): SurfaceEdgeSummary | undefined {
    const edge = this.getSurfaceEdge(surfaceId)
    if (edge === undefined || !validString(surfaceId)) return undefined
    const type = edge.type ?? 'gutter'
    return deepFreeze({
      surfaceId,
      type,
      label: edgeLabel(type),
      path: `Surface ${surfaceId} › ${edgeLabel(type)}`,
      direction: { ...edge.direction },
      ...(edge.line === undefined ? {} : { line: { origin: { ...edge.line.origin }, direction: { ...edge.line.direction } } }),
      ...(edge.side === undefined ? {} : { side: edge.side }),
    })
  }

  /**
   * Replace the source/project context. A replacement clears placements,
   * selection, drafts, previews, and undo/redo history and restores default
   * settings. Invalid input is rejected without mutating the current design.
   */
  public replaceContext(input: unknown): boolean {
    const normalised = normaliseContext(input)
    if (normalised === undefined) return false
    const contextChanged = !equalValue(this.contextValue, normalised.context)
    const defaultState = this.emptyState({})
    const stateChanged = !equalValue(this.state, defaultState)
      || this.undoStack.length > 0
      || this.redoStack.length > 0
    if (!contextChanged && !stateChanged) return false
    this.setContext(normalised)
    this.undoStack = []
    this.redoStack = []
    this.state = this.emptyState({})
    this.notify()
    return true
  }

  private emptyState(options: PlacementStoreOptions): PlacementState {
    const baseSettings = mergeSettings(DEFAULT_PANEL_GROUP_SETTINGS, options.settings ?? {}) ?? DEFAULT_PANEL_GROUP_SETTINGS
    const initial = isRecord(options.initial) ? options.initial : undefined
    const initialSettings = initial?.settings !== undefined && validSettings(initial.settings) ? initial.settings : baseSettings
    const groupSettings: Record<string, PanelGroupSettings> = {}
    const suppliedGroups = isRecord(options.groupSettings) ? options.groupSettings : {}
    for (const [groupId, patch] of Object.entries(suppliedGroups)) {
      const merged = mergeSettings(initialSettings, patch)
      if (validString(groupId) && merged !== undefined) groupSettings[groupId] = merged
    }
    const initialGroups = initial !== undefined && isRecord(initial.groupSettings) ? initial.groupSettings : {}
    for (const [groupId, settings] of Object.entries(initialGroups)) {
      if (validString(groupId) && validSettings(settings)) groupSettings[groupId] = settings
    }
    const placements: Record<string, PanelPlacement> = {}
    const initialPlacements = initial !== undefined && isRecord(initial.placements) ? initial.placements : {}
    for (const [id, placement] of Object.entries(initialPlacements)) {
      const normalised = normalisePlacement(placement)
      if (normalised !== undefined && normalised.id === id && validPanel(this.definitions[normalised.panelId]) && this.knownSurface(normalised.surfaceId)) placements[id] = normalised
    }
    const selectedIds = (isStringList(initial?.selectedIds) ? initial.selectedIds : []).filter((id) => placements[id] !== undefined)
    const initialActive = isStringList(initial?.activeSurfaceIds)
      ? initial.activeSurfaceIds
      : (validString(initial?.activeSurfaceId) ? [initial.activeSurfaceId] : [])
    const activeSurfaceIds = [...new Set(initialActive.filter((id): id is string => validString(id) && this.knownSurface(id)))]
    const rawAlign = initial !== undefined && isRecord(initial.align) ? initial.align : undefined
    const align = rawAlign !== undefined && typeof rawAlign.enabled === 'boolean'
      && (rawAlign.anchorId === undefined || (validString(rawAlign.anchorId) && placements[rawAlign.anchorId] !== undefined))
      ? { enabled: rawAlign.enabled, ...(rawAlign.anchorId === undefined ? {} : { anchorId: rawAlign.anchorId }) }
      : { enabled: false }
    return freezeState({
      placements,
      selectedIds,
      activeSurfaceIds,
      ...(activeSurfaceIds[0] === undefined ? {} : { activeSurfaceId: activeSurfaceIds[0] }),
      settings: initialSettings,
      groupSettings,
      nextId: Number.isInteger(initial?.nextId) && (initial?.nextId ?? 0) > 0 ? initial?.nextId ?? 1 : 1,
      align,
      undoDepth: 0,
      redoDepth: 0,
    })
  }

  private knownSurface(surfaceId: string): boolean {
    return validString(surfaceId) && this.surfaces[surfaceId] !== undefined
  }

  private surface(surfaceId: string): SurfaceDescriptor | undefined {
    return this.knownSurface(surfaceId) ? this.surfaces[surfaceId] : undefined
  }

  /** Resolve context metadata while keeping embedded surface edges as a
   * backwards-compatible fallback for hosts that do not provide `gutters`. */
  private surfaceEdge(surfaceId: string): SurfaceGutter | undefined {
    const supplied = this.gutters[surfaceId]
    if (supplied !== undefined) return supplied === null ? undefined : supplied
    const embedded = this.surfaces[surfaceId]?.edge
    if (embedded === undefined) return undefined
    return {
      surfaceId,
      type: embedded.type,
      direction: { ...embedded.direction },
      ...(embedded.line === undefined ? {} : {
        line: {
          origin: clonePoint(embedded.line.origin),
          direction: { ...embedded.line.direction },
        },
      }),
      ...(embedded.side === undefined ? {} : { side: embedded.side }),
    }
  }

  private surfaceEdgeMetadata(surfaceId: string): SurfaceEdgeMetadata | undefined {
    return edgeMetadataFromGutter(this.surfaceEdge(surfaceId))
  }

  private settingsFor(groupId?: string): PanelGroupSettings {
    return groupId !== undefined && this.state.groupSettings[groupId] !== undefined
      ? this.state.groupSettings[groupId]
      : this.state.settings
  }

  private obstaclesFor(surfaceId: string): readonly RectangularObstacle[] | undefined {
    if (this.obstacleSource === undefined) return []
    if (isObstacleList(this.obstacleSource)) return this.obstacleSource
    const obstacles = this.obstacleSource[surfaceId]
    return obstacles === undefined ? [] : obstacles
  }

  public getState(): Readonly<PlacementState> { return this.state }

  public snapshot(): PlacementSnapshot {
    return cloneSnapshot({
      placements: this.state.placements,
      selectedIds: this.state.selectedIds,
      activeSurfaceIds: this.state.activeSurfaceIds,
      ...(this.state.activeSurfaceId === undefined ? {} : { activeSurfaceId: this.state.activeSurfaceId }),
      settings: this.state.settings,
      groupSettings: this.state.groupSettings,
      nextId: this.state.nextId,
      align: this.state.align,
    })
  }

  private historySnapshot(): PlacementHistorySnapshot {
    const obstacles = cloneObstacleSource(this.obstacleSource)
    return deepFreeze({
      design: this.snapshot(),
      ...(obstacles === undefined ? {} : { obstacles }),
    })
  }

  private restore(snapshot: PlacementSnapshot): void {
    this.state = freezeState({ ...cloneSnapshot(snapshot), undoDepth: this.undoStack.length, redoDepth: this.redoStack.length })
  }

  private restoreHistory(snapshot: PlacementHistorySnapshot): void {
    this.obstacleSource = cloneObstacleSource(snapshot.obstacles)
    this.contextValue = contextFromParts(this.definitions, this.surfaces, this.gutters, this.obstacleSource)
    this.restore(snapshot.design)
  }

  private commit(next: PlacementState): void {
    this.undoStack.push(this.historySnapshot())
    this.redoStack = []
    this.state = freezeState({ ...next, undoDepth: this.undoStack.length, redoDepth: 0 })
  }

  private update(mutator: (state: PlacementState) => PlacementState | undefined, recordHistory = true): boolean {
    const next = mutator(this.state)
    if (next === undefined) return false
    if (equalValue(this.state, next)) return false
    if (recordHistory) this.commit(next)
    else this.state = freezeState({ ...next, undoDepth: this.undoStack.length, redoDepth: this.redoStack.length })
    this.notify()
    return true
  }

  private canPlace(
    placement: PanelPlacement,
    ignoredIds: ReadonlySet<string> = new Set<string>(),
    settingsOverride?: PanelGroupSettings,
    obstaclesOverride?: readonly RectangularObstacle[],
    edgeOverride?: SurfaceEdgeMetadata,
    regionOverride?: SurfaceRegion,
  ): boolean {
    const panel = this.definitions[placement.panelId]
    const surface = this.surface(placement.surfaceId)
    if (!validPanel(panel) || surface === undefined || normalisePlacement(placement) === undefined) return false
    const settings = settingsOverride ?? this.settingsFor(placement.groupId)
    if (!validSettings(settings) || !isValidSurfaceDescriptor(surface)) return false
    const region = regionOverride ?? surface.region
    if (!isSurfaceRegion(region) || boundsOfRegion(region) === undefined) return false
    const edge = edgeOverride ?? edgeMetadataFromGutter(this.surfaceEdge(placement.surfaceId))
    const axes = edge === undefined ? undefined : deriveSurfaceEdgeAxes(edge, region)
    const footprint = orientedFootprint(panel, placement.orientation)
    const rectangle = panelRect(placement, panel)
    const fits = axes === undefined
      ? rectangleInsideSurfaceRegion(rectangle, region, settings.setbackM)
      : orientedCandidateInsideRegion(placement.localCenter, footprint.widthM, footprint.heightM, region, axes, settings.setbackM)
    if (!fits) return false
    const obstacles = obstaclesOverride ?? this.obstaclesFor(placement.surfaceId)
    if (obstacles === undefined || obstacles.some((obstacle) => !isRectangularObstacle(obstacle))) return false
    const obstacleClearanceM = settings.obstacleClearanceM ?? 0
    if (axes === undefined) {
      if (obstacles.some((obstacle) => rectanglesOverlap(rectangle, expandedObstacle(obstacle, obstacleClearanceM)))) return false
    } else if (obstacles.some((obstacle) => orientedObstacleOverlap(
      placement.localCenter,
      footprint.widthM,
      footprint.heightM,
      expandedObstacle(obstacle, obstacleClearanceM),
      axes,
    ))) return false
    // A generated request may intentionally target a strict subregion of the
    // surface. Use that same region when resolving ridge/interior edge axes
    // for pairwise checks, otherwise preview and confirm can disagree even
    // though the candidate itself was generated from the request region.
    const pairwiseSurface = regionOverride === undefined ? surface : { ...surface, region }
    for (const existing of Object.values(this.state.placements)) {
      if (ignoredIds.has(existing.id) || existing.id === placement.id || existing.surfaceId !== placement.surfaceId) continue
      const existingPanel = this.definitions[existing.panelId]
      if (!validPanel(existingPanel)) return false
      const existingSettings = this.settingsFor(existing.groupId)
      if (pairwiseSpacingConflict(
        placement,
        existing,
        panel,
        existingPanel,
        settings,
        existingSettings,
        pairwiseSurface,
        edge,
      )) return false
    }
    return true
  }

  private makePlacement(input: AddPlacementInput, id: string): PanelPlacement | undefined {
    const panel = this.definitions[input.panelId]
    const surfaceId = input.surfaceId ?? this.state.activeSurfaceId
    if (!validPanel(panel) || !validString(surfaceId) || !this.knownSurface(surfaceId) || !isFinitePoint(input.localCenter)) return undefined
    if (input.groupId !== undefined && !validString(input.groupId)) return undefined
    const settings = this.settingsFor(input.groupId)
    const orientation = input.orientation ?? settings.orientation
    const clearanceM = input.clearanceM ?? settings.clearanceM
    const tiltDeg = input.tiltDeg ?? settings.tiltDeg
    if (!isOrientation(orientation) || !Number.isFinite(clearanceM) || clearanceM < 0 || !Number.isFinite(tiltDeg) || tiltDeg < 0 || tiltDeg > 90) return undefined
    return {
      id,
      panelId: input.panelId,
      surfaceId,
      localCenter: clonePoint(input.localCenter),
      orientation,
      clearanceM,
      tiltDeg,
      ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
    }
  }

  private nextId(preferred?: string): { readonly id: string; readonly nextId: number } {
    if (preferred !== undefined && validString(preferred) && this.state.placements[preferred] === undefined) return { id: preferred, nextId: this.state.nextId }
    let next = this.state.nextId
    let id = `panel-${String(next)}`
    while (this.state.placements[id] !== undefined) {
      next += 1
      id = `panel-${String(next)}`
    }
    return { id, nextId: next + 1 }
  }

  public addPanel(input: unknown): PanelPlacement | undefined {
    if (!isRecord(input) || !validString(input.panelId) || !isFinitePoint(input.localCenter)
      || (input.surfaceId !== undefined && !validString(input.surfaceId))
      || (input.groupId !== undefined && !validString(input.groupId))) return undefined
    const candidate = input as unknown as AddPlacementInput
    let created: PanelPlacement | undefined
    const changed = this.update((state) => {
      const allocation = this.nextId(validString(candidate.id) ? candidate.id : undefined)
      const placement = this.makePlacement(candidate, allocation.id)
      if (placement === undefined || !this.canPlace(placement)) return undefined
      created = placement
      return { ...state, placements: { ...state.placements, [placement.id]: placement }, nextId: allocation.nextId, selectedIds: [placement.id] }
    })
    return changed && created !== undefined ? deepFreeze(clonePlacement(created)) : undefined
  }

  /** Validate a prospective panel without changing selection, history or ids. */
  public previewPanel(input: unknown): PanelPlacement | undefined {
    if (!isRecord(input) || !validString(input.panelId) || !isFinitePoint(input.localCenter)
      || (input.surfaceId !== undefined && !validString(input.surfaceId))
      || (input.groupId !== undefined && !validString(input.groupId))) return undefined
    const allocation = this.nextId('__panel-slot-preview__')
    const placement = this.makePlacement(input as unknown as AddPlacementInput, allocation.id)
    if (placement === undefined || !this.canPlace(placement)) return undefined
    return deepFreeze(clonePlacement(placement))
  }

  public beginManualPlacement(input: unknown): boolean {
    if (!isRecord(input) || !validString(input.panelId)
      || (input.surfaceId !== undefined && !validString(input.surfaceId))
      || (input.groupId !== undefined && !validString(input.groupId))
      || (input.localCenter !== undefined && !isFinitePoint(input.localCenter))) return false
    const candidate = input as Omit<AddPlacementInput, 'localCenter'> & { readonly localCenter?: Point2 }
    const surfaceId = candidate.surfaceId ?? this.state.activeSurfaceId
    const settings = this.settingsFor(candidate.groupId)
    if (!validPanel(this.definitions[candidate.panelId]) || surfaceId === undefined || !this.knownSurface(surfaceId)) return false
    const orientation = candidate.orientation ?? settings.orientation
    const clearanceM = candidate.clearanceM ?? settings.clearanceM
    const tiltDeg = candidate.tiltDeg ?? settings.tiltDeg
    if (!isOrientation(orientation) || !Number.isFinite(clearanceM) || clearanceM < 0 || !Number.isFinite(tiltDeg) || tiltDeg < 0 || tiltDeg > 90) return false
    return this.update((state) => ({
      ...state,
      manualPlacement: {
        panelId: candidate.panelId,
        surfaceId,
        ...(candidate.localCenter === undefined ? {} : { localCenter: clonePoint(candidate.localCenter) }),
        orientation,
        clearanceM,
        tiltDeg,
        ...(candidate.groupId === undefined ? {} : { groupId: candidate.groupId }),
      },
    }), false)
  }

  public updateManualPlacement(localCenter: unknown, surfaceId?: unknown): boolean {
    if (!isFinitePoint(localCenter) || this.state.manualPlacement === undefined) return false
    if (surfaceId !== undefined && (!validString(surfaceId) || !this.knownSurface(surfaceId))) return false
    const nextSurface = surfaceId
    return this.update((state) => state.manualPlacement === undefined ? undefined : {
      ...state,
      manualPlacement: { ...state.manualPlacement, localCenter: clonePoint(localCenter), ...(nextSurface === undefined ? {} : { surfaceId: nextSurface }) },
    }, false)
  }

  public commitManualPlacement(localCenter?: unknown): PanelPlacement | undefined {
    const draft = this.state.manualPlacement
    if (draft === undefined) return undefined
    const point = localCenter ?? draft.localCenter
    if (point === undefined || !isFinitePoint(point)) return undefined
    const allocation = this.nextId()
    const groupId = draft.groupId
      ?? allocateGeneratedGroupId(this.state.placements, this.state.groupSettings, this.state.nextId)
    const placement = this.makePlacement({
      panelId: draft.panelId,
      surfaceId: draft.surfaceId,
      localCenter: point,
      orientation: draft.orientation,
      clearanceM: draft.clearanceM,
      tiltDeg: draft.tiltDeg,
      groupId,
    }, allocation.id)
    if (placement === undefined || !this.canPlace(placement)) return undefined
    const changed = this.update((state) => ({
      ...state,
      placements: { ...state.placements, [placement.id]: placement },
      selectedIds: [placement.id],
      nextId: allocation.nextId,
      manualPlacement: undefined,
    }))
    return changed ? deepFreeze(clonePlacement(placement)) : undefined
  }

  public cancelManualPlacement(): boolean {
    return this.update((state) => state.manualPlacement === undefined ? undefined : { ...state, manualPlacement: undefined }, false)
  }

  public movePanel(id: unknown, localCenter: unknown): boolean {
    if (!validString(id) || !isFinitePoint(localCenter) || this.state.placements[id] === undefined) return false
    return this.update((state) => {
      const current = state.placements[id]
      if (current === undefined) return undefined
      const moved = { ...current, localCenter: clonePoint(localCenter) }
      if (!this.canPlace(moved, new Set([id]))) return undefined
      return { ...state, placements: { ...state.placements, [id]: moved }, selectedIds: [id] }
    })
  }

  public deletePanels(ids: unknown = this.state.selectedIds): number {
    if (!isStringList(ids)) return 0
    const toDelete = new Set(ids.filter((id) => validString(id) && this.state.placements[id] !== undefined))
    if (toDelete.size === 0) return 0
    const changed = this.update((state) => ({
      ...state,
      placements: Object.fromEntries(Object.entries(state.placements).filter(([id]) => !toDelete.has(id))),
      selectedIds: idsWithout(state.selectedIds, toDelete),
    }))
    return changed ? toDelete.size : 0
  }

  public deletePanel(id: unknown): boolean { return this.deletePanels([id]) > 0 }

  public clickSelect(id: string, additive = false, toggle = false): readonly string[] {
    if (!validString(id) || this.state.placements[id] === undefined || !this.knownSurface(this.state.placements[id].surfaceId)) return this.state.selectedIds
    this.update((state) => {
      if (!additive) return { ...state, selectedIds: [id] }
      const selected = new Set(state.selectedIds)
      if (toggle && selected.has(id)) selected.delete(id)
      else selected.add(id)
      return { ...state, selectedIds: [...selected] }
    }, false)
    return this.state.selectedIds
  }

  public selectPanels(ids: unknown, additive = false): readonly string[] {
    if (!isStringList(ids) || typeof additive !== 'boolean') return this.state.selectedIds
    const valid = ids.filter((id) => this.state.placements[id] !== undefined && this.knownSurface(this.state.placements[id].surfaceId))
    this.update((state) => ({ ...state, selectedIds: [...new Set(additive ? [...state.selectedIds, ...valid] : valid)] }), false)
    return this.state.selectedIds
  }

  public selectByBox(box: unknown, surfaceId?: unknown, additive = false): readonly string[] {
    if (typeof additive !== 'boolean' || (surfaceId !== undefined && (!validString(surfaceId) || !this.knownSurface(surfaceId)))) return this.state.selectedIds
    const selectionRect = normaliseRect(box)
    if (selectionRect === undefined) return this.state.selectedIds
    const selectedSurface = surfaceId
    const ids = Object.values(this.state.placements).filter((placement) => {
      if (selectedSurface !== undefined && placement.surfaceId !== selectedSurface) return false
      const panel = this.definitions[placement.panelId]
      return validPanel(panel) && rectanglesOverlap(selectionRect, panelRect(placement, panel))
    }).map((placement) => placement.id)
    return this.selectPanels(ids, additive)
  }

  /**
   * Select panels touched by a perspective-correct surface-local polygon.
   * Screen-space drag rectangles become quadrilaterals when projected onto a
   * tilted/perspective surface, so reducing them to an axis-aligned local
   * rectangle can miss every panel in an otherwise obvious box.
   */
  public selectByPolygon(polygon: unknown, surfaceId?: unknown, additive = false): readonly string[] {
    if (typeof additive !== 'boolean' || (surfaceId !== undefined && (!validString(surfaceId) || !this.knownSurface(surfaceId)))) return this.state.selectedIds
    if (!isFiniteSelectionPolygon(polygon)) return this.state.selectedIds
    const selectedSurface = surfaceId
    const ids = Object.values(this.state.placements).filter((placement) => {
      if (selectedSurface !== undefined && placement.surfaceId !== selectedSurface) return false
      const panel = this.definitions[placement.panelId]
      return validPanel(panel) && polygonOverlap(polygon, rectangleCorners(panelRect(placement, panel)))
    }).map((placement) => placement.id)
    return this.selectPanels(ids, additive)
  }

  public moveSelected(delta: Point2): boolean { return this.moveGroup(delta) }

  public moveGroup(delta: Point2, ids?: readonly string[]): boolean
  public moveGroup(ids: readonly string[], delta: Point2): boolean
  public moveGroup(first: Point2 | readonly string[], second?: Point2 | readonly string[]): boolean {
    let ids: readonly string[]
    let delta: Point2 | undefined
    if (isStringList(first)) {
      ids = first
      delta = second !== undefined && !isStringList(second) ? second : undefined
    } else {
      ids = isStringList(second) ? second : this.state.selectedIds
      delta = first
    }
    if (delta === undefined || !isFinitePoint(delta) || ids.length === 0) return false
    const selected = new Set(ids.filter((id) => this.state.placements[id] !== undefined))
    if (selected.size === 0) return false
    return this.update((state) => {
      const candidates: PanelPlacement[] = []
      const moved: Record<string, PanelPlacement> = { ...state.placements }
      for (const id of selected) {
        const current = state.placements[id]
        if (current === undefined) continue
        const candidate = { ...current, localCenter: { x: current.localCenter.x + delta.x, y: current.localCenter.y + delta.y } }
        if (!this.canPlace(candidate, selected)) return undefined
        candidates.push(candidate)
        moved[id] = candidate
      }
      if (!pairwiseSpacingValid(
        candidates,
        this.definitions,
        (groupId) => this.settingsFor(groupId),
        (surfaceId) => this.surface(surfaceId),
        (surfaceId) => this.surfaceEdgeMetadata(surfaceId),
      )) return undefined
      return { ...state, placements: moved, selectedIds: [...selected] }
    })
  }

  /** Rotate one complete panel group through 90 degrees around its centre. */
  public rotateGroup(clockwise = true, ids: readonly string[] = this.state.selectedIds): boolean {
    if (typeof clockwise !== 'boolean' || !isStringList(ids) || ids.length === 0) return false
    const selected = new Set(ids.filter((id) => this.state.placements[id] !== undefined))
    if (selected.size === 0) return false
    const placements = [...selected].map((id) => this.state.placements[id]).filter((placement): placement is PanelPlacement => placement !== undefined)
    const groupId = placements[0]?.groupId
    const surfaceId = placements[0]?.surfaceId
    if (groupId === undefined || surfaceId === undefined
      || placements.some((placement) => placement.groupId !== groupId || placement.surfaceId !== surfaceId)
      || Object.values(this.state.placements).some((placement) => placement.groupId === groupId && !selected.has(placement.id))) return false

    const centre = placements.reduce((sum, placement) => ({
      x: sum.x + placement.localCenter.x / placements.length,
      y: sum.y + placement.localCenter.y / placements.length,
    }), { x: 0, y: 0 })
    const currentSettings = this.settingsFor(groupId)
    const rotatedSettings: PanelGroupSettings = {
      ...currentSettings,
      orientation: currentSettings.orientation === 'portrait' ? 'landscape' : 'portrait',
      interPanelSpacingM: currentSettings.rowSpacingM,
      rowSpacingM: currentSettings.interPanelSpacingM,
    }
    return this.update((state) => {
      const changed: Record<string, PanelPlacement> = { ...state.placements }
      const candidates: PanelPlacement[] = []
      for (const current of placements) {
        const offsetX = current.localCenter.x - centre.x
        const offsetY = current.localCenter.y - centre.y
        const candidate: PanelPlacement = {
          ...current,
          localCenter: clockwise
            ? { x: centre.x + offsetY, y: centre.y - offsetX }
            : { x: centre.x - offsetY, y: centre.y + offsetX },
          orientation: current.orientation === 'portrait' ? 'landscape' : 'portrait',
        }
        if (!this.canPlace(candidate, selected, rotatedSettings)) return undefined
        changed[current.id] = candidate
        candidates.push(candidate)
      }
      if (!pairwiseSpacingValid(
        candidates,
        this.definitions,
        (candidateGroupId) => candidateGroupId === groupId ? rotatedSettings : this.settingsFor(candidateGroupId),
        (candidateSurfaceId) => this.surface(candidateSurfaceId),
        (candidateSurfaceId) => this.surfaceEdgeMetadata(candidateSurfaceId),
      )) return undefined
      return {
        ...state,
        placements: changed,
        selectedIds: [...selected],
        groupSettings: { ...state.groupSettings, [groupId]: rotatedSettings },
      }
    })
  }

  public setOrientation(orientation: unknown, ids: unknown = this.state.selectedIds): boolean {
    if (!isOrientation(orientation) || !isStringList(ids) || ids.length === 0) return false
    const selected = new Set(ids.filter((id) => this.state.placements[id] !== undefined))
    if (selected.size === 0) return false
    return this.update((state) => {
      const changed: Record<string, PanelPlacement> = { ...state.placements }
      const candidates: PanelPlacement[] = []
      for (const id of selected) {
        const current = state.placements[id]
        if (current === undefined) continue
        const candidate = { ...current, orientation }
        if (!this.canPlace(candidate, selected)) return undefined
        changed[id] = candidate
        candidates.push(candidate)
      }
      if (!pairwiseSpacingValid(
        candidates,
        this.definitions,
        (groupId) => this.settingsFor(groupId),
        (surfaceId) => this.surface(surfaceId),
        (surfaceId) => this.surfaceEdgeMetadata(surfaceId),
      )) return undefined
      const selectedIds = [...selected]
      const selectedGroupId = selectedIds.length === state.selectedIds.length
        ? editableGroupIdFor({ placements: state.placements, selectedIds })
        : undefined
      if (selectedGroupId !== undefined) {
        const groupSettings = this.settingsFor(selectedGroupId)
        return {
          ...state,
          placements: changed,
          selectedIds,
          groupSettings: {
            ...state.groupSettings,
            [selectedGroupId]: { ...groupSettings, orientation },
          },
        }
      }
      // Preserve the legacy global-default behaviour when no editable group
      // exists (ungrouped or mixed selections).
      return {
        ...state,
        placements: changed,
        selectedIds,
        ...(selectedIds.length === state.selectedIds.length ? { settings: { ...state.settings, orientation } } : {}),
      }
    })
  }

  public setSettings(patch: unknown): boolean {
    return this.update((state) => {
      const settings = mergeSettings(state.settings, patch)
      return settings === undefined || settingsEqual(settings, state.settings) ? undefined : { ...state, settings }
    })
  }

  public setGroupSettings(groupId: unknown, patch: unknown): boolean {
    if (!validString(groupId)) return false
    return this.update((state) => {
      const currentSettings = this.settingsFor(groupId)
      const settings = mergeSettings(currentSettings, patch)
      if (settings === undefined || settingsEqual(settings, currentSettings)) return undefined

      const currentGroup = Object.values(state.placements).filter((placement) => placement.groupId === groupId)
      if (currentGroup.length === 0) return { ...state, groupSettings: { ...state.groupSettings, [groupId]: settings } }
      const first = currentGroup[0]
      if (first === undefined || currentGroup.some((placement) => placement.panelId !== first.panelId
        || placement.surfaceId !== first.surfaceId || placement.orientation !== first.orientation)) return undefined
      const panel = this.definitions[first.panelId]
      if (!validPanel(panel)) return undefined

      const footprint = orientedFootprint(panel, first.orientation)
      const oldStepX = footprint.widthM + currentSettings.interPanelSpacingM
      const oldStepY = footprint.heightM + currentSettings.rowSpacingM
      const newStepX = footprint.widthM + settings.interPanelSpacingM
      const newStepY = footprint.heightM + settings.rowSpacingM
      if (oldStepX <= 0 || oldStepY <= 0 || newStepX <= 0 || newStepY <= 0) return undefined
      const centre = currentGroup.reduce((sum, placement) => ({
        x: sum.x + placement.localCenter.x / currentGroup.length,
        y: sum.y + placement.localCenter.y / currentGroup.length,
      }), { x: 0, y: 0 })
      const spacingChanged = settings.interPanelSpacingM !== currentSettings.interPanelSpacingM
        || settings.rowSpacingM !== currentSettings.rowSpacingM
      const ignored = new Set(currentGroup.map((placement) => placement.id))
      const candidates = currentGroup.map((placement): PanelPlacement => ({
        ...placement,
        localCenter: spacingChanged
          ? {
              x: centre.x + (placement.localCenter.x - centre.x) * newStepX / oldStepX,
              y: centre.y + (placement.localCenter.y - centre.y) * newStepY / oldStepY,
            }
          : placement.localCenter,
        orientation: settings.orientation,
        clearanceM: settings.clearanceM,
        tiltDeg: settings.tiltDeg,
      }))
      if (candidates.some((candidate) => !this.canPlace(candidate, ignored, settings))) return undefined
      if (!pairwiseSpacingValid(
        candidates,
        this.definitions,
        (candidateGroupId) => candidateGroupId === groupId ? settings : this.settingsFor(candidateGroupId),
        (surfaceId) => this.surface(surfaceId),
        (surfaceId) => this.surfaceEdgeMetadata(surfaceId),
      )) return undefined
      const placements = { ...state.placements }
      for (const candidate of candidates) placements[candidate.id] = candidate
      return { ...state, placements, groupSettings: { ...state.groupSettings, [groupId]: settings } }
    })
  }

  public getGroupSettings(groupId: string): PanelGroupSettings {
    return deepFreeze(cloneSettings(this.settingsFor(groupId)))
  }

  public setActiveSurface(surfaceId: unknown): boolean {
    if (surfaceId !== undefined && (!validString(surfaceId) || !this.knownSurface(surfaceId))) return false
    const selectedSurface = surfaceId
    return this.update((state) => withActiveSurface(state, selectedSurface === undefined ? [] : [selectedSurface]), false)
  }

  public setActiveSurfaces(surfaceIds: unknown): boolean {
    if (!isStringList(surfaceIds) || surfaceIds.some((id) => !this.knownSurface(id))) return false
    return this.update((state) => withActiveSurface(state, surfaceIds), false)
  }

  public toggleSurfaceSelection(surfaceId: unknown): boolean {
    if (!validString(surfaceId) || !this.knownSurface(surfaceId)) return false
    const ids = new Set(this.state.activeSurfaceIds)
    if (ids.has(surfaceId)) ids.delete(surfaceId)
    else ids.add(surfaceId)
    return this.setActiveSurfaces([...ids])
  }

  public beginArrayDrag(panelId: unknown, surfaceId: unknown, start: unknown, orientation?: unknown, groupId?: unknown): boolean {
    if (!validString(panelId) || (surfaceId !== undefined && !validString(surfaceId)) || !isFinitePoint(start)
      || (groupId !== undefined && !validString(groupId))) return false
    const targetSurface = surfaceId ?? this.state.activeSurfaceId
    if (targetSurface === undefined || !this.knownSurface(targetSurface) || !validPanel(this.definitions[panelId])) return false
    const selectedPanel = panelId
    const selectedGroup = groupId
    const selectedOrientation = orientation === undefined ? this.settingsFor(selectedGroup).orientation : orientation
    if (!isOrientation(selectedOrientation)) return false
    return this.update((state) => ({ ...state, arrayDrag: { panelId: selectedPanel, surfaceId: targetSurface, start: clonePoint(start), orientation: selectedOrientation, ...(selectedGroup === undefined ? {} : { groupId: selectedGroup }) } }), false)
  }

  public updateArrayDrag(end: unknown): boolean {
    if (!isFinitePoint(end) || this.state.arrayDrag === undefined) return false
    return this.update((state) => state.arrayDrag === undefined ? undefined : { ...state, arrayDrag: { ...state.arrayDrag, end: clonePoint(end) } }, false)
  }

  public cancelArrayDrag(): boolean {
    return this.update((state) => state.arrayDrag === undefined ? undefined : { ...state, arrayDrag: undefined }, false)
  }

  public commitArrayDrag(end?: unknown): readonly PanelPlacement[] {
    const draft = this.state.arrayDrag
    if (draft === undefined) return []
    const finish = end ?? draft.end
    if (finish === undefined || !isFinitePoint(finish)) return []
    const panel = this.definitions[draft.panelId]
    if (!validPanel(panel)) return []
    // A drag is a generated batch. Keep all placements in that batch under a
    // deterministic group id even when the caller did not select an existing
    // group, while preserving explicit group ids supplied by hosts.
    const batchGroupId = draft.groupId
      ?? allocateGeneratedGroupId(this.state.placements, this.state.groupSettings, this.state.nextId)
    const settings = { ...this.settingsFor(batchGroupId), orientation: draft.orientation }
    const request: AutoFillRequest = {
      panelId: draft.panelId,
      surfaceId: draft.surfaceId,
      region: { x: Math.min(draft.start.x, finish.x), y: Math.min(draft.start.y, finish.y), width: Math.abs(finish.x - draft.start.x), height: Math.abs(finish.y - draft.start.y) },
      obstacles: this.obstaclesFor(draft.surfaceId) ?? [],
      settings,
      groupId: batchGroupId,
      ...(this.surfaceEdgeMetadata(draft.surfaceId) === undefined ? {} : { edge: this.surfaceEdgeMetadata(draft.surfaceId) }),
    }
    const generated = generateAutoFill(panel, request)
    // Candidates were generated from this drag's settings (including its
    // group-specific spacing), so validate the batch against that same
    // settings snapshot rather than a later/global settings mutation.
    const requestSettingsFor = (groupId: string | undefined): PanelGroupSettings =>
      groupId === batchGroupId ? settings : this.settingsFor(groupId)
    const created: PanelPlacement[] = []
    const usedIds = new Set(Object.keys(this.state.placements))
    let nextId = this.state.nextId
    for (const candidate of generated) {
      const allocation = allocateGeneratedId(usedIds, nextId)
      const placement = this.makePlacement({ panelId: draft.panelId, surfaceId: draft.surfaceId, localCenter: candidate.localCenter, orientation: candidate.orientation, clearanceM: candidate.clearanceM, tiltDeg: candidate.tiltDeg, groupId: candidate.groupId ?? batchGroupId }, allocation.id)
      if (placement !== undefined && this.canPlace(placement, new Set(), settings, request.obstacles, request.edge, request.region)
        && pairwiseSpacingValid(
          [...created, placement],
          this.definitions,
          requestSettingsFor,
          (surfaceId) => this.surface(surfaceId),
          (surfaceId) => surfaceId === request.surfaceId ? request.edge ?? this.surfaceEdgeMetadata(surfaceId) : this.surfaceEdgeMetadata(surfaceId),
        )) {
        created.push(placement)
        usedIds.add(allocation.id)
        nextId = allocation.nextId
      }
    }
    if (created.length === 0) {
      this.cancelArrayDrag()
      return []
    }
    const changed = this.update((state) => ({ ...state, placements: { ...state.placements, ...Object.fromEntries(created.map((placement) => [placement.id, placement])) }, selectedIds: created.map((placement) => placement.id), nextId, arrayDrag: undefined }))
    return changed ? created.map((placement) => deepFreeze(clonePlacement(placement))) : []
  }

  public setAlignMode(enabled: unknown, anchorId?: unknown): boolean {
    if (typeof enabled !== 'boolean' || (anchorId !== undefined && (!validString(anchorId) || this.state.placements[anchorId] === undefined))) return false
    const selectedAnchor = anchorId
    return this.update((state) => ({ ...state, align: { enabled, ...(selectedAnchor === undefined ? {} : { anchorId: selectedAnchor }) }, alignPreview: undefined }), false)
  }

  public previewAlign(anchorId: unknown = this.state.align.anchorId ?? this.state.selectedIds[0]): AlignPreview | undefined {
    if (!this.state.align.enabled || !validString(anchorId)) return undefined
    const anchor = this.state.placements[anchorId]
    const anchorPanel = anchor === undefined ? undefined : this.definitions[anchor.panelId]
    if (anchor === undefined || !validPanel(anchorPanel) || !this.knownSurface(anchor.surfaceId)) return undefined
    const selected = this.state.selectedIds.filter((id) => id !== anchorId)
    if (selected.length === 0) return undefined
    const ordered = [...selected].sort((first, second) => first.localeCompare(second))
    const invalidIds: string[] = []
    const proposed: PanelPlacement[] = []
    const anchorSettings = this.settingsFor(anchor.groupId)
    const anchorFootprint = orientedFootprint(anchorPanel, anchor.orientation)
    let cursor = anchor.localCenter.x + anchorFootprint.widthM / 2
    for (const id of ordered) {
      const current = this.state.placements[id]
      const panel = current === undefined ? undefined : this.definitions[current.panelId]
      if (current === undefined || !validPanel(panel) || current.surfaceId !== anchor.surfaceId) {
        invalidIds.push(id)
        continue
      }
      const settings = this.settingsFor(current.groupId)
      const footprint = orientedFootprint(panel, current.orientation)
      const spacing = Math.max(anchorSettings.interPanelSpacingM, settings.interPanelSpacingM)
      cursor += spacing + footprint.widthM / 2
      const target: PanelPlacement = { ...current, localCenter: { x: cursor, y: anchor.localCenter.y } }
      cursor += footprint.widthM / 2
      proposed.push(target)
      if (!this.canPlace(target, new Set([anchorId, ...ordered]), settings)) invalidIds.push(id)
    }
    if (!pairwiseSpacingValid(
      [anchor, ...proposed],
      this.definitions,
      (groupId) => this.settingsFor(groupId),
      (surfaceId) => this.surface(surfaceId),
      (surfaceId) => this.surfaceEdgeMetadata(surfaceId),
    )) {
      for (const placement of proposed) if (!invalidIds.includes(placement.id)) invalidIds.push(placement.id)
    }
    const preview: AlignPreview = {
      anchorId,
      placements: proposed,
      invalidIds,
      valid: invalidIds.length === 0 && proposed.length > 0,
      ...(invalidIds.length === 0 ? {} : { reason: 'alignment-collision-or-boundary' }),
    }
    this.update((state) => ({ ...state, alignPreview: preview }), false)
    return deepFreeze(cloneAlignPreview(preview))
  }

  public confirmAlign(): boolean {
    const preview = this.state.alignPreview
    if (preview === undefined || !preview.valid || preview.placements.length === 0) return false
    const ignored = new Set([preview.anchorId, ...preview.placements.map((placement) => placement.id)])
    const anchor = this.state.placements[preview.anchorId]
    if (anchor === undefined
      || preview.placements.some((placement) => !this.canPlace(placement, ignored))
      || !pairwiseSpacingValid(
        [anchor, ...preview.placements],
        this.definitions,
        (groupId) => this.settingsFor(groupId),
        (surfaceId) => this.surface(surfaceId),
        (surfaceId) => this.surfaceEdgeMetadata(surfaceId),
      )) return false
    return this.update((state) => ({
      ...state,
      placements: { ...state.placements, ...Object.fromEntries(preview.placements.map((placement) => [placement.id, placement])) },
      selectedIds: [preview.anchorId, ...preview.placements.map((placement) => placement.id)],
      alignPreview: undefined,
    }))
  }

  public cancelAlign(): boolean {
    return this.update((state) => state.alignPreview === undefined ? undefined : { ...state, alignPreview: undefined }, false)
  }

  public alignSelected(anchorId: unknown = this.state.align.anchorId ?? this.state.selectedIds[0]): boolean {
    return this.previewAlign(anchorId) !== undefined && this.confirmAlign()
  }

  public previewAutoFill(requestOrOptions: unknown): AutoFillPreview | undefined {
    const request = this.normaliseAutoFillRequest(requestOrOptions)
    if (request === undefined) return undefined
    // Auto-fill is also a generated batch. Assigning the id at preview time
    // keeps preview and confirmation in lockstep and makes repeated previews
    // deterministic without requiring callers to know the id format.
    const previewRequest: AutoFillRequest = request.groupId === undefined
      ? { ...request, groupId: allocateGeneratedGroupId(this.state.placements, this.state.groupSettings, this.state.nextId) }
      : request
    const panel = this.definitions[previewRequest.panelId]
    if (!validPanel(panel)) return undefined
    const generated = generateAutoFill(panel, previewRequest)
    const candidates = generated.filter((candidate) => {
      const temporary: PanelPlacement = {
        id: `preview-${candidate.id}`,
        panelId: previewRequest.panelId,
        surfaceId: previewRequest.surfaceId,
        localCenter: candidate.localCenter,
        orientation: candidate.orientation,
        clearanceM: candidate.clearanceM,
        tiltDeg: candidate.tiltDeg,
        ...(candidate.groupId === undefined ? {} : { groupId: candidate.groupId }),
      }
      return this.canPlace(temporary, new Set(), previewRequest.settings, previewRequest.obstacles, previewRequest.edge, previewRequest.region)
    })
    const preview: AutoFillPreview = {
      request: previewRequest,
      candidates,
      totalWattageW: candidates.length * panel.wattageW,
      totalKwp: candidates.length * panel.wattageW / 1000,
    }
    this.update((state) => ({ ...state, autoFillPreview: preview }), false)
    return deepFreeze(cloneAutoFillPreview(preview))
  }

  private normaliseAutoFillRequest(input: unknown): AutoFillRequest | undefined {
    if (!isRecord(input) || !validString(input.panelId) || !validString(input.surfaceId)
      || !this.knownSurface(input.surfaceId) || !validPanel(this.definitions[input.panelId])
      || (input.groupId !== undefined && !validString(input.groupId))) return undefined
    const panelId = input.panelId
    const surfaceId = input.surfaceId
    const groupId = input.groupId
    const surface = this.surface(surfaceId)
    const regionValue = input.region ?? surface?.region
    if (!isSurfaceRegion(regionValue) || boundsOfRegion(regionValue) === undefined) return undefined
    const settings = mergeSettings(this.settingsFor(groupId), input.settings)
    const obstaclesValue = input.obstacles ?? this.obstaclesFor(surfaceId)
    if (settings === undefined || !Array.isArray(obstaclesValue) || !obstaclesValue.every(isRectangularObstacle)) return undefined
    const edgeValue = input.edge
    const edge = edgeValue === undefined
      ? this.surfaceEdge(surfaceId)
      : normaliseSurfaceEdgeMetadata(edgeValue)
    if (edgeValue !== undefined && edge === undefined) return undefined
    const normalisedEdge = edge === undefined ? undefined : normaliseSurfaceEdgeMetadata(edge)
    return {
      panelId,
      surfaceId,
      region: cloneRegion(regionValue),
      obstacles: obstaclesValue.map(cloneObstacle),
      settings,
      ...(groupId === undefined ? {} : { groupId }),
      ...(normalisedEdge === undefined ? {} : { edge: normalisedEdge }),
    }
  }

  public confirmAutoFill(): readonly PanelPlacement[] {
    const preview = this.state.autoFillPreview
    if (preview === undefined) return []
    const panel = this.definitions[preview.request.panelId]
    if (!validPanel(panel) || !this.knownSurface(preview.request.surfaceId)) return []
    const created: PanelPlacement[] = []
    const usedIds = new Set(Object.keys(this.state.placements))
    const ignoredIds = new Set<string>()
    let nextId = this.state.nextId
    const requestSettingsFor = (groupId: string | undefined): PanelGroupSettings =>
      groupId === preview.request.groupId ? preview.request.settings : this.settingsFor(groupId)
    const cachedCandidates: AutoFillCandidateCache[] = preview.candidates.map((candidate) => ({
      candidate,
      rectangle: candidateRectangle(candidate, panel),
      settings: requestSettingsFor(candidate.groupId),
    }))
    const previewUsesOrientedEdge = preview.request.edge !== undefined
      || this.surfaceEdgeMetadata(preview.request.surfaceId) !== undefined
    // Axis-aligned rectangles are only a valid broad phase for legacy
    // payloads. Edge-aware previews use the exact oriented pairwise path so
    // confirmation cannot reject a candidate that preview accepted.
    const spacingIndex = previewUsesOrientedEdge ? undefined : buildSpacingIndex(cachedCandidates)
    const edgeForPreview = (surfaceId: string): SurfaceEdgeMetadata | undefined =>
      surfaceId === preview.request.surfaceId
        ? preview.request.edge ?? this.surfaceEdgeMetadata(surfaceId)
        : this.surfaceEdgeMetadata(surfaceId)
    for (const cached of cachedCandidates) {
      const candidate = cached.candidate
      const allocation = allocateGeneratedId(usedIds, nextId)
      const placement = this.makePlacement({ panelId: preview.request.panelId, surfaceId: preview.request.surfaceId, localCenter: candidate.localCenter, orientation: candidate.orientation, clearanceM: candidate.clearanceM, tiltDeg: candidate.tiltDeg, groupId: candidate.groupId }, allocation.id)
      const rectangle = cached.rectangle
      const spacingConflict = placement !== undefined && rectangle !== undefined && spacingIndex !== undefined
        ? spacingIndexHasConflict(spacingIndex, placement, rectangle, cached.settings)
        : placement !== undefined && !pairwiseSpacingValid(
          [...created, placement],
          this.definitions,
          requestSettingsFor,
          (surfaceId) => this.surface(surfaceId),
          edgeForPreview,
        )
      if (placement !== undefined && this.canPlace(placement, ignoredIds, preview.request.settings, preview.request.obstacles, preview.request.edge, preview.request.region)
        && !spacingConflict) {
        created.push(placement)
        usedIds.add(allocation.id)
        nextId = allocation.nextId
        if (spacingIndex !== undefined && rectangle !== undefined) {
          const entry: SpacingIndexEntry = { placement, rectangle, settings: cached.settings }
          if (!addSpacingIndexEntry(spacingIndex, entry)) spacingIndex.fallbackEntries.push(entry)
        }
      }
    }
    if (created.length === 0) {
      this.update((state) => ({ ...state, autoFillPreview: undefined }), false)
      return []
    }
    const changed = this.update((state) => ({ ...state, placements: { ...state.placements, ...Object.fromEntries(created.map((placement) => [placement.id, placement])) }, selectedIds: created.map((placement) => placement.id), nextId, autoFillPreview: undefined }))
    return changed ? created.map((placement) => deepFreeze(clonePlacement(placement))) : []
  }

  public cancelAutoFill(): boolean {
    return this.update((state) => state.autoFillPreview === undefined ? undefined : { ...state, autoFillPreview: undefined }, false)
  }

  public undo(): boolean {
    const snapshot = this.undoStack.pop()
    if (snapshot === undefined) return false
    this.redoStack.push(this.historySnapshot())
    this.restoreHistory(snapshot)
    this.state = freezeState({ ...this.state, undoDepth: this.undoStack.length, redoDepth: this.redoStack.length })
    this.notify()
    return true
  }

  public redo(): boolean {
    const snapshot = this.redoStack.pop()
    if (snapshot === undefined) return false
    this.undoStack.push(this.historySnapshot())
    this.restoreHistory(snapshot)
    this.state = freezeState({ ...this.state, undoDepth: this.undoStack.length, redoDepth: this.redoStack.length })
    this.notify()
    return true
  }

  public totals(ids: unknown = Object.keys(this.state.placements)): PlacementTotals {
    if (!isStringList(ids)) return { count: 0, wattageW: 0, kwp: 0 }
    const placements = ids.flatMap((id) => this.state.placements[id] === undefined ? [] : [this.state.placements[id]])
    return { count: placements.length, wattageW: calculateTotalWattage(placements, this.definitions), kwp: calculateTotalKwp(placements, this.definitions) }
  }

  public placementTransform(id: unknown): PlacementTransform | undefined {
    if (!validString(id)) return undefined
    const placement = this.state.placements[id]
    const panel = placement === undefined ? undefined : this.definitions[placement.panelId]
    const surface = placement === undefined ? undefined : this.surface(placement.surfaceId)
    if (placement === undefined || !validPanel(panel) || surface === undefined) return undefined
    const worldCenter = pointOnSurface(placement.localCenter, surface.frame, placement.clearanceM)
    const gutter = this.surfaceEdge(surface.id)
    const gutterDirection = gutter?.direction ?? { x: 1, y: 0 }
    return deepFreeze({ placement: clonePlacement(placement), footprint: orientedFootprint(panel, placement.orientation), worldCenter, normal: { ...surface.frame.normal }, gutterDirection: { ...gutterDirection } })
  }

  public gutterFacing(surfaceId: unknown, orientation: unknown = this.state.settings.orientation): GutterFacingData | undefined {
    if (!validString(surfaceId)) return undefined
    const surface = this.surface(surfaceId)
    if (surface === undefined || !isOrientation(orientation)) return undefined
    const gutter = this.surfaceEdge(surfaceId)
    return deepFreeze({
      surfaceId,
      direction: { ...(gutter?.direction ?? { x: 1, y: 0 }) },
      ...(gutter?.line === undefined ? {} : { line: { origin: clonePoint(gutter.line.origin), direction: { ...gutter.line.direction } } }),
      ...(gutter?.side === undefined ? {} : { side: gutter.side }),
      orientation,
      azimuthDeg: surface.azimuthDeg,
    })
  }
}

export const createPlacementStore = (options: unknown = {}): PlacementStore => new PlacementStore(options)

export type PlacementAction =
  | { readonly type: 'set-active-surface'; readonly surfaceId?: string }
  | { readonly type: 'set-active-surfaces'; readonly surfaceIds: readonly string[] }
  | { readonly type: 'select'; readonly ids: readonly string[]; readonly additive?: boolean }
  | { readonly type: 'delete'; readonly ids?: readonly string[] }
  | { readonly type: 'set-settings'; readonly settings: Partial<PanelGroupSettings> }
  | { readonly type: 'set-group-settings'; readonly groupId: string; readonly settings: Partial<PanelGroupSettings> }
  | { readonly type: 'set-surface-edge'; readonly surfaceId: string; readonly edge?: SurfaceEdgeMetadata }
  | { readonly type: 'set-orientation'; readonly orientation: Orientation; readonly ids?: readonly string[] }
  | { readonly type: 'move'; readonly delta: Point2 }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }

export function dispatchPlacementAction(store: PlacementStore, action: unknown): boolean {
  if (!isRecord(action) || typeof action.type !== 'string') return false
  switch (action.type) {
    case 'set-active-surface': return store.setActiveSurface(action.surfaceId)
    case 'set-active-surfaces': return store.setActiveSurfaces(action.surfaceIds)
    case 'select':
      if (!isStringList(action.ids)) return false
      if (action.additive !== undefined && typeof action.additive !== 'boolean') return false
      store.selectPanels(action.ids, action.additive); return true
    case 'delete': return store.deletePanels(action.ids) > 0
    case 'set-settings': return store.setSettings(action.settings)
    case 'set-group-settings': return store.setGroupSettings(action.groupId, action.settings)
    case 'set-surface-edge': return store.setSurfaceEdge(action.surfaceId, action.edge)
    case 'set-orientation': return store.setOrientation(action.orientation, action.ids)
    case 'move': return isFinitePoint(action.delta) && store.moveSelected(action.delta)
    case 'undo': return store.undo()
    case 'redo': return store.redo()
  }
  return false
}

export function placementReducer(state: PlacementState, action: unknown, context: unknown = {}): PlacementState {
  const safeContext = isRecord(context) ? context : {}
  const store = createPlacementStore({ ...safeContext, initial: state })
  dispatchPlacementAction(store, action)
  return store.getState()
}

export function initialPlacementState(options: unknown = {}): PlacementState {
  return createPlacementStore(options).getState()
}
