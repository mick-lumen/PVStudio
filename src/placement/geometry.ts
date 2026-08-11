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
  SurfaceEdgeMetadata,
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
  SURFACE_EDGE_DIRECTION_EPSILON,
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
  if (!isPolygon(region)) return isRect(region) && rectangleInsideRegion(rectangle, region, setbackM)
  if (!rectangleInsidePolygon(rectangle, region.points, setbackM)) return false
  const candidate = normaliseRect(rectangle)
  const setback = typeof setbackM === 'number' && Number.isFinite(setbackM) ? setbackM : -1
  if (candidate === undefined || setback < 0) return false
  const candidateCorners = rectangleCorners(candidate)
  const candidateEdges = rectangleEdges(candidate)
  for (const hole of region.holes ?? []) {
    if (candidateCorners.some((corner) => pointInPolygon(corner, hole))) return false
    if (hole.some((point) => point.x >= candidate.x - GEOMETRY_EPSILON
      && point.x <= candidate.x + candidate.width + GEOMETRY_EPSILON
      && point.y >= candidate.y - GEOMETRY_EPSILON
      && point.y <= candidate.y + candidate.height + GEOMETRY_EPSILON)) return false
    for (let index = 0; index < hole.length; index += 1) {
      const start = hole[index]
      const end = hole[(index + 1) % hole.length]
      if (start === undefined || end === undefined) continue
      for (const [edgeStart, edgeEnd] of candidateEdges) {
        if (segmentsIntersect(start, end, edgeStart, edgeEnd)) return false
        if (setback > GEOMETRY_EPSILON
          && segmentDistanceSquared(start, end, edgeStart, edgeEnd) < setback * setback - GEOMETRY_EPSILON) return false
      }
    }
  }
  return true
}

/** Local axes used by placement rows and panel poses.
 *
 * `rowAxis`/`crossAxis` are the sign-invariant physical basis used by panel
 * poses and collision checks.  They are always right-handed in local 2D
 * space. `traversalSign` carries the authored edge direction separately so
 * auto-fill can enumerate rows in that direction without making a
 * left-handed panel basis. Omitting edge metadata intentionally returns the
 * canonical frame used by legacy payloads.
 */
export interface SurfaceEdgeAxes {
  readonly rowAxis: Point2
  readonly crossAxis: Point2
  readonly traversalSign: 1 | -1
}

/** Rotate a logical surface basis clockwise by an authored array azimuth. */
export function rotateSurfaceEdgeAxes(axes: SurfaceEdgeAxes, azimuthDeg = 0): SurfaceEdgeAxes {
  if (!Number.isFinite(azimuthDeg)) return axes
  const radians = azimuthDeg * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const rotate = (point: Point2): Point2 => ({
    x: canonicalZero(point.x * cosine - point.y * sine),
    y: canonicalZero(point.x * sine + point.y * cosine),
  })
  return { rowAxis: rotate(axes.rowAxis), crossAxis: rotate(axes.crossAxis), traversalSign: axes.traversalSign }
}

const canonicalZero = (value: number): number => (value === 0 ? 0 : value)

const negatePoint2 = (point: Point2): Point2 => ({
  x: canonicalZero(-point.x),
  y: canonicalZero(-point.y),
})

const normalisePoint2 = (point: Point2): Point2 => {
  const magnitude = Math.hypot(point.x, point.y)
  return magnitude > SURFACE_EDGE_DIRECTION_EPSILON
    ? { x: canonicalZero(point.x / magnitude), y: canonicalZero(point.y / magnitude) }
    : { x: 1, y: 0 }
}

const orientAxisToReference = (axis: Point2, reference: Point2): Point2 => {
  const canonicalAxis = { x: canonicalZero(axis.x), y: canonicalZero(axis.y) }
  const alignment = canonicalAxis.x * reference.x + canonicalAxis.y * reference.y
  if (alignment < -SURFACE_EDGE_DIRECTION_EPSILON) return negatePoint2(canonicalAxis)
  if (Math.abs(alignment) <= SURFACE_EDGE_DIRECTION_EPSILON) {
    // A line parallel to canonical downhill has no unique left/right side.
    // Pick a sign from the axis itself, which is invariant under edge reversal
    // because the tie-break is based on absolute direction, not row order.
    if (canonicalAxis.x < -SURFACE_EDGE_DIRECTION_EPSILON
      || (Math.abs(canonicalAxis.x) <= SURFACE_EDGE_DIRECTION_EPSILON && canonicalAxis.y < 0)) return negatePoint2(canonicalAxis)
  }
  return canonicalAxis
}

/** Choose one deterministic representative for an unoriented line axis. */
const canonicalUnorientedAxis = (axis: Point2): Point2 => {
  const normalised = normalisePoint2(axis)
  return normalised.x < -SURFACE_EDGE_DIRECTION_EPSILON
    || (Math.abs(normalised.x) <= SURFACE_EDGE_DIRECTION_EPSILON && normalised.y < 0)
    ? negatePoint2(normalised)
    : normalised
}

const axisDeterminant = (rowAxis: Point2, crossAxis: Point2): number =>
  rowAxis.x * crossAxis.y - rowAxis.y * crossAxis.x

const surfaceRegionPoints = (region: SurfaceDescriptor['region']): readonly Point2[] => {
  if (isRect(region)) return [
    { x: region.x, y: region.y },
    { x: region.x + region.width, y: region.y },
    { x: region.x + region.width, y: region.y + region.height },
    { x: region.x, y: region.y + region.height },
  ]
  return isPolygon(region) ? region.points : []
}

/**
 * Infer which side of an authored edge line contains the surface. Averaging
 * signed distances is stable for concave regions and does not require a
 * centroid that itself lies inside the polygon.
 */
const surfaceInteriorSide = (
  line: NonNullable<SurfaceEdgeMetadata['line']>,
  region: SurfaceDescriptor['region'],
): Point2 | undefined => {
  const points = surfaceRegionPoints(region)
  if (points.length === 0) return undefined
  const direction = normalisePoint2(line.direction)
  const left = { x: -direction.y, y: direction.x }
  const signedDistanceSum = points.reduce((sum, point) => sum
    + (point.x - line.origin.x) * left.x
    + (point.y - line.origin.y) * left.y, 0)
  if (Math.abs(signedDistanceSum) <= SURFACE_EDGE_DIRECTION_EPSILON) return undefined
  return signedDistanceSum > 0 ? left : negatePoint2(left)
}

export function deriveSurfaceEdgeAxes(
  edge: SurfaceEdgeMetadata | undefined,
  region?: SurfaceDescriptor['region'],
): SurfaceEdgeAxes {
  if (edge === undefined || !isFinitePoint(edge.direction) || Math.hypot(edge.direction.x, edge.direction.y) <= SURFACE_EDGE_DIRECTION_EPSILON) {
    return { rowAxis: { x: 1, y: 0 }, crossAxis: { x: 0, y: 1 }, traversalSign: 1 }
  }
  const authoredDirection = normalisePoint2(edge.direction)
  let rowAxis = canonicalUnorientedAxis(authoredDirection)
  let crossAxis: Point2 = orientAxisToReference({ x: -rowAxis.y, y: rowAxis.x }, { x: 0, y: 1 })
  // An authored line can identify the roof-facing side. Its direction is
  // deliberately independent of the selected row direction, so reversing
  // the row never changes the downhill/cross physical side.
  if (edge.line !== undefined) {
    const lineDirection = normalisePoint2(edge.line.direction)
    const lineLeft = { x: -lineDirection.y, y: lineDirection.x }
    const interiorSide = edge.side === undefined
      ? region === undefined ? undefined : surfaceInteriorSide(edge.line, region)
      : edge.side === 'right' ? negatePoint2(lineLeft) : lineLeft
    if (interiorSide !== undefined) {
      // Low edges (gutters and valleys) face toward the authored line; high
      // or perimeter edges face into the roof. Reversing the line or row does
      // not change this physical side.
      const facingReference = edge.type === 'gutter' || edge.type === 'valley'
        ? negatePoint2(interiorSide)
        : interiorSide
      crossAxis = orientAxisToReference(crossAxis, facingReference)
    }
  }
  // The edge metadata describes a physical line, not a second orientation
  // basis. Keep the panel basis right-handed even when the authored side is
  // opposite the canonical perpendicular: reversing the row then changes
  // only traversalSign, never the physical cross/downhill direction.
  if (axisDeterminant(rowAxis, crossAxis) < 0) rowAxis = negatePoint2(rowAxis)
  const traversalSign: 1 | -1 = authoredDirection.x * rowAxis.x + authoredDirection.y * rowAxis.y >= 0 ? 1 : -1
  return { rowAxis, crossAxis, traversalSign }
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
  readonly modulesPerRow?: number
  readonly rowOffsetM?: number
  readonly obstacleClearanceM?: number
} | undefined => {
  const settings = request.settings
  const orientation = typeof settings.orientation === 'string' ? settings.orientation : ''
  if (orientation !== 'portrait' && orientation !== 'landscape') return undefined
  if (!Number.isFinite(settings.interPanelSpacingM) || settings.interPanelSpacingM < 0) return undefined
  if (!Number.isFinite(settings.rowSpacingM) || settings.rowSpacingM < 0) return undefined
  if (!Number.isFinite(settings.setbackM) || settings.setbackM < 0) return undefined
  if (!Number.isFinite(settings.clearanceM) || settings.clearanceM < 0) return undefined
  if (!Number.isFinite(settings.tiltDeg) || settings.tiltDeg < 0 || settings.tiltDeg > 90) return undefined
  if (settings.modulesPerRow !== undefined
    && (!Number.isFinite(settings.modulesPerRow) || !Number.isInteger(settings.modulesPerRow) || settings.modulesPerRow <= 0)) return undefined
  if (settings.rowOffsetM !== undefined && (!Number.isFinite(settings.rowOffsetM) || settings.rowOffsetM < 0)) return undefined
  if (settings.obstacleClearanceM !== undefined
    && (!Number.isFinite(settings.obstacleClearanceM) || settings.obstacleClearanceM < 0)) return undefined
  return {
    orientation,
    interPanelSpacingM: settings.interPanelSpacingM,
    rowSpacingM: settings.rowSpacingM,
    setbackM: settings.setbackM,
    clearanceM: settings.clearanceM,
    tiltDeg: settings.tiltDeg,
    ...(settings.modulesPerRow === undefined ? {} : { modulesPerRow: settings.modulesPerRow }),
    ...(settings.rowOffsetM === undefined ? {} : { rowOffsetM: settings.rowOffsetM }),
    ...(settings.obstacleClearanceM === undefined ? {} : { obstacleClearanceM: settings.obstacleClearanceM }),
  }
}

const regionPoints = (region: SurfaceDescriptor['region']): readonly Point2[] => {
  if (isRect(region)) return rectangleCorners(region)
  return isPolygon(region) ? region.points : []
}

const projectToAxis = (point: Point2, axis: Point2): number => point.x * axis.x + point.y * axis.y

const projectedRegionBounds = (
  region: SurfaceDescriptor['region'],
  axes: SurfaceEdgeAxes,
): { readonly rowMin: number; readonly rowMax: number; readonly crossMin: number; readonly crossMax: number } | undefined => {
  const points = regionPoints(region)
  if (points.length === 0) return undefined
  const rowValues = points.map((point) => projectToAxis(point, axes.rowAxis))
  const crossValues = points.map((point) => projectToAxis(point, axes.crossAxis))
  const rowMin = Math.min(...rowValues)
  const rowMax = Math.max(...rowValues)
  const crossMin = Math.min(...crossValues)
  const crossMax = Math.max(...crossValues)
  return Number.isFinite(rowMin) && Number.isFinite(rowMax) && Number.isFinite(crossMin) && Number.isFinite(crossMax)
    && rowMax - rowMin > GEOMETRY_EPSILON && crossMax - crossMin > GEOMETRY_EPSILON
    ? { rowMin, rowMax, crossMin, crossMax }
    : undefined
}

const pointFromAxes = (row: number, crossValue: number, axes: SurfaceEdgeAxes): Point2 => ({
  x: axes.rowAxis.x * row + axes.crossAxis.x * crossValue,
  y: axes.rowAxis.y * row + axes.crossAxis.y * crossValue,
})

export const orientedFootprintCorners = (centre: Point2, widthM: number, heightM: number, axes: SurfaceEdgeAxes): readonly Point2[] => {
  const rowOffset = { x: axes.rowAxis.x * widthM / 2, y: axes.rowAxis.y * widthM / 2 }
  const crossOffset = { x: axes.crossAxis.x * heightM / 2, y: axes.crossAxis.y * heightM / 2 }
  return [
    { x: centre.x - rowOffset.x - crossOffset.x, y: centre.y - rowOffset.y - crossOffset.y },
    { x: centre.x + rowOffset.x - crossOffset.x, y: centre.y + rowOffset.y - crossOffset.y },
    { x: centre.x + rowOffset.x + crossOffset.x, y: centre.y + rowOffset.y + crossOffset.y },
    { x: centre.x - rowOffset.x + crossOffset.x, y: centre.y - rowOffset.y + crossOffset.y },
  ]
}

const orientedCorners = orientedFootprintCorners

const pointInsideSurfaceRegion = (point: Point2, region: SurfaceDescriptor['region'], setbackM: number): boolean => {
  if (isRect(region)) {
    return point.x >= region.x + setbackM - GEOMETRY_EPSILON
      && point.y >= region.y + setbackM - GEOMETRY_EPSILON
      && point.x <= region.x + region.width - setbackM + GEOMETRY_EPSILON
      && point.y <= region.y + region.height - setbackM + GEOMETRY_EPSILON
  }
  if (!isPolygon(region)) return false
  if (!pointInPolygon(point, region.points)) return false
  if ((region.holes ?? []).some((hole) => pointInPolygon(point, hole))) return false
  const rings = [region.points, ...(region.holes ?? [])]
  if (setbackM <= GEOMETRY_EPSILON) return true
  const minimumDistanceSquared = rings.reduce((ringMinimum, ring) => Math.min(ringMinimum, ring.reduce((minimum, start, index) => {
    const end = ring[(index + 1) % ring.length]
    return end === undefined ? minimum : Math.min(minimum, pointToSegmentDistanceSquared(point, start, end))
  }, Number.POSITIVE_INFINITY)), Number.POSITIVE_INFINITY)
  return minimumDistanceSquared >= setbackM * setbackM - GEOMETRY_EPSILON
}

export const orientedCandidateInsideRegion = (
  centre: Point2,
  widthM: number,
  heightM: number,
  region: SurfaceDescriptor['region'],
  axes: SurfaceEdgeAxes,
  setbackM: number,
): boolean => {
  const corners = orientedCorners(centre, widthM, heightM, axes)
  if (!corners.every((corner) => pointInsideSurfaceRegion(corner, region, setbackM))) return false
  if (!isPolygon(region)) return true
  // `rectangleEdges` is axis-aligned, so use the oriented corners directly
  // for edge-crossing and clearance checks against concave boundaries.
  const orientedEdges: readonly [Point2, Point2][] = corners.map((start, index) => {
    const end = corners[(index + 1) % corners.length] ?? start
    return [start, end]
  })
  for (const ring of [region.points, ...(region.holes ?? [])]) {
    if (ring.some((point) => pointInPolygon(point, corners))) return false
    for (let index = 0; index < ring.length; index += 1) {
      const start = ring[index]
      const end = ring[(index + 1) % ring.length]
      if (start === undefined || end === undefined) continue
      for (const [edgeStart, edgeEnd] of orientedEdges) {
        if (segmentsIntersect(start, end, edgeStart, edgeEnd)) return false
        if (setbackM > GEOMETRY_EPSILON
          && segmentDistanceSquared(start, end, edgeStart, edgeEnd) < setbackM * setbackM - GEOMETRY_EPSILON) return false
      }
    }
  }
  return true
}

export const polygonOverlap = (first: readonly Point2[], second: readonly Point2[]): boolean => {
  const axes: Point2[] = []
  const addAxes = (points: readonly Point2[]): void => {
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index]
      const end = points[(index + 1) % points.length]
      if (start === undefined || end === undefined) continue
      const edge = { x: end.x - start.x, y: end.y - start.y }
      const length = Math.hypot(edge.x, edge.y)
      if (length > GEOMETRY_EPSILON) axes.push({ x: -edge.y / length, y: edge.x / length })
    }
  }
  addAxes(first)
  addAxes(second)
  return axes.every((axis) => {
    const firstValues = first.map((point) => projectToAxis(point, axis))
    const secondValues = second.map((point) => projectToAxis(point, axis))
    return Math.max(...firstValues) >= Math.min(...secondValues) - GEOMETRY_EPSILON
      && Math.max(...secondValues) >= Math.min(...firstValues) - GEOMETRY_EPSILON
  })
}

export const orientedObstacleOverlap = (
  centre: Point2,
  widthM: number,
  heightM: number,
  obstacle: Rect,
  axes: SurfaceEdgeAxes,
): boolean => polygonOverlap(orientedCorners(centre, widthM, heightM, axes), rectangleCorners(obstacle))

const expandObstacle = (obstacle: Rect, clearanceM: number): Rect => ({
  x: obstacle.x - clearanceM,
  y: obstacle.y - clearanceM,
  width: obstacle.width + 2 * clearanceM,
  height: obstacle.height + 2 * clearanceM,
})

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
  const edgeAxes = deriveSurfaceEdgeAxes(request.edge, request.region)
  const hasEdge = request.edge !== undefined
  const traversalAxes: SurfaceEdgeAxes = hasEdge && edgeAxes.traversalSign === -1
    ? { ...edgeAxes, rowAxis: negatePoint2(edgeAxes.rowAxis) }
    : edgeAxes
  const projected = hasEdge ? projectedRegionBounds(request.region, traversalAxes) : undefined
  const rowMin = projected?.rowMin ?? bounds.x
  const rowMax = projected?.rowMax ?? bounds.x + bounds.width
  const crossMin = projected?.crossMin ?? bounds.y
  const crossMax = projected?.crossMax ?? bounds.y + bounds.height
  const stepRow = footprint.widthM + settings.interPanelSpacingM
  const stepCross = footprint.heightM + settings.rowSpacingM
  if (!Number.isFinite(stepRow) || !Number.isFinite(stepCross) || stepRow <= GEOMETRY_EPSILON || stepCross <= GEOMETRY_EPSILON) return []
  const startRow = rowMin + settings.setbackM + footprint.widthM / 2
  const startCross = crossMin + settings.setbackM + footprint.heightM / 2
  const endRow = rowMax - settings.setbackM - footprint.widthM / 2
  const endCross = crossMax - settings.setbackM - footprint.heightM / 2
  if (startRow > endRow + GEOMETRY_EPSILON || startCross > endCross + GEOMETRY_EPSILON) return []
  const candidates: AutoFillCandidate[] = []
  // Use integer row/column counts rather than accumulated floating point
  // increments; this prevents drift on large surfaces and gives deterministic
  // results across JS engines.
  const availableColumns = Math.max(0, Math.floor((endRow - startRow + GEOMETRY_EPSILON) / stepRow) + 1)
  const columns = settings.modulesPerRow === undefined
    ? availableColumns
    : Math.min(availableColumns, settings.modulesPerRow)
  const rows = Math.max(0, Math.floor((endCross - startCross + GEOMETRY_EPSILON) / stepCross) + 1)
  // A stagger is measured in physical metres along the generated row axis.
  // Clamp it to the usable row span so an oversized request cannot push the
  // first shifted module past the opposite edge. Candidates beyond the span
  // are still filtered by the normal region test below (important for
  // polygonal/concave regions), making clipping deterministic.
  const maxRowOffset = Math.max(0, endRow - startRow)
  const rowOffsetM = settings.rowOffsetM === undefined
    ? 0
    : Math.min(settings.rowOffsetM, maxRowOffset)
  const obstacleClearanceM = settings.obstacleClearanceM ?? 0
  const effectiveObstacles = obstacleClearanceM > GEOMETRY_EPSILON
    ? obstacles.map((obstacle) => expandObstacle(obstacle, obstacleClearanceM))
    : obstacles
  for (let row = 0; row < rows; row += 1) {
    const centerCross = startCross + row * stepCross
    const rowOffset = row % 2 === 1 ? rowOffsetM : 0
    for (let column = 0; column < columns; column += 1) {
      const centerRow = startRow + rowOffset + column * stepRow
      const localCenter = hasEdge
        ? pointFromAxes(centerRow, centerCross, traversalAxes)
        : { x: centerRow, y: centerCross }
      const candidate: AutoFillCandidate = {
        id: `candidate-${String(candidates.length + 1)}`,
        localCenter,
        footprint,
        orientation: settings.orientation,
        clearanceM: settings.clearanceM,
        tiltDeg: settings.tiltDeg,
        ...(request.groupId === undefined ? {} : { groupId: request.groupId }),
      }
      const rectangle = candidateBounds(candidate)
      if (rectangle === undefined) continue
      const fits = hasEdge
        ? orientedCandidateInsideRegion(localCenter, footprint.widthM, footprint.heightM, request.region, edgeAxes, settings.setbackM)
        : rectangleInsideSurfaceRegion(rectangle, request.region, settings.setbackM)
      if (!fits) continue
      if (hasEdge
        ? effectiveObstacles.some((obstacle) => orientedObstacleOverlap(localCenter, footprint.widthM, footprint.heightM, obstacle, edgeAxes))
        : effectiveObstacles.some((obstacle) => rectanglesOverlap(rectangle, obstacle))) continue
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
