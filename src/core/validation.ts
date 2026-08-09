import type {
  AutoFillCandidate,
  AutoFillPreview,
  AutoFillRequest,
  PanelDefinition,
  PanelFootprint,
  PanelGroupSettings,
  PanelPlacement,
  Point2,
  Point3,
  Polygon,
  Rect,
  RectangularObstacle,
  SurfaceDescriptor,
  SurfaceFaceRef,
  SurfaceFrame,
  SurfaceNormal,
  SurfaceRegion,
  SurfaceSelection,
} from './types'

const MIN_VECTOR_LENGTH_SQUARED = 1e-16

type RecordValue = Record<string, unknown>

const isRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null

const hasNonEmptyString = (record: RecordValue, key: string): boolean => {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0
}

/** Returns true only for primitive finite numbers (not numeric strings). */
export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** Throws a TypeError when a number is NaN or infinite. */
export function assertFiniteNumber(value: unknown, name = 'value'): asserts value is number {
  if (!isFiniteNumber(value)) throw new TypeError(`${name} must be a finite number`)
}

function isFiniteVector(value: unknown, dimensions: 2 | 3): value is Point2 | Point3 {
  if (!isRecord(value)) return false
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return false
  return dimensions === 2 || isFiniteNumber(value.z)
}

/** A runtime guard for a finite two-dimensional point. */
export const isPoint2 = (value: unknown): value is Point2 => isFiniteVector(value, 2)

/** A runtime guard for a finite three-dimensional point. */
export const isPoint3 = (value: unknown): value is Point3 => isFiniteVector(value, 3)

/** A runtime guard for a finite, non-zero normal vector. */
export const isSurfaceNormal = (value: unknown): value is SurfaceNormal => {
  if (!isFiniteVector(value, 3)) return false
  const vector = value as Point3
  return vector.x * vector.x + vector.y * vector.y + vector.z * vector.z > MIN_VECTOR_LENGTH_SQUARED
}

const dot3 = (first: Point3, second: Point3): number =>
  first.x * second.x + first.y * second.y + first.z * second.z

const cross3 = (first: Point3, second: Point3): Point3 => ({
  x: first.y * second.z - first.z * second.y,
  y: first.z * second.x - first.x * second.z,
  z: first.x * second.y - first.y * second.x,
})

const unit3 = (value: Point3): Point3 | undefined => {
  const magnitude = Math.sqrt(dot3(value, value))
  return Number.isFinite(magnitude) && magnitude > Math.sqrt(MIN_VECTOR_LENGTH_SQUARED)
    ? { x: value.x / magnitude, y: value.y / magnitude, z: value.z / magnitude }
    : undefined
}

/** A runtime guard for a finite, orthogonal, right-handed surface frame. */
export const isSurfaceFrame = (value: unknown): value is SurfaceFrame => {
  if (!isRecord(value)) return false
  if (!isPoint3(value.origin)
    || !isSurfaceNormal(value.normal)
    || !isSurfaceNormal(value.tangentX)
    || !isSurfaceNormal(value.tangentY)) return false
  const normal = unit3(value.normal)
  const tangentX = unit3(value.tangentX)
  const tangentY = unit3(value.tangentY)
  if (normal === undefined || tangentX === undefined || tangentY === undefined) return false
  const orthogonal = (first: Point3, second: Point3): boolean => Math.abs(dot3(first, second)) <= 1e-8
  const handedness = dot3(cross3(tangentX, tangentY), normal)
  return orthogonal(normal, tangentX)
    && orthogonal(normal, tangentY)
    && orthogonal(tangentX, tangentY)
    && Number.isFinite(handedness)
    && handedness > 1e-8
}

/** A runtime guard for a finite rectangle with positive dimensions. */
export const isRect = (value: unknown): value is Rect => {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width)
    && isFiniteNumber(value.height)
    && value.width > 0
    && value.height > 0
}

/** A runtime guard for a polygon with at least three finite, non-zero edges. */
export const isPolygon = (value: unknown): value is Polygon => {
  if (!isRecord(value) || !Array.isArray(value.points) || value.points.length < 3) return false
  if (!value.points.every(isPoint2)) return false
  for (let index = 0; index < value.points.length; index += 1) {
    const current = value.points[index]
    const next = value.points[(index + 1) % value.points.length]
    if (current === undefined || next === undefined) return false
    const dx = current.x - next.x
    const dy = current.y - next.y
    if (dx * dx + dy * dy <= MIN_VECTOR_LENGTH_SQUARED) return false
  }
  return true
}

/** A runtime guard for either supported local surface footprint. */
export const isSurfaceRegion = (value: unknown): value is SurfaceRegion => isRect(value) || isPolygon(value)

/** A runtime guard for a stable source-mesh triangle reference. */
export const isSurfaceFaceRef = (value: unknown): value is SurfaceFaceRef => {
  if (!isRecord(value) || !hasNonEmptyString(value, 'meshId') || !Array.isArray(value.faceIndices)) return false
  return value.faceIndices.every((faceIndex) =>
    typeof faceIndex === 'number' && Number.isInteger(faceIndex) && faceIndex >= 0,
  )
}

/** A runtime guard for a serialisable surface descriptor. */
export const isSurfaceDescriptor = (value: unknown): value is SurfaceDescriptor => {
  if (!isRecord(value) || !hasNonEmptyString(value, 'id')) return false
  if (!isSurfaceFrame(value.frame) || !isSurfaceRegion(value.region)) return false
  if (!isFiniteNumber(value.area) || value.area < 0) return false
  if (!isFiniteNumber(value.azimuthDeg) || !isFiniteNumber(value.tiltDeg)) return false
  if (!isFiniteNumber(value.usableArea) || value.usableArea < 0 || value.usableArea > value.area) return false
  return Array.isArray(value.faceRefs) && value.faceRefs.every(isSurfaceFaceRef)
}

/** A runtime guard for a viewer hit resolved to a canonical surface. */
export const isSurfaceSelection = (value: unknown): value is SurfaceSelection => {
  if (!isRecord(value)) return false
  return isSurfaceDescriptor(value.surface) && isPoint2(value.hitLocal) && isPoint3(value.worldPoint)
}

/** A runtime guard for the two supported panel orientations. */
export const isOrientation = (value: unknown): value is PanelGroupSettings['orientation'] =>
  value === 'portrait' || value === 'landscape'

/** A runtime guard for canonical metre-based panel data. */
export const isPanelDefinition = (value: unknown): value is PanelDefinition => {
  if (!isRecord(value)) return false
  return hasNonEmptyString(value, 'id')
    && hasNonEmptyString(value, 'manufacturer')
    && hasNonEmptyString(value, 'model')
    && isFiniteNumber(value.widthM)
    && value.widthM > 0
    && isFiniteNumber(value.heightM)
    && value.heightM > 0
    && isFiniteNumber(value.thicknessM)
    && value.thicknessM > 0
    && isFiniteNumber(value.wattageW)
    && value.wattageW > 0
    && isFiniteNumber(value.weightKg)
    && value.weightKg > 0
}

/** A runtime guard for complete group settings. */
export const isPanelGroupSettings = (value: unknown): value is PanelGroupSettings => {
  if (!isRecord(value) || !isOrientation(value.orientation)) return false
  return isFiniteNumber(value.interPanelSpacingM)
    && value.interPanelSpacingM >= 0
    && isFiniteNumber(value.rowSpacingM)
    && value.rowSpacingM >= 0
    && isFiniteNumber(value.setbackM)
    && value.setbackM >= 0
    && isFiniteNumber(value.clearanceM)
    && value.clearanceM >= 0
    && isFiniteNumber(value.tiltDeg)
    && value.tiltDeg >= 0
    && value.tiltDeg <= 90
}

/** A runtime guard for a serialisable local panel placement. */
export const isPanelPlacement = (value: unknown): value is PanelPlacement => {
  if (!isRecord(value) || !hasNonEmptyString(value, 'id') || !hasNonEmptyString(value, 'panelId')) return false
  if (!hasNonEmptyString(value, 'surfaceId') || !isPoint2(value.localCenter) || !isOrientation(value.orientation)) return false
  if (!isFiniteNumber(value.clearanceM) || value.clearanceM < 0
    || !isFiniteNumber(value.tiltDeg) || value.tiltDeg < 0 || value.tiltDeg > 90) return false
  return value.groupId === undefined || hasNonEmptyString(value, 'groupId')
}

/** A runtime guard for a local exclusion rectangle. */
export const isRectangularObstacle = (value: unknown): value is RectangularObstacle =>
  isRecord(value) && hasNonEmptyString(value, 'id') && isRect(value)

/** A runtime guard for an oriented module footprint. */
export const isPanelFootprint = (value: unknown): value is PanelFootprint => {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.widthM) && value.widthM > 0 && isFiniteNumber(value.heightM) && value.heightM > 0
}

/** A runtime guard for an auto-fill request. */
export const isAutoFillRequest = (value: unknown): value is AutoFillRequest => {
  if (!isRecord(value) || !hasNonEmptyString(value, 'panelId') || !hasNonEmptyString(value, 'surfaceId')) return false
  if (!isSurfaceRegion(value.region) || !isPanelGroupSettings(value.settings)) return false
  if (!Array.isArray(value.obstacles) || !value.obstacles.every(isRectangularObstacle)) return false
  return value.groupId === undefined || hasNonEmptyString(value, 'groupId')
}

/** A runtime guard for one ghosted auto-fill candidate. */
export const isAutoFillCandidate = (value: unknown): value is AutoFillCandidate => {
  if (!isRecord(value) || !hasNonEmptyString(value, 'id') || !isPoint2(value.localCenter)) return false
  if (!isPanelFootprint(value.footprint) || !isOrientation(value.orientation)) return false
  if (!isFiniteNumber(value.clearanceM) || value.clearanceM < 0
    || !isFiniteNumber(value.tiltDeg) || value.tiltDeg < 0 || value.tiltDeg > 90) return false
  return value.groupId === undefined || hasNonEmptyString(value, 'groupId')
}

/** A runtime guard for a complete auto-fill preview. */
export const isAutoFillPreview = (value: unknown): value is AutoFillPreview => {
  if (!isRecord(value) || !isAutoFillRequest(value.request) || !Array.isArray(value.candidates)) return false
  if (!value.candidates.every(isAutoFillCandidate)) return false
  return isFiniteNumber(value.totalWattageW)
    && value.totalWattageW >= 0
    && isFiniteNumber(value.totalKwp)
    && value.totalKwp >= 0
}

/**
 * Recursively freezes a DTO and its nested arrays/objects. The function does
 * not alter values, so the returned object remains directly JSON serialisable.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && 'value' in descriptor) deepFreeze(descriptor.value)
  }
  return Object.freeze(value)
}

function assertValid(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(message)
}

function copyPoint2(value: Point2): Point2 {
  return { x: value.x, y: value.y }
}

function copyPoint3(value: Point3): Point3 {
  return { x: value.x, y: value.y, z: value.z }
}

function copyNormal(value: SurfaceNormal): SurfaceNormal {
  return { x: value.x, y: value.y, z: value.z }
}

/** Validate and clone a point into an immutable DTO. */
export function createPoint2(value: Point2): Point2 {
  assertValid(isPoint2(value), 'Point2 must contain finite x and y values')
  return deepFreeze(copyPoint2(value))
}

/** Validate and clone a world-space point into an immutable DTO. */
export function createPoint3(value: Point3): Point3 {
  assertValid(isPoint3(value), 'Point3 must contain finite x, y and z values')
  return deepFreeze(copyPoint3(value))
}

/** Validate and clone a non-zero normal into an immutable DTO. */
export function createSurfaceNormal(value: SurfaceNormal): SurfaceNormal {
  assertValid(isSurfaceNormal(value), 'SurfaceNormal must contain finite, non-zero x, y and z values')
  return deepFreeze(copyNormal(value))
}

/** Validate and clone a frame and all of its nested vectors. */
export function createSurfaceFrame(value: SurfaceFrame): SurfaceFrame {
  assertValid(isSurfaceFrame(value), 'SurfaceFrame contains an invalid origin or basis vector')
  const normal = unit3(value.normal)
  const tangentX = unit3(value.tangentX)
  const tangentY = unit3(value.tangentY)
  // isSurfaceFrame above guarantees these vectors are valid; retaining this
  // assertion keeps the constructor safe if its implementation changes.
  assertValid(normal !== undefined && tangentX !== undefined && tangentY !== undefined, 'SurfaceFrame basis vectors are invalid')
  return deepFreeze({
    origin: copyPoint3(value.origin),
    normal: copyNormal(normal),
    tangentX: copyNormal(tangentX),
    tangentY: copyNormal(tangentY),
  })
}

/** Validate and clone a positive rectangle. */
export function createRect(value: Rect): Rect {
  assertValid(isRect(value), 'Rect must contain finite x/y values and positive width/height')
  return deepFreeze({ x: value.x, y: value.y, width: value.width, height: value.height })
}

/** Validate, clone and freeze a polygon. */
export function createPolygon(value: Polygon): Polygon {
  assertValid(isPolygon(value), 'Polygon must contain at least three finite points')
  return deepFreeze({ points: value.points.map(copyPoint2) })
}

/** Validate and clone either supported surface region. */
export function createSurfaceRegion(value: SurfaceRegion): SurfaceRegion {
  return isPolygon(value) ? createPolygon(value) : createRect(value)
}

/** Validate and clone a stable mesh face reference. */
export function createSurfaceFaceRef(value: SurfaceFaceRef): SurfaceFaceRef {
  assertValid(isSurfaceFaceRef(value), 'SurfaceFaceRef must have a mesh id and non-negative integer indices')
  return deepFreeze({ meshId: value.meshId.trim(), faceIndices: [...value.faceIndices] })
}

/** Validate and clone a surface descriptor. */
export function createSurfaceDescriptor(value: SurfaceDescriptor): SurfaceDescriptor {
  assertValid(isSurfaceDescriptor(value), 'SurfaceDescriptor contains invalid geometry or measurements')
  return deepFreeze({
    id: value.id.trim(),
    frame: createSurfaceFrame(value.frame),
    region: createSurfaceRegion(value.region),
    area: value.area,
    azimuthDeg: value.azimuthDeg,
    tiltDeg: value.tiltDeg,
    usableArea: value.usableArea,
    faceRefs: value.faceRefs.map(createSurfaceFaceRef),
  })
}

/** Validate and clone a surface hit-selection DTO. */
export function createSurfaceSelection(value: SurfaceSelection): SurfaceSelection {
  assertValid(isSurfaceSelection(value), 'SurfaceSelection contains an invalid surface or hit point')
  return deepFreeze({
    surface: createSurfaceDescriptor(value.surface),
    hitLocal: createPoint2(value.hitLocal),
    worldPoint: createPoint3(value.worldPoint),
  })
}

/** Validate and clone canonical panel data. */
export function createPanelDefinition(value: PanelDefinition): PanelDefinition {
  assertValid(isPanelDefinition(value), 'PanelDefinition contains invalid identity or metre-based dimensions')
  return deepFreeze({
    id: value.id.trim(),
    manufacturer: value.manufacturer.trim(),
    model: value.model.trim(),
    widthM: value.widthM,
    heightM: value.heightM,
    thicknessM: value.thicknessM,
    wattageW: value.wattageW,
    weightKg: value.weightKg,
  })
}

/** Validate and clone complete group settings. */
export function createPanelGroupSettings(value: PanelGroupSettings): PanelGroupSettings {
  assertValid(isPanelGroupSettings(value), 'PanelGroupSettings contains invalid spacing, clearance or tilt')
  return deepFreeze({
    orientation: value.orientation,
    interPanelSpacingM: value.interPanelSpacingM,
    rowSpacingM: value.rowSpacingM,
    setbackM: value.setbackM,
    clearanceM: value.clearanceM,
    tiltDeg: value.tiltDeg,
  })
}

/** Validate and clone one local panel placement. */
export function createPanelPlacement(value: PanelPlacement): PanelPlacement {
  assertValid(isPanelPlacement(value), 'PanelPlacement contains invalid identity, local coordinates or settings')
  return deepFreeze({
    id: value.id.trim(),
    panelId: value.panelId.trim(),
    surfaceId: value.surfaceId.trim(),
    localCenter: createPoint2(value.localCenter),
    orientation: value.orientation,
    clearanceM: value.clearanceM,
    tiltDeg: value.tiltDeg,
    ...(value.groupId === undefined ? {} : { groupId: value.groupId.trim() }),
  })
}

/** Validate and clone a local exclusion rectangle. */
export function createRectangularObstacle(value: RectangularObstacle): RectangularObstacle {
  assertValid(isRectangularObstacle(value), 'RectangularObstacle must have an id and positive dimensions')
  return deepFreeze({ id: value.id.trim(), x: value.x, y: value.y, width: value.width, height: value.height })
}

/** Validate and clone an oriented footprint. */
export function createPanelFootprint(value: PanelFootprint): PanelFootprint {
  assertValid(isPanelFootprint(value), 'PanelFootprint must contain positive metre dimensions')
  return deepFreeze({ widthM: value.widthM, heightM: value.heightM })
}

/** Validate and clone a complete auto-fill request. */
export function createAutoFillRequest(value: AutoFillRequest): AutoFillRequest {
  assertValid(isAutoFillRequest(value), 'AutoFillRequest contains invalid region, obstacle or group settings')
  return deepFreeze({
    panelId: value.panelId.trim(),
    surfaceId: value.surfaceId.trim(),
    region: createSurfaceRegion(value.region),
    obstacles: value.obstacles.map(createRectangularObstacle),
    settings: createPanelGroupSettings(value.settings),
    ...(value.groupId === undefined ? {} : { groupId: value.groupId.trim() }),
  })
}

/** Validate and clone one auto-fill candidate. */
export function createAutoFillCandidate(value: AutoFillCandidate): AutoFillCandidate {
  assertValid(isAutoFillCandidate(value), 'AutoFillCandidate contains invalid local coordinates or footprint')
  return deepFreeze({
    id: value.id.trim(),
    localCenter: createPoint2(value.localCenter),
    footprint: createPanelFootprint(value.footprint),
    orientation: value.orientation,
    clearanceM: value.clearanceM,
    tiltDeg: value.tiltDeg,
    ...(value.groupId === undefined ? {} : { groupId: value.groupId.trim() }),
  })
}

/** Validate and clone a complete auto-fill preview. */
export function createAutoFillPreview(value: AutoFillPreview): AutoFillPreview {
  assertValid(isAutoFillPreview(value), 'AutoFillPreview contains invalid request, candidate or totals')
  return deepFreeze({
    request: createAutoFillRequest(value.request),
    candidates: value.candidates.map(createAutoFillCandidate),
    totalWattageW: value.totalWattageW,
    totalKwp: value.totalKwp,
  })
}
