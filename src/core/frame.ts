import type { Point2, Point3, SurfaceFrame } from './types'
import { createPoint2, createPoint3, isFiniteNumber, isPoint2, isPoint3, isSurfaceFrame } from './validation'

/** Coordinates of a world point expressed in a surface frame, in metres. */
export interface FrameCoordinates {
  readonly u: number
  readonly v: number
  /** Signed distance along the frame normal from the frame origin. */
  readonly normalOffsetM: number
}

type RecordValue = Record<string, unknown>

const isRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null

const isFrameCoordinates = (value: unknown): value is FrameCoordinates => {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.u) && isFiniteNumber(value.v) && isFiniteNumber(value.normalOffsetM)
}

function dot(first: Point3, second: Point3): number {
  return first.x * second.x + first.y * second.y + first.z * second.z
}

function subtract(first: Point3, second: Point3): Point3 {
  return { x: first.x - second.x, y: first.y - second.y, z: first.z - second.z }
}

function addScaled(first: Point3, second: Point3, scale: number): Point3 {
  return { x: first.x + second.x * scale, y: first.y + second.y * scale, z: first.z + second.z * scale }
}

function length(vector: Point3): number {
  return Math.sqrt(dot(vector, vector))
}

function normalise(vector: Point3): Point3 {
  const magnitude = length(vector)
  return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude }
}

/**
 * Projects a world point into an orthogonal surface frame. The basis vectors
 * need not be unit length; each returned coordinate is a signed metre value.
 */
export function projectPointToFrame(frame: SurfaceFrame, worldPoint: Point3): FrameCoordinates {
  if (!isSurfaceFrame(frame)) throw new TypeError('projectPointToFrame received an invalid SurfaceFrame')
  if (!isPoint3(worldPoint)) {
    throw new TypeError('projectPointToFrame received an invalid Point3')
  }
  const relative = subtract(worldPoint, frame.origin)
  const tangentX = normalise(frame.tangentX)
  const tangentY = normalise(frame.tangentY)
  const normal = normalise(frame.normal)
  return Object.freeze({
    u: dot(relative, tangentX),
    v: dot(relative, tangentY),
    normalOffsetM: dot(relative, normal),
  })
}

/** Projects a world point onto the frame's two-dimensional surface plane. */
export function projectPointToSurface(frame: SurfaceFrame, worldPoint: Point3): Point2 {
  const coordinates = projectPointToFrame(frame, worldPoint)
  return createPoint2({ x: coordinates.u, y: coordinates.v })
}

/**
 * Converts frame coordinates back to world space. `normalOffsetM` may be used
 * for panel clearance or a hit point above/below the surface plane.
 */
export function unprojectPointFromFrame(frame: SurfaceFrame, coordinates: FrameCoordinates): Point3 {
  if (!isSurfaceFrame(frame)) throw new TypeError('unprojectPointFromFrame received an invalid SurfaceFrame')
  if (!isFrameCoordinates(coordinates)) {
    throw new TypeError('unprojectPointFromFrame received invalid frame coordinates')
  }
  const tangentX = normalise(frame.tangentX)
  const tangentY = normalise(frame.tangentY)
  const normal = normalise(frame.normal)
  const withX = addScaled(frame.origin, tangentX, coordinates.u)
  const withY = addScaled(withX, tangentY, coordinates.v)
  return createPoint3(addScaled(withY, normal, coordinates.normalOffsetM))
}

/** Converts local surface coordinates and a signed normal offset to world space. */
export function pointFromSurfaceCoordinates(
  frame: SurfaceFrame,
  localPoint: Point2,
  normalOffsetM = 0,
): Point3 {
  if (!isPoint2(localPoint)) throw new TypeError('pointFromSurfaceCoordinates received an invalid Point2')
  if (!isFiniteNumber(normalOffsetM)) throw new TypeError('pointFromSurfaceCoordinates received an invalid normal offset')
  return unprojectPointFromFrame(frame, {
    u: localPoint.x,
    v: localPoint.y,
    normalOffsetM,
  })
}
