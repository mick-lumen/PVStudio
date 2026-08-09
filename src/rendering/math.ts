import type {
  PanelDefinition,
  PanelFootprint,
  PanelPlacement,
  Point3,
  SurfaceDescriptor,
  SurfaceNormal,
} from '../core'

/** A small, allocation-friendly vector tuple used at the rendering boundary. */
export type Vector3Tuple = readonly [number, number, number]

/** Three.js `Matrix4.toArray()` ordering, kept serialisable for pure tests. */
export type Matrix4Tuple = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
]

export interface PanelPose {
  /** Position of the module's geometric centre in world metres. */
  readonly center: Point3
  /** The surface anchor before the module's half-thickness offset. */
  readonly surfaceAnchor: Point3
  /** Unit world axes for the module's local +X (across), +Y (long) and +Z (normal) axes. */
  readonly tangentX: Vector3Tuple
  readonly tangentY: Vector3Tuple
  readonly normal: Vector3Tuple
  readonly footprint: PanelFootprint
  readonly thicknessM: number
  readonly clearanceM: number
  readonly tiltDeg: number
  readonly matrix: Matrix4Tuple
}

const EPSILON = 1e-9
const FALLBACK_X: Vector3Tuple = [1, 0, 0]
const FALLBACK_Z: Vector3Tuple = [0, 0, 1]

const finite = (value: number): boolean => Number.isFinite(value)

const tuple = (value: SurfaceNormal | Point3): Vector3Tuple => [
  finite(value.x) ? value.x : 0,
  finite(value.y) ? value.y : 0,
  finite(value.z) ? value.z : 0,
]

const length = (value: Vector3Tuple): number => Math.hypot(value[0], value[1], value[2])

export const add = (first: Vector3Tuple, second: Vector3Tuple): Vector3Tuple => [
  first[0] + second[0],
  first[1] + second[1],
  first[2] + second[2],
]

export const subtract = (first: Vector3Tuple, second: Vector3Tuple): Vector3Tuple => [
  first[0] - second[0],
  first[1] - second[1],
  first[2] - second[2],
]

export const scale = (value: Vector3Tuple, amount: number): Vector3Tuple => [
  value[0] * amount,
  value[1] * amount,
  value[2] * amount,
]

export const dot = (first: Vector3Tuple, second: Vector3Tuple): number =>
  first[0] * second[0] + first[1] * second[1] + first[2] * second[2]

export const cross = (first: Vector3Tuple, second: Vector3Tuple): Vector3Tuple => [
  first[1] * second[2] - first[2] * second[1],
  first[2] * second[0] - first[0] * second[2],
  first[0] * second[1] - first[1] * second[0],
]

export const normalise = (value: Vector3Tuple, fallback: Vector3Tuple = FALLBACK_Z): Vector3Tuple => {
  const magnitude = length(value)
  return magnitude > EPSILON && finite(magnitude) ? scale(value, 1 / magnitude) : fallback
}

const orthogonalTangent = (normal: Vector3Tuple): Vector3Tuple => {
  const preferred: Vector3Tuple = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : FALLBACK_X
  return normalise(subtract(preferred, scale(normal, dot(preferred, normal))), FALLBACK_X)
}

const projectedUnit = (value: Vector3Tuple, normal: Vector3Tuple): Vector3Tuple | undefined => {
  const projected = subtract(value, scale(normal, dot(value, normal)))
  const magnitude = length(projected)
  return magnitude > EPSILON && finite(magnitude) ? scale(projected, 1 / magnitude) : undefined
}

const frameAxes = (surface: SurfaceDescriptor): {
  readonly normal: Vector3Tuple
  readonly tangentX: Vector3Tuple
  readonly tangentY: Vector3Tuple
} => {
  const normal = normalise(tuple(surface.frame.normal))
  const suppliedX = tuple(surface.frame.tangentX)
  const tangentX = projectedUnit(suppliedX, normal) ?? orthogonalTangent(normal)
  const derivedY = normalise(cross(normal, tangentX), orthogonalTangent(normal))
  // Preserve a valid supplied tangent-Y orientation while Gram–Schmidt
  // projecting it against both the normal and tangent-X. If it points the
  // wrong way, flip it so X × Y = normal and the returned basis is orthonormal.
  const suppliedY = projectedUnit(tuple(surface.frame.tangentY), normal)
  const tangentYCandidate = suppliedY === undefined
    ? derivedY
    : normalise(subtract(suppliedY, scale(tangentX, dot(suppliedY, tangentX))), derivedY)
  const tangentY = dot(cross(tangentX, tangentYCandidate), normal) >= 0
    ? tangentYCandidate
    : scale(tangentYCandidate, -1)
  return { normal, tangentX, tangentY }
}

const orientedFootprint = (panel: PanelDefinition, placement: PanelPlacement): PanelFootprint =>
  placement.orientation === 'portrait'
    ? { widthM: panel.widthM, heightM: panel.heightM }
    : { widthM: panel.heightM, heightM: panel.widthM }

/**
 * Calculate a stable world pose for a serialisable placement.
 *
 * The module's local X axis follows the surface tangent X and local Y follows
 * tangent Y. Independent tilt rotates the module around its local X axis while
 * clearance remains measured from the original surface normal. The returned
 * matrix is column-major and can be passed directly to `Matrix4.fromArray`.
 */
export function computePanelPose(panel: PanelDefinition, surface: SurfaceDescriptor, placement: PanelPlacement): PanelPose {
  const axes = frameAxes(surface)
  const footprint = orientedFootprint(panel, placement)
  const clearanceM = finite(placement.clearanceM) && placement.clearanceM >= 0 ? placement.clearanceM : 0
  const tiltDeg = finite(placement.tiltDeg) ? Math.min(90, Math.max(0, placement.tiltDeg)) : 0
  const tiltRadians = tiltDeg * Math.PI / 180
  const tiltedNormal = normalise(
    add(scale(axes.normal, Math.cos(tiltRadians)), scale(axes.tangentY, Math.sin(tiltRadians))),
    axes.normal,
  )
  const tiltedTangentY = normalise(cross(tiltedNormal, axes.tangentX), axes.tangentY)
  const anchorTuple = add(
    add(tuple(surface.frame.origin), scale(axes.tangentX, placement.localCenter.x)),
    add(scale(axes.tangentY, placement.localCenter.y), scale(axes.normal, clearanceM)),
  )
  const centerTuple = add(anchorTuple, scale(tiltedNormal, Math.max(0, panel.thicknessM) / 2))
  const center: Point3 = { x: centerTuple[0], y: centerTuple[1], z: centerTuple[2] }
  const surfaceAnchor: Point3 = { x: anchorTuple[0], y: anchorTuple[1], z: anchorTuple[2] }
  const tangentX = axes.tangentX
  const normal = tiltedNormal
  const tangentY = tiltedTangentY
  const matrix: Matrix4Tuple = [
    tangentX[0], tangentX[1], tangentX[2], 0,
    tangentY[0], tangentY[1], tangentY[2], 0,
    normal[0], normal[1], normal[2], 0,
    center.x, center.y, center.z, 1,
  ]
  return {
    center,
    surfaceAnchor,
    tangentX,
    normal,
    tangentY,
    footprint,
    thicknessM: finite(panel.thicknessM) && panel.thicknessM > 0 ? panel.thicknessM : 0,
    clearanceM,
    tiltDeg,
    matrix,
  }
}

export const calculatePanelPose = computePanelPose
export const createPanelPose = computePanelPose

/** Compose a local translation/scale onto a panel pose without mutating inputs. */
export function composePanelLocalMatrix(
  pose: Matrix4Tuple,
  translation: Vector3Tuple = [0, 0, 0],
  dimensions: Vector3Tuple = [1, 1, 1],
): Matrix4Tuple {
  // This is the explicit multiplication M * (T * S), avoiding a Three.js
  // dependency in pure layout tests and keeping the serialisable boundary.
  const [xx, xy, xz] = [pose[0], pose[1], pose[2]]
  const [yx, yy, yz] = [pose[4], pose[5], pose[6]]
  const [zx, zy, zz] = [pose[8], pose[9], pose[10]]
  const [px, py, pz] = [pose[12], pose[13], pose[14]]
  const [tx, ty, tz] = translation
  const [sx, sy, sz] = dimensions
  return [
    xx * sx, xy * sx, xz * sx, 0,
    yx * sy, yy * sy, yz * sy, 0,
    zx * sz, zy * sz, zz * sz, 0,
    px + xx * tx + yx * ty + zx * tz,
    py + xy * tx + yy * ty + zy * tz,
    pz + xz * tx + yz * ty + zz * tz,
    1,
  ]
}

export const createPanelTransformMatrix = (pose: PanelPose): Matrix4Tuple => pose.matrix

/** Convert a Three-like vector into the serialisable point contract. */
export function point3FromTuple(value: Vector3Tuple): Point3 {
  return { x: value[0], y: value[1], z: value[2] }
}

/** Keep a serialisable point finite when converting pointer intersections. */
export function finitePoint3(value: { readonly x: number; readonly y: number; readonly z: number }): Point3 {
  return {
    x: finite(value.x) ? value.x : 0,
    y: finite(value.y) ? value.y : 0,
    z: finite(value.z) ? value.z : 0,
  }
}

export function normaliseSurfaceNormal(normal: SurfaceNormal): Vector3Tuple {
  return normalise(tuple(normal))
}
