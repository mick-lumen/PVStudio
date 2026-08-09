import type {
  AutoFillCandidate,
  AutoFillRequest,
  PanelDefinition,
  PanelFootprint,
  Point2,
  Point3,
  Polygon,
  Rect,
  SurfaceFrame,
  SurfaceNormal,
  SurfaceDescriptor,
} from '../core'
import {
  isPoint2,
  isPoint3,
  isAutoFillCandidate,
  isAutoFillRequest,
  isPolygon as isCorePolygon,
  isRect,
  isRectangularObstacle,
  isSurfaceDescriptor,
  isSurfaceFrame,
  pointFromSurfaceCoordinates,
  projectPointToSurface,
} from '../core'

/**
 * Geometry in this module is deliberately surface-local.  Keeping all of the
 * expensive work in two dimensions makes the placement interaction usable for
 * both a Three.js viewer and a headless state reducer.
 */
export const GEOMETRY_EPSILON = 1e-9

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isFinitePoint = (point: unknown): point is Point2 => isPoint2(point)

/** Narrow Array.isArray's legacy any[] result to an unknown[] at boundaries. */
const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value)

const isFinitePoint3 = (point: unknown): point is Point3 => isPoint3(point)

const isFiniteRect = (rect: unknown): rect is Rect => {
  if (typeof rect !== 'object' || rect === null) return false
  const candidate = rect as Record<string, unknown>
  return isFiniteNumber(candidate.x)
    && isFiniteNumber(candidate.y)
    && isFiniteNumber(candidate.width)
    && isFiniteNumber(candidate.height)
}

/** Return a positive rectangle, or undefined for malformed/degenerate data. */
export function normaliseRect(rect: unknown): Rect | undefined {
  if (!isFiniteRect(rect) || Math.abs(rect.width) <= GEOMETRY_EPSILON || Math.abs(rect.height) <= GEOMETRY_EPSILON) return undefined
  return {
    x: rect.width < 0 ? rect.x + rect.width : rect.x,
    y: rect.height < 0 ? rect.y + rect.height : rect.y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  }
}

const isPolygon = (region: unknown): region is Polygon => isCorePolygon(region)

/** Bounds of a valid surface region.  Polygon bounds are only an acceleration aid. */
export function boundsOfRegion(region: unknown): Rect | undefined {
  if (!isPolygon(region)) return normaliseRect(region)
  if (region.points.length < 3 || region.points.some((point) => !isFinitePoint(point))) return undefined
  const xs = region.points.map((point) => point.x)
  const ys = region.points.map((point) => point.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return maxX - minX <= GEOMETRY_EPSILON || maxY - minY <= GEOMETRY_EPSILON
    ? undefined
    : { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

const distanceSquared = (a: Point2, b: Point2): number => {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

const pointToSegmentDistanceSquared = (point: Point2, start: Point2, end: Point2): number => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= GEOMETRY_EPSILON) return distanceSquared(point, start)
  const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
  return distanceSquared(point, { x: start.x + projection * dx, y: start.y + projection * dy })
}

/** Inclusive point-in-polygon test. Points on an edge count as inside. */
export function pointInPolygon(point: unknown, polygon: unknown): boolean {
  if (!isFinitePoint(point) || !isUnknownArray(polygon)) return false
  const points = polygon.filter(isFinitePoint)
  if (points.length < 3 || points.length !== polygon.length || !isSimplePolygon(points)) return false
  let inside = false
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const current = points[index]
    const prior = points[previous]
    if (current === undefined || prior === undefined) return false
    if (pointToSegmentDistanceSquared(point, prior, current) <= GEOMETRY_EPSILON * GEOMETRY_EPSILON) return true
    const crosses = (current.y > point.y) !== (prior.y > point.y)
    if (crosses && point.x < ((prior.x - current.x) * (point.y - current.y)) / (prior.y - current.y) + current.x) inside = !inside
  }
  return inside
}

const cross2 = (a: Point2, b: Point2, c: Point2): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

const onSegment = (a: Point2, b: Point2, point: Point2): boolean =>
  point.x >= Math.min(a.x, b.x) - GEOMETRY_EPSILON
  && point.x <= Math.max(a.x, b.x) + GEOMETRY_EPSILON
  && point.y >= Math.min(a.y, b.y) - GEOMETRY_EPSILON
  && point.y <= Math.max(a.y, b.y) + GEOMETRY_EPSILON
  && Math.abs(cross2(a, b, point)) <= GEOMETRY_EPSILON

const segmentsIntersect = (a: Point2, b: Point2, c: Point2, d: Point2): boolean => {
  const first = cross2(a, b, c)
  const second = cross2(a, b, d)
  const third = cross2(c, d, a)
  const fourth = cross2(c, d, b)
  if (((first > GEOMETRY_EPSILON && second < -GEOMETRY_EPSILON) || (first < -GEOMETRY_EPSILON && second > GEOMETRY_EPSILON))
    && ((third > GEOMETRY_EPSILON && fourth < -GEOMETRY_EPSILON) || (third < -GEOMETRY_EPSILON && fourth > GEOMETRY_EPSILON))) return true
  return (Math.abs(first) <= GEOMETRY_EPSILON && onSegment(a, b, c))
    || (Math.abs(second) <= GEOMETRY_EPSILON && onSegment(a, b, d))
    || (Math.abs(third) <= GEOMETRY_EPSILON && onSegment(c, d, a))
    || (Math.abs(fourth) <= GEOMETRY_EPSILON && onSegment(c, d, b))
}

const properSegmentsIntersect = (a: Point2, b: Point2, c: Point2, d: Point2): boolean => {
  const first = cross2(a, b, c)
  const second = cross2(a, b, d)
  const third = cross2(c, d, a)
  const fourth = cross2(c, d, b)
  return ((first > GEOMETRY_EPSILON && second < -GEOMETRY_EPSILON)
    || (first < -GEOMETRY_EPSILON && second > GEOMETRY_EPSILON))
    && ((third > GEOMETRY_EPSILON && fourth < -GEOMETRY_EPSILON)
      || (third < -GEOMETRY_EPSILON && fourth > GEOMETRY_EPSILON))
}

const segmentDistanceSquared = (a: Point2, b: Point2, c: Point2, d: Point2): number => {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(
    pointToSegmentDistanceSquared(a, c, d),
    pointToSegmentDistanceSquared(b, c, d),
    pointToSegmentDistanceSquared(c, a, b),
    pointToSegmentDistanceSquared(d, a, b),
  )
}

const isSimplePolygon = (polygon: readonly Point2[]): boolean => {
  if (polygon.length < 3) return false
  let signedArea = 0
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]
    const next = polygon[(index + 1) % polygon.length]
    if (current === undefined || next === undefined) return false
    if (distanceSquared(current, next) <= GEOMETRY_EPSILON * GEOMETRY_EPSILON) return false
    signedArea += current.x * next.y - next.x * current.y
  }
  if (Math.abs(signedArea) <= GEOMETRY_EPSILON) return false
  for (let first = 0; first < polygon.length; first += 1) {
    const firstStart = polygon[first]
    const firstEnd = polygon[(first + 1) % polygon.length]
    if (firstStart === undefined || firstEnd === undefined) return false
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondStart = polygon[second]
      const secondEnd = polygon[(second + 1) % polygon.length]
      if (secondStart === undefined || secondEnd === undefined) return false
      const adjacent = second === first + 1 || (first === 0 && second === polygon.length - 1)
      if (!adjacent && segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return false
    }
  }
  return true
}

export function rectangleCorners(rectangle: unknown): readonly Point2[] {
  const normalised = normaliseRect(rectangle)
  if (normalised === undefined) return []
  return [
    { x: normalised.x, y: normalised.y },
    { x: normalised.x + normalised.width, y: normalised.y },
    { x: normalised.x + normalised.width, y: normalised.y + normalised.height },
    { x: normalised.x, y: normalised.y + normalised.height },
  ]
}

const rectangleEdges = (rectangle: unknown): readonly [Point2, Point2][] => {
  const corners = rectangleCorners(rectangle)
  const [first, second, third, fourth] = corners
  return first === undefined || second === undefined || third === undefined || fourth === undefined
    ? []
    : [[first, second], [second, third], [third, fourth], [fourth, first]]
}

/** Inclusive rectangle collision test. Touching edges are considered blocked. */
export function rectanglesOverlap(first: unknown, second: unknown): boolean {
  const a = normaliseRect(first)
  const b = normaliseRect(second)
  if (a === undefined || b === undefined) return false
  return a.x <= b.x + b.width + GEOMETRY_EPSILON
    && a.x + a.width + GEOMETRY_EPSILON >= b.x
    && a.y <= b.y + b.height + GEOMETRY_EPSILON
    && a.y + a.height + GEOMETRY_EPSILON >= b.y
}

/** Inclusive collision test after applying horizontal/vertical spacing. */
export function rectanglesOverlapWithSpacing(
  first: unknown,
  second: unknown,
  interPanelSpacingM: unknown,
  rowSpacingM: unknown = interPanelSpacingM,
): boolean {
  if (!isFiniteNumber(interPanelSpacingM) || interPanelSpacingM < 0
    || !isFiniteNumber(rowSpacingM) || rowSpacingM < 0) return false
  const firstRect = normaliseRect(first)
  const secondRect = normaliseRect(second)
  if (firstRect === undefined || secondRect === undefined) return false
  // Expand by the complete required clear gap on every side.  Subtracting a
  // tiny epsilon keeps panels whose edges are exactly `spacing` apart valid,
  // while still treating a touching/overlapping pair as blocked.
  const horizontal = Math.max(0, interPanelSpacingM - 2 * GEOMETRY_EPSILON)
  const vertical = Math.max(0, rowSpacingM - 2 * GEOMETRY_EPSILON)
  return rectanglesOverlap(
    { x: firstRect.x - horizontal, y: firstRect.y - vertical, width: firstRect.width + 2 * horizontal, height: firstRect.height + 2 * vertical },
    secondRect,
  )
}

const validNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0

/** A strict runtime check for the frame data used by placement transforms. */
export function isValidSurfaceFrame(frame: unknown): frame is SurfaceFrame {
  if (!isSurfaceFrame(frame)) return false
  const vectors = [frame.normal, frame.tangentX, frame.tangentY]
  if (vectors.some((vector) => !isFinitePoint3(vector))) return false
  const normalLength = Math.hypot(frame.normal.x, frame.normal.y, frame.normal.z)
  const tangentXLength = Math.hypot(frame.tangentX.x, frame.tangentX.y, frame.tangentX.z)
  const tangentYLength = Math.hypot(frame.tangentY.x, frame.tangentY.y, frame.tangentY.z)
  if (normalLength <= GEOMETRY_EPSILON || tangentXLength <= GEOMETRY_EPSILON || tangentYLength <= GEOMETRY_EPSILON) return false
  const normal = { x: frame.normal.x / normalLength, y: frame.normal.y / normalLength, z: frame.normal.z / normalLength }
  const tangentX = { x: frame.tangentX.x / tangentXLength, y: frame.tangentX.y / tangentXLength, z: frame.tangentX.z / tangentXLength }
  const tangentY = { x: frame.tangentY.x / tangentYLength, y: frame.tangentY.y / tangentYLength, z: frame.tangentY.z / tangentYLength }
  const handedness = dot(cross(tangentX, tangentY), normal)
  const orthogonal = (first: SurfaceNormal, second: SurfaceNormal): boolean => Math.abs(dot(first, second)) <= 1e-6
  return isFinitePoint3(frame.origin)
    && orthogonal(normal, tangentX)
    && orthogonal(normal, tangentY)
    && orthogonal(tangentX, tangentY)
    && handedness > 1e-6
}

/** A strict runtime check for a complete selectable surface descriptor. */
export function isValidSurfaceDescriptor(surface: unknown): surface is SurfaceDescriptor {
  if (!isSurfaceDescriptor(surface) || !isValidSurfaceFrame(surface.frame) || boundsOfRegion(surface.region) === undefined) return false
  return !isPolygon(surface.region) || isSimplePolygon(surface.region.points)
}

const validSetback = (setbackM: unknown): setbackM is number => isFiniteNumber(setbackM) && validNonNegative(setbackM)

/** Whether a rectangle is wholly inside a rectangular region after setback. */
export function rectangleInsideRegion(rectangle: unknown, region: unknown, setbackM: unknown): boolean {
  const candidate = normaliseRect(rectangle)
  const boundary = isRect(region) ? region : undefined
  if (candidate === undefined || boundary === undefined || !validSetback(setbackM)) return false
  const setback = setbackM
  return candidate.x >= boundary.x + setback - GEOMETRY_EPSILON
    && candidate.y >= boundary.y + setback - GEOMETRY_EPSILON
    && candidate.x + candidate.width <= boundary.x + boundary.width - setback + GEOMETRY_EPSILON
    && candidate.y + candidate.height <= boundary.y + boundary.height - setback + GEOMETRY_EPSILON
}

/** Whether a rectangle is wholly inside a polygon after setback. */
export function rectangleInsidePolygon(rectangle: unknown, polygon: unknown, setbackM: unknown): boolean {
  const candidate = normaliseRect(rectangle)
  if (candidate === undefined || !isUnknownArray(polygon) || !validSetback(setbackM)) return false
  const points = polygon.filter(isFinitePoint)
  if (points.length < 3 || points.length !== polygon.length || !isSimplePolygon(points)) return false
  const setback = setbackM
  const corners = rectangleCorners(candidate)
  for (const corner of corners) {
    if (!pointInPolygon(corner, points)) return false
    let nearestEdgeDistanceSquared = Number.POSITIVE_INFINITY
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index]
      const end = points[(index + 1) % points.length]
      if (start !== undefined && end !== undefined) nearestEdgeDistanceSquared = Math.min(nearestEdgeDistanceSquared, pointToSegmentDistanceSquared(corner, start, end))
    }
    if (nearestEdgeDistanceSquared < setback * setback - GEOMETRY_EPSILON) return false
  }
  // A concave boundary can pass through a candidate even when all four corners
  // happen to be inside. Reject proper edge crossings. Collinear boundary
  // contact is allowed when the setback is zero, but any non-zero edge gap is
  // checked below as well.
  const candidateEdges = rectangleEdges(candidate)
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (start === undefined || end === undefined) continue
    for (const [edgeStart, edgeEnd] of candidateEdges) {
      if (properSegmentsIntersect(start, end, edgeStart, edgeEnd)) return false
      if (setback > GEOMETRY_EPSILON && segmentDistanceSquared(start, end, edgeStart, edgeEnd) < setback * setback - GEOMETRY_EPSILON) return false
    }
  }
  return true
}

export function rectangleInsideSurfaceRegion(rectangle: unknown, region: unknown, setbackM: unknown): boolean {
  return isPolygon(region)
    ? rectangleInsidePolygon(rectangle, region.points, setbackM)
    : isRect(region) && rectangleInsideRegion(rectangle, region, setbackM)
}

const obstacleRectangles = (obstacles: unknown): readonly Rect[] | undefined => {
  if (obstacles === undefined) return []
  if (!Array.isArray(obstacles)) return undefined
  const result: Rect[] = []
  for (const obstacle of obstacles) {
    if (!isRectangularObstacle(obstacle)) return undefined
    const valid = normaliseRect(obstacle)
    if (valid === undefined || obstacle.width <= 0 || obstacle.height <= 0) return undefined
    result.push(valid)
  }
  return result
}

export function candidateBounds(candidate: unknown): Rect | undefined {
  if (!isAutoFillCandidate(candidate)) return undefined
  return {
    x: candidate.localCenter.x - candidate.footprint.widthM / 2,
    y: candidate.localCenter.y - candidate.footprint.heightM / 2,
    width: candidate.footprint.widthM,
    height: candidate.footprint.heightM,
  }
}

export function orientedFootprint(panel: Pick<PanelDefinition, 'widthM' | 'heightM'>, orientation: 'portrait' | 'landscape'): PanelFootprint {
  return orientation === 'portrait'
    ? { widthM: panel.widthM, heightM: panel.heightM }
    : { widthM: panel.heightM, heightM: panel.widthM }
}

const validPanel = (panel: unknown): panel is Pick<PanelDefinition, 'widthM' | 'heightM'> => {
  if (typeof panel !== 'object' || panel === null) return false
  const candidate = panel as Record<string, unknown>
  return isFiniteNumber(candidate.widthM) && candidate.widthM > 0
    && isFiniteNumber(candidate.heightM) && candidate.heightM > 0
}

const validSettings = (request: AutoFillRequest): {
  readonly orientation: 'portrait' | 'landscape'
  readonly interPanelSpacingM: number
  readonly rowSpacingM: number
  readonly setbackM: number
  readonly clearanceM: number
  readonly tiltDeg: number
} | undefined => {
  const settings = request.settings
  const orientation = typeof settings.orientation === 'string' ? settings.orientation : ''
  if (orientation !== 'portrait' && orientation !== 'landscape') return undefined
  if (!Number.isFinite(settings.interPanelSpacingM) || settings.interPanelSpacingM < 0) return undefined
  if (!Number.isFinite(settings.rowSpacingM) || settings.rowSpacingM < 0) return undefined
  if (!Number.isFinite(settings.setbackM) || settings.setbackM < 0) return undefined
  if (!Number.isFinite(settings.clearanceM) || settings.clearanceM < 0) return undefined
  if (!Number.isFinite(settings.tiltDeg) || settings.tiltDeg < 0 || settings.tiltDeg > 90) return undefined
  return {
    orientation,
    interPanelSpacingM: settings.interPanelSpacingM,
    rowSpacingM: settings.rowSpacingM,
    setbackM: settings.setbackM,
    clearanceM: settings.clearanceM,
    tiltDeg: settings.tiltDeg,
  }
}

/**
 * Deterministically lay panels on a local rectangular or polygonal region.
 * Candidates are emitted row-major, which keeps previews stable and makes
 * undo/redo and persisted layouts reproducible.  The algorithm is O(rows ×
 * columns × obstacles) and remains comfortably below two seconds for hundreds
 * of panels in normal roof-sized regions.
 */
export function generateAutoFill(panel: Pick<PanelDefinition, 'widthM' | 'heightM'>, request: AutoFillRequest): readonly AutoFillCandidate[] {
  if (!validPanel(panel) || !isAutoFillRequest(request)) return []
  const bounds = boundsOfRegion(request.region)
  if (bounds === undefined) return []
  const settings = validSettings(request)
  if (settings === undefined) return []
  const footprint = orientedFootprint(panel, settings.orientation)
  const obstacles = obstacleRectangles(request.obstacles)
  if (obstacles === undefined) return []
  const stepX = footprint.widthM + settings.interPanelSpacingM
  const stepY = footprint.heightM + settings.rowSpacingM
  if (!Number.isFinite(stepX) || !Number.isFinite(stepY) || stepX <= GEOMETRY_EPSILON || stepY <= GEOMETRY_EPSILON) return []
  const startX = bounds.x + settings.setbackM + footprint.widthM / 2
  const startY = bounds.y + settings.setbackM + footprint.heightM / 2
  const endX = bounds.x + bounds.width - settings.setbackM - footprint.widthM / 2
  const endY = bounds.y + bounds.height - settings.setbackM - footprint.heightM / 2
  if (startX > endX + GEOMETRY_EPSILON || startY > endY + GEOMETRY_EPSILON) return []
  const candidates: AutoFillCandidate[] = []
  // Use integer row/column counts rather than accumulated floating point
  // increments; this prevents drift on large surfaces and gives deterministic
  // results across JS engines.
  const columns = Math.max(0, Math.floor((endX - startX + GEOMETRY_EPSILON) / stepX) + 1)
  const rows = Math.max(0, Math.floor((endY - startY + GEOMETRY_EPSILON) / stepY) + 1)
  for (let row = 0; row < rows; row += 1) {
    const centerY = startY + row * stepY
    for (let column = 0; column < columns; column += 1) {
      const centerX = startX + column * stepX
      const candidate: AutoFillCandidate = {
        id: `candidate-${String(candidates.length + 1)}`,
        localCenter: { x: centerX, y: centerY },
        footprint,
        orientation: settings.orientation,
        clearanceM: settings.clearanceM,
        tiltDeg: settings.tiltDeg,
        ...(request.groupId === undefined ? {} : { groupId: request.groupId }),
      }
      const rectangle = candidateBounds(candidate)
      if (rectangle === undefined) continue
      if (!rectangleInsideSurfaceRegion(rectangle, request.region, settings.setbackM)) continue
      if (obstacles.some((obstacle) => rectanglesOverlap(rectangle, obstacle))) continue
      candidates.push(candidate)
    }
  }
  return candidates
}

export function calculateTotalWattage(
  placements: unknown,
  panelDefinitions: unknown,
): number {
  if (!isUnknownArray(placements) || !isRecord(panelDefinitions)) return 0
  const definitions = panelDefinitions
  return placements.reduce<number>((total, placement) => {
    if (!isRecord(placement)) return total
    const candidate = placement
    const panelId = candidate.panelId
    if (typeof panelId !== 'string') return total
    const panel = definitions[panelId]
    if (typeof panel !== 'object' || panel === null) return total
    const wattage = (panel as Record<string, unknown>).wattageW
    return total + (isFiniteNumber(wattage) && wattage >= 0 ? wattage : 0)
  }, 0)
}

export function calculateTotalKwp(
  placements: unknown,
  panelDefinitions: unknown,
): number {
  return calculateTotalWattage(placements, panelDefinitions) / 1000
}

const normaliseVector = (vector: unknown): SurfaceNormal => {
  if (!isFinitePoint3(vector)) return { x: 0, y: 0, z: 1 }
  const safeVector = vector
  const length = Math.hypot(safeVector.x, safeVector.y, safeVector.z)
  return Number.isFinite(length) && length > GEOMETRY_EPSILON
    ? { x: safeVector.x / length, y: safeVector.y / length, z: safeVector.z / length }
    : { x: 0, y: 0, z: 1 }
}

const cross = (a: SurfaceNormal, b: SurfaceNormal): SurfaceNormal => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

const dot = (a: SurfaceNormal, b: SurfaceNormal): number => a.x * b.x + a.y * b.y + a.z * b.z

const subtract = (a: SurfaceNormal, b: SurfaceNormal): SurfaceNormal => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })

/** Build an orthonormal frame around a surface normal. */
export function createSurfaceFrame(origin: Point3, surfaceNormal: SurfaceNormal, preferredAxis: SurfaceNormal = { x: 0, y: 0, z: 1 }): SurfaceFrame {
  if (!isFinitePoint3(origin) || !isFinitePoint3(surfaceNormal) || !isFinitePoint3(preferredAxis)
    || Math.hypot(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z) <= GEOMETRY_EPSILON
    || Math.hypot(preferredAxis.x, preferredAxis.y, preferredAxis.z) <= GEOMETRY_EPSILON) {
    throw new TypeError('createSurfaceFrame received malformed frame vectors')
  }
  const normal = normaliseVector(surfaceNormal)
  const projection = dot(preferredAxis, normal)
  const projected = subtract(preferredAxis, { x: normal.x * projection, y: normal.y * projection, z: normal.z * projection })
  const projectedLength = Math.hypot(projected.x, projected.y, projected.z)
  const fallbackAxis: SurfaceNormal = Math.abs(normal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }
  const fallbackProjection = dot(fallbackAxis, normal)
  const fallback = subtract(fallbackAxis, { x: normal.x * fallbackProjection, y: normal.y * fallbackProjection, z: normal.z * fallbackProjection })
  const axis = projectedLength > GEOMETRY_EPSILON ? projected : fallback
  const axisLength = Math.hypot(axis.x, axis.y, axis.z)
  const tangentX = axisLength > GEOMETRY_EPSILON
    ? { x: axis.x / axisLength, y: axis.y / axisLength, z: axis.z / axisLength }
    : { x: 1, y: 0, z: 0 }
  const tangentY = normaliseVector(cross(normal, tangentX))
  const frame = { origin: { ...origin }, normal, tangentX, tangentY }
  if (!isValidSurfaceFrame(frame)) throw new TypeError('createSurfaceFrame could not construct an orthonormal frame')
  return frame
}

/** Convert a local point to world coordinates, offset by panel clearance. */
export function pointOnSurface(point: Point2, frame: SurfaceFrame, clearanceM = 0): Point3 {
  if (!isPoint2(point) || !isValidSurfaceFrame(frame)) throw new TypeError('pointOnSurface received malformed point or frame')
  if (!Number.isFinite(clearanceM) || clearanceM < 0) throw new RangeError('pointOnSurface clearance must be finite and non-negative')
  const safeClearance = clearanceM
  return pointFromSurfaceCoordinates(frame, point, safeClearance)
}

export const localToWorld = pointOnSurface

/** Return a normalised surface normal while tolerating malformed input. */
export function normaliseSurfaceNormal(normal: SurfaceNormal): SurfaceNormal {
  return normaliseVector(normal)
}

/** A local projection of a world-space ray hit. */
export interface SurfaceRayHit {
  readonly distanceM: number
  readonly worldPoint: Point3
  readonly localPoint: Point2
}

/** Project a world point into a validated surface frame. */
export function projectWorldToLocal(worldPoint: Point3, frame: SurfaceFrame): Point2 | undefined {
  if (!isPoint3(worldPoint) || !isValidSurfaceFrame(frame)) return undefined
  try {
    return projectPointToSurface(frame, worldPoint)
  } catch {
    return undefined
  }
}

/** Project a local point into a validated surface frame. */
export function projectLocalToWorld(localPoint: Point2, frame: SurfaceFrame, normalOffsetM = 0): Point3 | undefined {
  if (!isPoint2(localPoint) || !isValidSurfaceFrame(frame) || !Number.isFinite(normalOffsetM)) return undefined
  try {
    return pointFromSurfaceCoordinates(frame, localPoint, normalOffsetM)
  } catch {
    return undefined
  }
}

/** Intersect a forward ray with a frame plane and return surface-local data. */
export function rayPlaneIntersection(
  rayOrigin: Point3,
  rayDirection: Point3,
  frame: SurfaceFrame,
): SurfaceRayHit | undefined {
  if (!isPoint3(rayOrigin) || !isPoint3(rayDirection) || !isValidSurfaceFrame(frame)) return undefined
  const directionLength = Math.hypot(rayDirection.x, rayDirection.y, rayDirection.z)
  if (directionLength <= GEOMETRY_EPSILON) return undefined
  const normal = normaliseVector(frame.normal)
  const denominator = rayDirection.x * normal.x + rayDirection.y * normal.y + rayDirection.z * normal.z
  if (Math.abs(denominator) <= GEOMETRY_EPSILON) return undefined
  const offset = {
    x: frame.origin.x - rayOrigin.x,
    y: frame.origin.y - rayOrigin.y,
    z: frame.origin.z - rayOrigin.z,
  }
  const rayParameter = (offset.x * normal.x + offset.y * normal.y + offset.z * normal.z) / denominator
  if (!Number.isFinite(rayParameter) || rayParameter < -GEOMETRY_EPSILON) return undefined
  const distanceM = Math.max(0, rayParameter) * directionLength
  const worldPoint = {
    x: rayOrigin.x + rayDirection.x * rayParameter,
    y: rayOrigin.y + rayDirection.y * rayParameter,
    z: rayOrigin.z + rayDirection.z * rayParameter,
  }
  const localPoint = projectWorldToLocal(worldPoint, frame)
  return localPoint === undefined ? undefined : { distanceM, worldPoint, localPoint }
}

/** Alias with wording matching viewer hit-resolution call sites. */
export const rayHitToLocal = rayPlaneIntersection
