/**
 * The shared, serialisable vocabulary used by the viewer, panel catalogue and
 * placement engine.  Values in this module are plain data: no Three.js
 * instances, DOM nodes, class instances, files or functions are allowed.
 *
 * Unless a field name says otherwise, distances are measured in metres and
 * angles are measured in degrees.  Coordinates in a `SurfaceRegion`,
 * `PanelPlacement.localCenter` and `AutoFillCandidate.localCenter` are in the
 * local two-dimensional coordinate system supplied by their surface frame.
 */

/** A finite two-dimensional coordinate in metres. */
export interface Point2 {
  readonly x: number
  readonly y: number
}

/** A finite world-space coordinate in metres. */
export interface Point3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** A finite non-zero surface normal. Canonical frames normally use unit normals. */
export interface SurfaceNormal {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * A right-handed local frame for a surface. `tangentX` and `tangentY` span the
 * surface plane; `normal` points away from the surface. All vectors are in
 * world coordinates and `origin` is in metres.
 */
export interface SurfaceFrame {
  readonly origin: Point3
  readonly normal: SurfaceNormal
  readonly tangentX: SurfaceNormal
  readonly tangentY: SurfaceNormal
}

/** An axis-aligned local rectangle in metres. Non-positive dimensions are invalid. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A simple, closed polygon in local metres. The first point is not repeated. */
export interface Polygon {
  readonly points: readonly Point2[]
}

/** A surface footprint accepted by the placement engine. */
export type SurfaceRegion = Rect | Polygon

/** Stable references to triangles belonging to a source mesh. */
export interface SurfaceFaceRef {
  readonly meshId: string
  readonly faceIndices: readonly number[]
}

/**
 * A selectable coplanar surface and its measured placement bounds. `area` and
 * `usableArea` are square metres. `azimuthDeg` is clockwise from true north;
 * `tiltDeg` is the angle away from horizontal.
 */
export interface SurfaceDescriptor {
  readonly id: string
  readonly frame: SurfaceFrame
  readonly region: SurfaceRegion
  readonly area: number
  readonly azimuthDeg: number
  readonly tiltDeg: number
  readonly usableArea: number
  readonly faceRefs: readonly SurfaceFaceRef[]
}

/** A hit resolved by the viewer without leaking a Three.js intersection. */
export interface SurfaceSelection {
  readonly surface: SurfaceDescriptor
  readonly hitLocal: Point2
  readonly worldPoint: Point3
}

/** The orientation of a module's long axis on a surface. */
export type Orientation = 'portrait' | 'landscape'

/**
 * Canonical module data. Dimensions are metres, electrical output is watts,
 * and mass is kilograms. Catalogue-specific fields (cell technology, frame
 * colour, STC details) remain outside this cross-feature contract.
 */
export interface PanelDefinition {
  readonly id: string
  readonly manufacturer: string
  readonly model: string
  readonly widthM: number
  readonly heightM: number
  readonly thicknessM: number
  readonly wattageW: number
  readonly weightKg: number
}

/** Full group settings used for both manual placement and auto-fill. */
export interface PanelGroupSettings {
  readonly orientation: Orientation
  readonly interPanelSpacingM: number
  readonly rowSpacingM: number
  readonly setbackM: number
  readonly clearanceM: number
  readonly tiltDeg: number
}

/** Safe defaults matching the placement product requirements. */
export const DEFAULT_PANEL_GROUP_SETTINGS: PanelGroupSettings = Object.freeze({
  orientation: 'portrait',
  interPanelSpacingM: 0.02,
  rowSpacingM: 0.03,
  setbackM: 0.2,
  clearanceM: 0.1,
  tiltDeg: 0,
})

/** A panel's local centre and the settings that affect its world transform. */
export interface PanelPlacement {
  readonly id: string
  readonly panelId: string
  readonly surfaceId: string
  readonly localCenter: Point2
  readonly orientation: Orientation
  readonly clearanceM: number
  readonly tiltDeg: number
  readonly groupId?: string
}

/** A module footprint after applying portrait or landscape orientation. */
export interface PanelFootprint {
  readonly widthM: number
  readonly heightM: number
}

/** A user-defined exclusion rectangle in a surface's local metres. */
export interface RectangularObstacle extends Rect {
  readonly id: string
}

/** Inputs required to calculate a deterministic auto-fill preview. */
export interface AutoFillRequest {
  readonly panelId: string
  readonly surfaceId: string
  readonly region: SurfaceRegion
  readonly obstacles: readonly RectangularObstacle[]
  readonly settings: PanelGroupSettings
  readonly groupId?: string
}

/** One ghosted panel in an auto-fill preview, before confirmation. */
export interface AutoFillCandidate {
  readonly id: string
  readonly localCenter: Point2
  readonly footprint: PanelFootprint
  readonly orientation: Orientation
  readonly clearanceM: number
  readonly tiltDeg: number
  readonly groupId?: string
}

/**
 * Serializable auto-fill output. `totalKwp` is the aggregate nominal power
 * in kilowatts peak; `totalWattageW` retains the exact watt total.
 */
export interface AutoFillPreview {
  readonly request: AutoFillRequest
  readonly candidates: readonly AutoFillCandidate[]
  readonly totalWattageW: number
  readonly totalKwp: number
}
