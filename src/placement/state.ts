import {
  DEFAULT_PANEL_GROUP_SETTINGS,
  deepFreeze,
  isPanelGroupSettings,
  isPanelDefinition,
  isPanelPlacement,
  isPoint2,
  isRectangularObstacle,
  isSurfaceRegion,
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
  type SurfaceNormal,
  type SurfaceRegion,
} from '../core'
import {
  boundsOfRegion,
  calculateTotalKwp,
  calculateTotalWattage,
  generateAutoFill,
  isValidSurfaceDescriptor,
  normaliseRect,
  orientedFootprint,
  pointOnSurface,
  rectangleInsideSurfaceRegion,
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

const validPanel = (panel: PanelDefinition | undefined): panel is PanelDefinition =>
  panel !== undefined && isPanelDefinition(panel)

const isPanelList = (value: unknown): value is readonly PanelDefinition[] =>
  Array.isArray(value)

const validSettings = (settings: unknown): settings is PanelGroupSettings => isPanelGroupSettings(settings)

type SettingsPatch = Partial<PanelGroupSettings>

const mergeSettings = (base: PanelGroupSettings, patch: unknown): PanelGroupSettings | undefined => {
  const safePatch = typeof patch === 'object' && patch !== null ? patch as SettingsPatch : {}
  const candidate: PanelGroupSettings = {
    orientation: safePatch.orientation ?? base.orientation,
    interPanelSpacingM: safePatch.interPanelSpacingM ?? base.interPanelSpacingM,
    rowSpacingM: safePatch.rowSpacingM ?? base.rowSpacingM,
    setbackM: safePatch.setbackM ?? base.setbackM,
    clearanceM: safePatch.clearanceM ?? base.clearanceM,
    tiltDeg: safePatch.tiltDeg ?? base.tiltDeg,
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

export interface GutterLine {
  readonly origin: Point2
  readonly direction: Point2
}

export interface SurfaceGutter {
  readonly surfaceId: string
  readonly direction: Point2
  readonly line?: GutterLine
}

const isGutterList = (value: unknown): value is readonly SurfaceGutter[] =>
  Array.isArray(value)

export interface PlacementContext {
  readonly panels?: readonly PanelDefinition[] | Readonly<Record<string, PanelDefinition>>
  readonly surfaces?: readonly SurfaceDescriptor[] | Readonly<Record<string, SurfaceDescriptor>>
  readonly obstacles?: readonly RectangularObstacle[] | Readonly<Record<string, readonly RectangularObstacle[]>>
  readonly surfaceObstacles?: readonly RectangularObstacle[] | Readonly<Record<string, readonly RectangularObstacle[]>>
  readonly gutters?: readonly SurfaceGutter[] | Readonly<Record<string, SurfaceGutter>>
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
  readonly orientation: Orientation
  readonly azimuthDeg: number
}

export interface AutoFillPreviewOptions {
  readonly panelId: string
  readonly surfaceId: string
  readonly region?: SurfaceRegion
  readonly obstacles?: readonly RectangularObstacle[]
  readonly settings?: Partial<PanelGroupSettings>
  readonly groupId?: string
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

const pairwiseSpacingValid = (
  placements: readonly PanelPlacement[],
  definitions: Readonly<Record<string, PanelDefinition>>,
  settingsFor: (groupId: string | undefined) => PanelGroupSettings,
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
      if (rectanglesOverlapWithSpacing(panelRect(a, panelA), panelRect(b, panelB), Math.max(settingsA.interPanelSpacingM, settingsB.interPanelSpacingM), Math.max(settingsA.rowSpacingM, settingsB.rowSpacingM))) return false
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

const validDirection = (direction: unknown): direction is Point2 => isFinitePoint(direction) && Math.hypot(direction.x, direction.y) > 1e-9
const normaliseDirection = (direction: Point2): Point2 => {
  const length = Math.hypot(direction.x, direction.y)
  return { x: direction.x / length, y: direction.y / length }
}

type ObstacleSource = readonly RectangularObstacle[] | Readonly<Record<string, readonly RectangularObstacle[]>>

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

const cloneGutters = (gutters: unknown): Readonly<Record<string, SurfaceGutter>> => {
  const result: Record<string, SurfaceGutter> = {}
  if (gutters === undefined) return Object.freeze(result)
  const addGutter = (id: unknown, gutter: unknown): void => {
    if (!validString(id) || !isRecord(gutter)) return
    if (!validString(id) || id !== gutter.surfaceId || !validDirection(gutter.direction)) return
    if (gutter.line !== undefined && !validPointLine(gutter.line)) return
    result[id] = deepFreeze({
      surfaceId: id,
      direction: normaliseDirection(gutter.direction),
      ...(gutter.line === undefined ? {} : { line: deepFreeze({ origin: clonePoint(gutter.line.origin), direction: normaliseDirection(gutter.line.direction) }) }),
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
    && (gutter.line === undefined || validPointLine(gutter.line)))
  if (!isRecord(value)) return false
  return Object.entries(value).every(([id, gutter]) => isRecord(gutter)
    && validString(id)
    && gutter.surfaceId === id
    && validDirection(gutter.direction)
    && (gutter.line === undefined || validPointLine(gutter.line)))
}

interface NormalisedContext {
  readonly definitions: Readonly<Record<string, PanelDefinition>>
  readonly surfaces: Readonly<Record<string, SurfaceDescriptor>>
  readonly gutters: Readonly<Record<string, SurfaceGutter>>
  readonly obstacleSource: ObstacleSource | undefined
  readonly context: PlacementContext
}

const contextFromParts = (
  definitions: Readonly<Record<string, PanelDefinition>>,
  surfaces: Readonly<Record<string, SurfaceDescriptor>>,
  gutters: Readonly<Record<string, SurfaceGutter>>,
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
  private gutters: Readonly<Record<string, SurfaceGutter>>
  private obstacleSource: ObstacleSource | undefined
  private state: PlacementState
  private undoStack: PlacementSnapshot[]
  private redoStack: PlacementSnapshot[]
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
   * Replace only the obstacle context used by placement validation. The
   * design state and undo/redo stacks are deliberately retained so editing
   * obstacle annotations cannot erase panel work or create history entries.
   * Surface-keyed sources must refer to surfaces currently known to the
   * store; malformed sources are rejected without notifying subscribers.
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
    this.obstacleSource = next
    this.contextValue = contextFromParts(this.definitions, this.surfaces, this.gutters, next)
    // Context changes are externally visible through the snapshot contract,
    // but are not placement edits and therefore do not touch history.
    this.state = freezeState({ ...this.state })
    this.notify()
    return true
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

  private restore(snapshot: PlacementSnapshot): void {
    this.state = freezeState({ ...cloneSnapshot(snapshot), undoDepth: this.undoStack.length, redoDepth: this.redoStack.length })
  }

  private commit(next: PlacementState): void {
    this.undoStack.push(this.snapshot())
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
  ): boolean {
    const panel = this.definitions[placement.panelId]
    const surface = this.surface(placement.surfaceId)
    if (!validPanel(panel) || surface === undefined || normalisePlacement(placement) === undefined) return false
    const settings = settingsOverride ?? this.settingsFor(placement.groupId)
    if (!validSettings(settings) || !isValidSurfaceDescriptor(surface)) return false
    const rectangle = panelRect(placement, panel)
    if (!rectangleInsideSurfaceRegion(rectangle, surface.region, settings.setbackM)) return false
    const obstacles = obstaclesOverride ?? this.obstaclesFor(placement.surfaceId)
    if (obstacles === undefined || obstacles.some((obstacle) => !isRectangularObstacle(obstacle))) return false
    if (obstacles.some((obstacle) => rectanglesOverlap(rectangle, obstacle))) return false
    for (const existing of Object.values(this.state.placements)) {
      if (ignoredIds.has(existing.id) || existing.id === placement.id || existing.surfaceId !== placement.surfaceId) continue
      const existingPanel = this.definitions[existing.panelId]
      if (!validPanel(existingPanel)) return false
      const existingSettings = this.settingsFor(existing.groupId)
      const horizontal = Math.max(settings.interPanelSpacingM, existingSettings.interPanelSpacingM)
      const vertical = Math.max(settings.rowSpacingM, existingSettings.rowSpacingM)
      if (rectanglesOverlapWithSpacing(rectangle, panelRect(existing, existingPanel), horizontal, vertical)) return false
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
    const placement = this.makePlacement({
      panelId: draft.panelId,
      surfaceId: draft.surfaceId,
      localCenter: point,
      orientation: draft.orientation,
      clearanceM: draft.clearanceM,
      tiltDeg: draft.tiltDeg,
      groupId: draft.groupId,
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
      if (!pairwiseSpacingValid(candidates, this.definitions, (groupId) => this.settingsFor(groupId))) return undefined
      return { ...state, placements: moved, selectedIds: [...selected] }
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
      if (!pairwiseSpacingValid(candidates, this.definitions, (groupId) => this.settingsFor(groupId))) return undefined
      return { ...state, placements: changed, settings: ids.length === state.selectedIds.length ? { ...state.settings, orientation } : state.settings }
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
      const settings = mergeSettings(this.settingsFor(groupId), patch)
      return settings === undefined || settingsEqual(settings, this.settingsFor(groupId))
        ? undefined
        : { ...state, groupSettings: { ...state.groupSettings, [groupId]: settings } }
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

  public beginArrayDrag(panelId: unknown, surfaceId: unknown, start: unknown, orientation: unknown = this.state.settings.orientation, groupId?: unknown): boolean {
    if (!validString(panelId) || (surfaceId !== undefined && !validString(surfaceId)) || !isFinitePoint(start)
      || !isOrientation(orientation) || (groupId !== undefined && !validString(groupId))) return false
    const targetSurface = surfaceId ?? this.state.activeSurfaceId
    if (targetSurface === undefined || !this.knownSurface(targetSurface) || !validPanel(this.definitions[panelId])) return false
    const selectedPanel = panelId
    const selectedOrientation = orientation
    const selectedGroup = groupId
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
    const settings = { ...this.settingsFor(draft.groupId), orientation: draft.orientation }
    const request: AutoFillRequest = {
      panelId: draft.panelId,
      surfaceId: draft.surfaceId,
      region: { x: Math.min(draft.start.x, finish.x), y: Math.min(draft.start.y, finish.y), width: Math.abs(finish.x - draft.start.x), height: Math.abs(finish.y - draft.start.y) },
      obstacles: this.obstaclesFor(draft.surfaceId) ?? [],
      settings,
      ...(draft.groupId === undefined ? {} : { groupId: draft.groupId }),
    }
    const generated = generateAutoFill(panel, request)
    // Candidates were generated from this drag's settings (including its
    // group-specific spacing), so validate the batch against that same
    // settings snapshot rather than a later/global settings mutation.
    const requestSettingsFor = (groupId: string | undefined): PanelGroupSettings =>
      groupId === draft.groupId ? settings : this.settingsFor(groupId)
    const created: PanelPlacement[] = []
    const usedIds = new Set(Object.keys(this.state.placements))
    let nextId = this.state.nextId
    for (const candidate of generated) {
      const allocation = allocateGeneratedId(usedIds, nextId)
      const placement = this.makePlacement({ panelId: draft.panelId, surfaceId: draft.surfaceId, localCenter: candidate.localCenter, orientation: candidate.orientation, clearanceM: candidate.clearanceM, tiltDeg: candidate.tiltDeg, groupId: candidate.groupId }, allocation.id)
      if (placement !== undefined && this.canPlace(placement, new Set(), settings, request.obstacles)
        && pairwiseSpacingValid([...created, placement], this.definitions, requestSettingsFor)) {
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
    if (!pairwiseSpacingValid([anchor, ...proposed], this.definitions, (groupId) => this.settingsFor(groupId))) {
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
      || !pairwiseSpacingValid([anchor, ...preview.placements], this.definitions, (groupId) => this.settingsFor(groupId))) return false
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
    const panel = this.definitions[request.panelId]
    if (!validPanel(panel)) return undefined
    const generated = generateAutoFill(panel, request)
    const candidates = generated.filter((candidate) => {
      const temporary: PanelPlacement = {
        id: `preview-${candidate.id}`,
        panelId: request.panelId,
        surfaceId: request.surfaceId,
        localCenter: candidate.localCenter,
        orientation: candidate.orientation,
        clearanceM: candidate.clearanceM,
        tiltDeg: candidate.tiltDeg,
        ...(candidate.groupId === undefined ? {} : { groupId: candidate.groupId }),
      }
      return this.canPlace(temporary, new Set(), request.settings, request.obstacles)
    })
    const preview: AutoFillPreview = {
      request,
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
    const explicit = input.region !== undefined && input.settings !== undefined && input.obstacles !== undefined
    const settings = explicit
      ? mergeSettings(this.state.settings, input.settings)
      : mergeSettings(this.settingsFor(groupId), input.settings)
    const obstaclesValue = input.obstacles ?? this.obstaclesFor(surfaceId)
    if (settings === undefined || !Array.isArray(obstaclesValue) || !obstaclesValue.every(isRectangularObstacle)) return undefined
    return {
      panelId,
      surfaceId,
      region: cloneRegion(regionValue),
      obstacles: obstaclesValue.map(cloneObstacle),
      settings,
      ...(groupId === undefined ? {} : { groupId }),
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
    const spacingIndex = buildSpacingIndex(cachedCandidates)
    for (const cached of cachedCandidates) {
      const candidate = cached.candidate
      const allocation = allocateGeneratedId(usedIds, nextId)
      const placement = this.makePlacement({ panelId: preview.request.panelId, surfaceId: preview.request.surfaceId, localCenter: candidate.localCenter, orientation: candidate.orientation, clearanceM: candidate.clearanceM, tiltDeg: candidate.tiltDeg, groupId: candidate.groupId }, allocation.id)
      const rectangle = cached.rectangle
      const spacingConflict = placement !== undefined && rectangle !== undefined && spacingIndex !== undefined
        ? spacingIndexHasConflict(spacingIndex, placement, rectangle, cached.settings)
        : placement !== undefined && !pairwiseSpacingValid([...created, placement], this.definitions, requestSettingsFor)
      if (placement !== undefined && this.canPlace(placement, ignoredIds, preview.request.settings, preview.request.obstacles)
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
    this.redoStack.push(this.snapshot())
    this.restore(snapshot)
    this.state = freezeState({ ...this.state, undoDepth: this.undoStack.length, redoDepth: this.redoStack.length })
    this.notify()
    return true
  }

  public redo(): boolean {
    const snapshot = this.redoStack.pop()
    if (snapshot === undefined) return false
    this.undoStack.push(this.snapshot())
    this.restore(snapshot)
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
    const gutter = this.gutters[surface.id]
    const gutterDirection = gutter?.direction ?? { x: 1, y: 0 }
    return deepFreeze({ placement: clonePlacement(placement), footprint: orientedFootprint(panel, placement.orientation), worldCenter, normal: { ...surface.frame.normal }, gutterDirection: { ...gutterDirection } })
  }

  public gutterFacing(surfaceId: unknown, orientation: unknown = this.state.settings.orientation): GutterFacingData | undefined {
    if (!validString(surfaceId)) return undefined
    const surface = this.surface(surfaceId)
    if (surface === undefined || !isOrientation(orientation)) return undefined
    const gutter = this.gutters[surfaceId]
    return deepFreeze({
      surfaceId,
      direction: { ...(gutter?.direction ?? { x: 1, y: 0 }) },
      ...(gutter?.line === undefined ? {} : { line: { origin: clonePoint(gutter.line.origin), direction: { ...gutter.line.direction } } }),
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
