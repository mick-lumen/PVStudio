/**
 * Placement's public data types are defined once in `src/core`.  This barrel
 * keeps the historical placement import path working without creating a
 * second, subtly different DTO vocabulary.
 */
export type {
  AutoFillCandidate,
  AutoFillPreview,
  AutoFillRequest,
  Orientation,
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
  SurfaceEdge,
  SurfaceEdgeLine,
  SurfaceEdgeMetadata,
  SurfaceEdgeType,
  SurfaceFaceRef,
  SurfaceFrame,
  SurfaceNormal,
  SurfaceRegion,
  SurfaceSelection,
} from '../core'

export { DEFAULT_PANEL_GROUP_SETTINGS } from '../core'
