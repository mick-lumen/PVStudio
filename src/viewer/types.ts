import type { CSSProperties, ReactNode } from 'react'
import type { Point2, Point3, SurfaceDescriptor, SurfaceSelection } from '../core'

/**
 * Kept as a compatibility alias for callers that imported the viewer's old
 * point type. New cross-feature code should import `Point3` from `src/core`.
 */
export type ViewerPoint3 = Point3

/** Camera projection used by the viewer. */
export type ViewerCameraMode = 'perspective' | 'orthographic'

/** Surface appearance used by the viewer. */
export type ViewerRenderMode = 'texture' | 'wireframe'

/**
 * Tool context for surface pointer gestures.  Select keeps camera navigation
 * enabled; placement tools reserve the surface pointer stream for their own
 * drag/array gesture and therefore disable OrbitControls before pointerdown.
 */
export type ViewerSurfaceInteractionMode = 'select' | 'place' | 'obstacle'

/** A URL or a browser file supplied to the OBJ/MTL loader. */
export type ViewerResource = File | string

/**
 * Files making up a photogrammetry model. Texture files are optional because
 * an OBJ is still useful without an MTL or texture atlas.
 */
export interface ViewerModelSource {
  readonly obj: ViewerResource
  readonly mtl?: ViewerResource
  readonly textures?: readonly ViewerResource[]
  /** Friendly name shown in metadata and error messages. */
  readonly name?: string
}

export interface ViewerBoundingBox {
  readonly min: Point3
  readonly max: Point3
  readonly size: Point3
}

/** Parser-owned source measurements retained alongside built geometry. */
export interface ViewerSourceMetadata {
  readonly vertexCount: number
  readonly polygonCount: number
  readonly bounds: ViewerBoundingBox
  /** Bounds of positions referenced by triangulated faces. */
  readonly renderedBounds?: ViewerBoundingBox
}

/** Measurements collected after a model has been parsed. */
export interface ViewerModelMetadata {
  readonly name: string
  readonly vertexCount: number
  readonly polygonCount: number
  /** Source OBJ vertices before any position/UV/normal tuple expansion. */
  readonly sourceVertexCount?: number
  /** Source triangles after OBJ polygon fan triangulation. */
  readonly sourcePolygonCount?: number
  /** Bounds collected from source `v` records before geometry construction. */
  readonly sourceBounds?: ViewerBoundingBox
  readonly meshCount: number
  readonly materialCount: number
  readonly textureCount: number
  readonly boundingBox: ViewerBoundingBox
  readonly isDemo: boolean
}

export interface ViewerLoadProgress {
  /** Value from 0 to 1 when a total is known. */
  readonly progress: number
  readonly itemsLoaded: number
  readonly itemsTotal: number
  /** Human-readable stage, suitable for an accessible loading status. */
  readonly phase?: ViewerLoadPhase
  /** Elapsed milliseconds since loading started. */
  readonly elapsedMs?: number
  /** Estimated milliseconds remaining, when a total/progress estimate exists. */
  readonly etaMs?: number
  readonly url?: string
}

export type ViewerLoadPhase = 'reading' | 'parsing' | 'materials' | 'textures' | 'finalising' | 'complete'

/** Canonical plain selection DTO shared with placement and core contracts. */
export type ViewerSurfaceSelection = SurfaceSelection

/** Details about the input gesture, kept serialisable for placement consumers. */
export interface ViewerSurfaceSelectEvent {
  readonly shiftKey: boolean
  readonly selectedSurfaceIds: readonly string[]
}

/** Pointer gesture phase delivered with a plain, renderer-independent hit. */
export type ViewerSurfacePointerPhase = 'move' | 'down' | 'up' | 'cancel'

/** Perspective-correct local polygon produced by a native screen drag. */
export interface ViewerSurfacePointerBox {
  readonly surfaceId: string
  readonly corners: readonly Point2[]
}

/**
 * Surface pointer interaction for placement tools. `selection` is null when
 * the pointer is over non-selectable scene content; otherwise it contains the
 * world point and surface-local hit coordinates from the canonical DTO.
 */
export interface ViewerSurfacePointerEvent {
  readonly phase: ViewerSurfacePointerPhase
  readonly pointerId: number
  /** Native pointer kind, when supplied by the browser (mouse, pen, touch). */
  readonly pointerType?: string
  readonly button: number
  readonly buttons: number
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly selection: ViewerSurfaceSelection | null
  /** Present on native select-box pointerup events. */
  readonly surfaceBox?: ViewerSurfacePointerBox
}

export interface ViewerProps {
  /** OBJ/MTL input. If omitted, a small photogrammetry-like demo site is shown. */
  readonly source?: ViewerModelSource | null
  readonly cameraMode?: ViewerCameraMode
  readonly defaultCameraMode?: ViewerCameraMode
  readonly onCameraModeChange?: (mode: ViewerCameraMode) => void
  readonly renderMode?: ViewerRenderMode
  readonly defaultRenderMode?: ViewerRenderMode
  readonly onRenderModeChange?: (mode: ViewerRenderMode) => void
  readonly showGrid?: boolean
  readonly showCompass?: boolean
  readonly showScale?: boolean
  /** Optional scene content rendered inside the model's normalised transform. */
  readonly sceneContent?: ReactNode
  /** JSX children are also placed inside the normalised model transform. */
  readonly children?: ReactNode
  /** Receives one immutable, plain descriptor list for the current model. */
  readonly onSurfacesChange?: (surfaces: readonly SurfaceDescriptor[]) => void
  /** Enables the Canvas shadow map and key-light shadow casting. */
  readonly shadows?: boolean
  readonly className?: string
  readonly style?: CSSProperties
  readonly ariaLabel?: string
  readonly onModelLoaded?: (metadata: ViewerModelMetadata) => void
  readonly onLoadProgress?: (progress: ViewerLoadProgress) => void
  readonly onError?: (error: Error) => void
  readonly onSurfaceSelect?: (selection: ViewerSurfaceSelection | null, event?: ViewerSurfaceSelectEvent) => void
  /** Pointer move/down/up/cancel events with serialisable surface hit data. */
  readonly onSurfacePointer?: (event: ViewerSurfacePointerEvent) => void
  /** Surface tool context used to arbitrate camera navigation vs placement gestures. */
  readonly surfaceInteractionMode?: ViewerSurfaceInteractionMode
  /** True while the app owns an active surface-box selection gesture. */
  readonly surfaceGestureActive?: boolean
}
