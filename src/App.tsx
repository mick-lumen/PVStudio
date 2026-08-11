import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type {
  PanelDefinition,
  PanelPlacement,
  Point2,
  RectangularObstacle,
  SurfaceDescriptor,
  SurfaceEdge,
  SurfaceEdgeMetadata,
  SurfaceSelection,
} from './core'
import { projectPointToSurface } from './core'
import { PANEL_CATALOG, toPanelDefinition, type PanelSpec } from './data'
import {
  createPlacementStore,
  createAdjacentPanelSlots,
  editableGroupIdFor,
  type PlacementState,
  type PlacementStore,
  type SurfaceGutter,
} from './placement'
import { PanelChooser } from './panels'
import {
  ArrayCanvasHandles,
  PanelLayer,
  PanelSlotOutlines,
  PanelRenderStatus,
  ObstacleLayer,
  type PanelSlotOutline,
  type PanelPointerInfo,
} from './rendering'
import {
  Shell,
  type AlignPreviewState,
  type ShellArray,
  type ShellPanel,
  type ShellSurface,
  type ShellSurfaceEdge,
  type ObstacleGeometryPatch,
  type ToolId,
  type ViewMode,
  type RenderMode,
} from './shell/Shell'
import {
  createPanelVisuals,
  buildViewerSourceFromSelection,
  placementValues,
  summarisePlacementState,
  toShellPanel,
  toShellSurface,
} from './integration/appIntegration'
import { createSampleViewerSource } from './integration/sampleSource'
import {
  Viewer,
  type ViewerLoadProgress,
  type ViewerModelMetadata,
  type ViewerModelSource,
  type ViewerSurfacePointerEvent,
  type ViewerSurfaceSelectEvent,
} from './viewer'

export interface AppProps {
  /** A controlled model source. Omitting this prop leaves the viewer's demo model active. */
  readonly source?: ViewerModelSource | null
  readonly projectName?: string
  readonly webglAvailable?: boolean
  readonly initialCameraMode?: ViewMode
  readonly initialRenderMode?: RenderMode
  readonly initialShowGrid?: boolean
}

interface PanelContextMenuState {
  readonly placementId: string
  readonly arrayId: string
  readonly clientX: number
  readonly clientY: number
}

const CATALOG_DEFINITIONS: readonly PanelDefinition[] = Object.freeze(PANEL_CATALOG.map((panel) => toPanelDefinition(panel)))
const EMPTY_PANEL_DEFINITIONS: readonly PanelDefinition[] = Object.freeze([])

const pointFromPointer = (surface: SurfaceDescriptor | undefined, info: PanelPointerInfo): Point2 | undefined => {
  if (surface === undefined) return undefined
  try {
    return projectPointToSurface(surface.frame, info.worldPoint)
  } catch {
    return undefined
  }
}

const selectedSurfaceFor = (surfaces: readonly SurfaceDescriptor[], state: Readonly<PlacementState>): SurfaceDescriptor | undefined => {
  const activeId = state.activeSurfaceId ?? state.activeSurfaceIds[0]
  return activeId === undefined ? undefined : surfaces.find((surface) => surface.id === activeId)
}

const selectedPanelFor = (panels: readonly PanelSpec[], id: string | null): PanelSpec | null =>
  id === null ? null : panels.find((panel) => panel.id === id) ?? null

const samePoint3 = (first: SurfaceDescriptor['frame']['origin'], second: SurfaceDescriptor['frame']['origin']): boolean =>
  first.x === second.x && first.y === second.y && first.z === second.z

const sameRegion = (first: SurfaceDescriptor['region'], second: SurfaceDescriptor['region']): boolean => {
  if ('points' in first || 'points' in second) {
    if (!('points' in first) || !('points' in second) || first.points.length !== second.points.length) return false
    return first.points.every((point, index) => {
      const other = second.points[index]
      return other !== undefined && point.x === other.x && point.y === other.y
    })
  }
  return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height
}

const sameSurfaceEdge = (first: SurfaceDescriptor['edge'], second: SurfaceDescriptor['edge']): boolean => {
  if (first === second) return true
  if (first === undefined || second === undefined
    || first.type !== second.type
    || first.side !== second.side
    || first.direction.x !== second.direction.x
    || first.direction.y !== second.direction.y) return false
  const firstLine = first.line
  const secondLine = second.line
  if (firstLine === secondLine) return true
  if (firstLine === undefined || secondLine === undefined) return false
  return firstLine.origin.x === secondLine.origin.x
    && firstLine.origin.y === secondLine.origin.y
    && firstLine.direction.x === secondLine.direction.x
    && firstLine.direction.y === secondLine.direction.y
}

const isSurfaceEdgeOverrideMap = (
  source: PlacementStore['context']['gutters'],
): source is Readonly<Record<string, SurfaceGutter | null>> => source !== undefined && !Array.isArray(source)

const sameSurfaceDescriptor = (first: SurfaceDescriptor, second: SurfaceDescriptor): boolean => {
  if (first === second) return true
  if (first.id !== second.id || first.area !== second.area || first.azimuthDeg !== second.azimuthDeg
    || first.tiltDeg !== second.tiltDeg || first.usableArea !== second.usableArea) return false
  const firstFrame = first.frame
  const secondFrame = second.frame
  if (!samePoint3(firstFrame.origin, secondFrame.origin)
    || !samePoint3(firstFrame.normal, secondFrame.normal)
    || !samePoint3(firstFrame.tangentX, secondFrame.tangentX)
    || !samePoint3(firstFrame.tangentY, secondFrame.tangentY)
    || !sameRegion(first.region, second.region)
    || !sameSurfaceEdge(first.edge, second.edge)
    || first.faceRefs.length !== second.faceRefs.length) return false
  return first.faceRefs.every((faceRef, index) => {
    const other = second.faceRefs[index]
    return other !== undefined && faceRef.meshId === other.meshId
      && faceRef.faceIndices.length === other.faceIndices.length
      && faceRef.faceIndices.every((faceIndex, faceIndexPosition) => faceIndex === other.faceIndices[faceIndexPosition])
  })
}

const sameSurfaceDescriptors = (first: readonly SurfaceDescriptor[], second: readonly SurfaceDescriptor[]): boolean =>
  first.length === second.length && first.every((surface, index) => {
    const other = second[index]
    return other !== undefined && sameSurfaceDescriptor(surface, other)
  })

interface ActivePanelDrag {
  readonly placementIds: readonly string[]
  readonly startPoint: Point2
  lastPoint: Point2
}

interface ActiveSurfaceDrag {
  readonly pointerId: number
  readonly panelId: string
  readonly surfaceId: string
  readonly startPoint: Point2
  readonly groupId?: string
  lastPoint: Point2
  moved: boolean
}

interface ActiveSurfaceBox {
  readonly pointerId: number
  readonly surfaceId: string
  readonly startPoint: Point2
  lastPoint: Point2
  moved: boolean
  readonly additive: boolean
}

interface ActiveObstacleDraw {
  readonly mode: 'draw'
  readonly pointerId: number
  readonly surfaceId: string
  readonly startPoint: Point2
  lastPoint: Point2
  moved: boolean
}

interface ActiveObstacleMove {
  readonly mode: 'move'
  readonly pointerId: number
  readonly surfaceId: string
  readonly startPoint: Point2
  readonly obstacle: RectangularObstacle
  lastPoint: Point2
  moved: boolean
}

type ActiveObstacleDrag = ActiveObstacleDraw | ActiveObstacleMove

type ObstacleMap = Readonly<Record<string, readonly RectangularObstacle[]>>

const EMPTY_OBSTACLES: ObstacleMap = Object.freeze({})
const EMPTY_OBSTACLE_LIST: readonly RectangularObstacle[] = Object.freeze([])

/** Ignore small pointer noise for both array and selection-box drags. */
const SURFACE_DRAG_THRESHOLD_M = 0.05

const pointsDiffer = (first: Point2, second: Point2): boolean =>
  Math.abs(first.x - second.x) > SURFACE_DRAG_THRESHOLD_M || Math.abs(first.y - second.y) > SURFACE_DRAG_THRESHOLD_M

const regionFromPoints = (first: Point2, second: Point2): { x: number; y: number; width: number; height: number } => ({
  x: Math.min(first.x, second.x),
  y: Math.min(first.y, second.y),
  width: Math.abs(second.x - first.x),
  height: Math.abs(second.y - first.y),
})

const obstacleFromPoints = (id: string, first: Point2, second: Point2): RectangularObstacle => ({
  id,
  ...regionFromPoints(first, second),
})

const obstacleContainsPoint = (obstacle: RectangularObstacle, point: Point2): boolean =>
  point.x >= obstacle.x
  && point.x <= obstacle.x + obstacle.width
  && point.y >= obstacle.y
  && point.y <= obstacle.y + obstacle.height

const movedObstacle = (obstacle: RectangularObstacle, start: Point2, current: Point2): RectangularObstacle => ({
  ...obstacle,
  x: obstacle.x + current.x - start.x,
  y: obstacle.y + current.y - start.y,
})

const obstacleMapFromSource = (source: unknown): ObstacleMap => {
  if (source === undefined || Array.isArray(source) || typeof source !== 'object' || source === null) return EMPTY_OBSTACLES
  return source as ObstacleMap
}

const surfaceIdsFromEvent = (selection: SurfaceSelection, event?: ViewerSurfaceSelectEvent): readonly string[] =>
  event?.selectedSurfaceIds.length === 0 || event?.selectedSurfaceIds === undefined
    ? [selection.surface.id]
    : event.selectedSurfaceIds

function AutoFillInspector({
  count,
  totalKwp,
  onConfirm,
  onCancel,
}: {
  readonly count: number
  readonly totalKwp: number
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): ReactNode {
  return (
    <section className="inspector-card" aria-labelledby="autofill-preview-title">
      <div className="inspector-card__title-row"><h2 id="autofill-preview-title">Auto-fill preview</h2></div>
      <p>{count} candidate {count === 1 ? 'panel' : 'panels'} · {totalKwp.toFixed(2)} kWp</p>
      <div className="inspector-card__actions">
        <button type="button" className="button button--quiet" onClick={onCancel}>Cancel preview</button>
        <button type="button" className="button button--primary" onClick={onConfirm}>Confirm layout</button>
      </div>
    </section>
  )
}

/**
 * Application-level coordinator. All state crossing the Viewer/PanelLayer
 * boundary is canonical serialisable data; Three.js objects stay inside the
 * rendering and viewer packages.
 */
export function App({
  source: controlledSource,
  projectName,
  webglAvailable,
  initialCameraMode = '3d',
  initialRenderMode = 'texture',
  initialShowGrid = true,
}: AppProps): ReactNode {
  const [store] = useState<PlacementStore>(() => createPlacementStore({ panels: CATALOG_DEFINITIONS }))
  const subscribe = useCallback((listener: () => void): (() => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback((): Readonly<PlacementState> => store.getSnapshot(), [store])
  const placementState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const [localSource, setLocalSource] = useState<ViewerModelSource | null>(controlledSource ?? null)
  const [surfaces, setSurfaces] = useState<readonly SurfaceDescriptor[]>([])
  const [customPanels, setCustomPanels] = useState<readonly PanelSpec[]>([])
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(() => PANEL_CATALOG[0]?.id ?? null)
  const [cameraMode, setCameraMode] = useState<ViewMode>(initialCameraMode)
  const [renderMode, setRenderMode] = useState<RenderMode>(initialRenderMode)
  const [showGrid, setShowGrid] = useState(initialShowGrid)
  const [activeTool, setActiveTool] = useState<ToolId>('select')
  const [surfaceGestureActive, setSurfaceGestureActive] = useState(false)
  const [obstaclesBySurface, setObstaclesBySurface] = useState<ObstacleMap>(() => EMPTY_OBSTACLES)
  const [draftObstacle, setDraftObstacle] = useState<RectangularObstacle | null>(null)
  const [draftObstacleSurfaceId, setDraftObstacleSurfaceId] = useState<string | null>(null)
  const [modelMetadata, setModelMetadata] = useState<ViewerModelMetadata | null>(null)
  const [loadProgress, setLoadProgress] = useState<ViewerLoadProgress | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [importNotice, setImportNotice] = useState<string | null>(null)
  const [interactionNotice, setInteractionNotice] = useState<{ readonly text: string; readonly kind: 'default' | 'error' } | null>(null)
  const [panelContextMenu, setPanelContextMenu] = useState<PanelContextMenuState | null>(null)
  const surfacesRef = useRef<readonly SurfaceDescriptor[]>([])
  const activePanelDrag = useRef<ActivePanelDrag | null>(null)
  const activeSurfaceDrag = useRef<ActiveSurfaceDrag | null>(null)
  const activeSurfaceBox = useRef<ActiveSurfaceBox | null>(null)
  const activeObstacleDrag = useRef<ActiveObstacleDrag | null>(null)
  const obstaclesBySurfaceRef = useRef<ObstacleMap>(EMPTY_OBSTACLES)
  const obstacleIdRef = useRef(0)
  const importSequenceRef = useRef(0)
  const previousControlledSource = useRef<ViewerModelSource | null | undefined>(controlledSource)
  const [draggingPlacementIds, setDraggingPlacementIds] = useState<readonly string[]>([])
  const [dragStartPoint, setDragStartPoint] = useState<Point2 | null>(null)
  const [dragPoint, setDragPoint] = useState<Point2 | null>(null)

  const clearSurfaceBox = useCallback((): void => {
    activeSurfaceBox.current = null
    setSurfaceGestureActive(false)
  }, [])

  const changeTool = useCallback((next: ToolId): void => {
    if (next !== 'select') clearSurfaceBox()
    setActiveTool(next)
  }, [clearSurfaceBox])

  const source = controlledSource !== undefined ? controlledSource : localSource

  const replaceObstacleMap = useCallback((next: ObstacleMap): void => {
    if (!store.setObstacles(next)) return
    obstaclesBySurfaceRef.current = next
    setObstaclesBySurface(next)
  }, [store])

  // Placement undo/redo owns obstacle history. Mirror its canonical obstacle
  // snapshot back into React state so the canvas and inspector travel through
  // the same chronology as panel placement changes.
  useEffect(() => {
    const next = obstacleMapFromSource(store.context.obstacles)
    if (obstaclesBySurfaceRef.current === next) return
    obstaclesBySurfaceRef.current = next
    setObstaclesBySurface(next)
  }, [placementState, store])

  // A controlled model replacement invalidates the previous surface topology
  // and its placements. Clear the topology eagerly so a stale callback from
  // the replaced viewer cannot be mistaken for the new model's surfaces.
  useEffect(() => {
    if (previousControlledSource.current === controlledSource) return
    previousControlledSource.current = controlledSource
    importSequenceRef.current += 1
    surfacesRef.current = []
    setSurfaces([])
    setModelMetadata(null)
    setLoadProgress(null)
    setLoadError(null)
    setImportNotice(null)
    activeObstacleDrag.current = null
    replaceObstacleMap(EMPTY_OBSTACLES)
    setDraftObstacle(null)
    setDraftObstacleSurfaceId(null)
    changeTool('select')
    store.replaceContext({ panels: store.context.panels ?? [], surfaces: [], obstacles: EMPTY_OBSTACLES })
  }, [changeTool, controlledSource, replaceObstacleMap, store])

  const panelSpecs = useMemo<readonly PanelSpec[]>(
    () => Object.freeze([...PANEL_CATALOG, ...customPanels]),
    [customPanels],
  )
  const selectedPanel = useMemo(() => selectedPanelFor(panelSpecs, selectedPanelId), [selectedPanelId, panelSpecs])
  const panelVisuals = useMemo(() => createPanelVisuals(panelSpecs), [panelSpecs])
  const definitions = store.context.panels ?? EMPTY_PANEL_DEFINITIONS
  const definitionRecord = useMemo<Readonly<Record<string, PanelDefinition>>>(() => Object.fromEntries(
    panelSpecs.map((panel) => {
      const definition = toPanelDefinition(panel)
      return [definition.id, definition] as const
    }),
  ), [panelSpecs])
  const placements = useMemo(() => placementValues(placementState), [placementState])
  const activeSurface = selectedSurfaceFor(surfaces, placementState)
  const surfaceEdgeOverrides = store.context.gutters
  const surfaceEdges: Readonly<Record<string, SurfaceEdge | null>> = Object.fromEntries(surfaces.flatMap((surface): readonly (readonly [string, SurfaceEdge | null])[] => {
    const edge = store.getSurfaceEdge(surface.id)
    if (edge !== undefined) {
      return [[surface.id, {
        surfaceId: surface.id,
        type: edge.type ?? 'gutter',
        direction: { ...edge.direction },
        ...(edge.line === undefined ? {} : {
          line: {
            origin: { ...edge.line.origin },
            direction: { ...edge.line.direction },
          },
        }),
        ...(edge.side === undefined ? {} : { side: edge.side }),
      }]]
    }
    const explicitlyCleared = isSurfaceEdgeOverrideMap(surfaceEdgeOverrides)
      && surfaceEdgeOverrides[surface.id] === null
    return explicitlyCleared ? [[surface.id, null]] : []
  }))
  const editableGroupId = useMemo(() => editableGroupIdFor(placementState), [placementState])
  const editableGroupSettings = editableGroupId === undefined ? undefined : placementState.groupSettings[editableGroupId]
  const editableSettings = useMemo(
    () => editableGroupId === undefined
      ? placementState.settings
      : editableGroupSettings ?? store.getGroupSettings(editableGroupId),
    [editableGroupId, editableGroupSettings, placementState.settings, store],
  )
  const settingsScopeLabel = editableGroupId === undefined ? 'Global defaults' : `Group ${editableGroupId}`
  const activeObstacles = activeSurface === undefined
    ? EMPTY_OBSTACLE_LIST
    : obstaclesBySurface[activeSurface.id] ?? EMPTY_OBSTACLE_LIST
  const summary = useMemo(() => summarisePlacementState(placementState, store), [placementState, store])
  const arrays = store.getArrays()
  const selectedArray = useMemo(() => arrays.find((array) => array.id === editableGroupId), [arrays, editableGroupId])
  const selectedArrayPlacements = useMemo<readonly PanelPlacement[]>(() => selectedArray === undefined
    ? []
    : selectedArray.placementIds.flatMap((id) => {
      const placement = placementState.placements[id]
      return placement === undefined ? [] : [placement]
    }), [placementState.placements, selectedArray])
  const shellArrays = useMemo<readonly ShellArray[]>(() => arrays.map((array) => ({
    id: array.id,
    panelId: array.panelId,
    panelCount: array.placementIds.length,
  })), [arrays])
  const shellPanelOptions = useMemo<readonly ShellPanel[]>(() => panelSpecs.map(toShellPanel), [panelSpecs])

  const replaceSurfaces = useCallback((next: readonly SurfaceDescriptor[]): void => {
    if (sameSurfaceDescriptors(surfacesRef.current, next)) {
      const firstSurface = next[0]
      if (firstSurface !== undefined && store.getSnapshot().activeSurfaceId === undefined) store.setActiveSurface(firstSurface.id)
      return
    }
    const hadSurfaceTopology = surfacesRef.current.length > 0
    const frozen = Object.freeze([...next])
    surfacesRef.current = frozen
    setSurfaces(frozen)
    activeObstacleDrag.current = null
    clearSurfaceBox()
    replaceObstacleMap(EMPTY_OBSTACLES)
    setDraftObstacle(null)
    setDraftObstacleSurfaceId(null)
    // The first surface topology notification can arrive after a user arms a
    // panel before the viewer has emitted its surfaces. Preserve that pending
    // placement tool while there was no previous topology to invalidate; an
    // existing topology replacement still resets to select.
    if (hadSurfaceTopology) changeTool('select')
    const contextPanels = store.context.panels ?? []
    const surfaceIds = new Set(frozen.map((surface) => surface.id))
    const currentGutters = store.context.gutters
    const retainedGutters = isSurfaceEdgeOverrideMap(currentGutters)
      ? Object.fromEntries(Object.entries(currentGutters).filter(([surfaceId]) => surfaceIds.has(surfaceId)))
      : currentGutters?.filter((gutter) => surfaceIds.has(gutter.surfaceId))
    store.replaceContext({
      panels: contextPanels,
      surfaces: frozen,
      obstacles: EMPTY_OBSTACLES,
      ...(retainedGutters === undefined ? {} : { gutters: retainedGutters }),
    })
    const firstSurface = frozen[0]
    if (firstSurface !== undefined) store.setActiveSurface(firstSurface.id)
  }, [changeTool, clearSurfaceBox, replaceObstacleMap, store])

  const handleModelLoaded = useCallback((metadata: ViewerModelMetadata): void => {
    setModelMetadata(metadata)
    setLoadError(null)
    setLoadProgress({ progress: 1, itemsLoaded: 1, itemsTotal: 1, phase: 'complete' })
  }, [])
  const handleLoadProgress = useCallback((progress: ViewerLoadProgress): void => {
    setLoadProgress(progress)
  }, [])
  const handleViewerError = useCallback((error: Error): void => {
    setLoadError(error.message)
  }, [])

  const resetModelPlacementContext = useCallback((): void => {
    surfacesRef.current = []
    setSurfaces([])
    activeObstacleDrag.current = null
    clearSurfaceBox()
    replaceObstacleMap(EMPTY_OBSTACLES)
    setDraftObstacle(null)
    setDraftObstacleSurfaceId(null)
    changeTool('select')
    store.replaceContext({ panels: store.context.panels ?? [], surfaces: [], obstacles: EMPTY_OBSTACLES })
  }, [changeTool, clearSurfaceBox, replaceObstacleMap, store])

  const choosePanel = useCallback((panel: PanelSpec | null): void => {
    setSelectedPanelId(panel?.id ?? null)
    if (panel === null) {
      changeTool('select')
      store.cancelManualPlacement()
    }
  }, [changeTool, store])

  const registerAndArmPanel = useCallback((panel: PanelSpec): void => {
    const definition = toPanelDefinition(panel)
    store.registerPanel(definition)
    setSelectedPanelId(panel.id)
    // The primary "+ Panel" action starts a new array. Extending the current
    // array is deliberately handled by its adjacent white slot outlines; if
    // the previous array remained selected here, every later placement would
    // silently inherit that group and the sidebar could never represent the
    // separate roof arrays the user intended to create.
    store.selectPanels([])
    const surface = selectedSurfaceFor(surfaces, store.getSnapshot()) ?? surfaces[0]
    if (surface === undefined) {
      changeTool('place')
      return
    }
    store.setActiveSurface(surface.id)
    store.beginManualPlacement({ panelId: panel.id, surfaceId: surface.id })
    changeTool('place')
  }, [changeTool, store, surfaces])

  const handleSurfaceSelect = useCallback((selection: SurfaceSelection | null, event?: ViewerSurfaceSelectEvent): void => {
    if (selection === null) {
      store.setActiveSurfaces([])
      return
    }
    const ids = surfaceIdsFromEvent(selection, event)
    store.setActiveSurfaces(ids)
  }, [store])

  const clearObstacleDraft = useCallback((): void => {
    activeObstacleDrag.current = null
    setDraftObstacle(null)
    setDraftObstacleSurfaceId(null)
  }, [])

  const handleObstacleStart = useCallback((): void => {
    activeSurfaceDrag.current = null
    clearSurfaceBox()
    store.cancelManualPlacement()
    store.cancelArrayDrag()
    store.cancelAutoFill()
    clearObstacleDraft()
    changeTool('obstacle')
  }, [changeTool, clearObstacleDraft, clearSurfaceBox, store])

  const handleObstacleCancel = useCallback((): void => {
    clearObstacleDraft()
    changeTool('select')
  }, [changeTool, clearObstacleDraft])

  const handleObstacleRemove = useCallback((id: string): void => {
    const current = obstaclesBySurfaceRef.current
    let changed = false
    const next: Record<string, readonly RectangularObstacle[]> = {}
    for (const [surfaceId, obstacles] of Object.entries(current)) {
      const filtered = obstacles.filter((obstacle) => obstacle.id !== id)
      if (filtered.length !== obstacles.length) changed = true
      if (filtered.length > 0) next[surfaceId] = Object.freeze(filtered)
    }
    if (changed) replaceObstacleMap(Object.freeze(next))
  }, [replaceObstacleMap])

  const handleObstacleChange = useCallback((id: string, patch: ObstacleGeometryPatch): void => {
    const values = Object.values(patch)
    if (values.some((value) => !Number.isFinite(value))) return
    if ((patch.width !== undefined && patch.width < SURFACE_DRAG_THRESHOLD_M)
      || (patch.height !== undefined && patch.height < SURFACE_DRAG_THRESHOLD_M)) return
    const current = obstaclesBySurfaceRef.current
    let changed = false
    const next: Record<string, readonly RectangularObstacle[]> = {}
    for (const [surfaceId, obstacles] of Object.entries(current)) {
      const updated = obstacles.map((obstacle) => {
        if (obstacle.id !== id) return obstacle
        const candidate = Object.freeze({ ...obstacle, ...patch })
        if (candidate.x === obstacle.x && candidate.y === obstacle.y
          && candidate.width === obstacle.width && candidate.height === obstacle.height) return obstacle
        return candidate
      })
      if (updated.some((obstacle, index) => obstacle !== obstacles[index])) changed = true
      next[surfaceId] = Object.freeze(updated)
    }
    if (changed) replaceObstacleMap(Object.freeze(next))
  }, [replaceObstacleMap])

  const handleObstaclesClear = useCallback((): void => {
    replaceObstacleMap(EMPTY_OBSTACLES)
  }, [replaceObstacleMap])

  const handleSurfacePointer = useCallback((event: ViewerSurfacePointerEvent): void => {
    const activePanel = selectedPanelFor(panelSpecs, selectedPanelId)

    if (activeTool !== 'place' && activeSurfaceDrag.current !== null) {
      activeSurfaceDrag.current = null
      store.cancelManualPlacement()
      store.cancelArrayDrag()
      store.cancelAutoFill()
    }
    if (activeTool !== 'select' && (activeSurfaceBox.current !== null || surfaceGestureActive)) clearSurfaceBox()
    if (activeTool !== 'obstacle' && activeObstacleDrag.current !== null) clearObstacleDraft()

    if (activeTool === 'obstacle') {
      const active = activeObstacleDrag.current
      if (event.phase === 'down') {
        if (event.selection === null) return
        const surfaceId = event.selection.surface.id
        const startPoint = event.selection.hitLocal
        const existing = obstaclesBySurfaceRef.current[surfaceId] ?? EMPTY_OBSTACLE_LIST
        const hitObstacle = [...existing].reverse().find((obstacle) => obstacleContainsPoint(obstacle, startPoint))
        activeObstacleDrag.current = hitObstacle === undefined
          ? { mode: 'draw', pointerId: event.pointerId, surfaceId, startPoint, lastPoint: startPoint, moved: false }
          : { mode: 'move', pointerId: event.pointerId, surfaceId, startPoint, obstacle: hitObstacle, lastPoint: startPoint, moved: false }
        store.cancelManualPlacement()
        store.cancelArrayDrag()
        store.cancelAutoFill()
        store.setActiveSurface(surfaceId)
        setDraftObstacle(null)
        setDraftObstacleSurfaceId(surfaceId)
        return
      }
      if (active === null || active.pointerId !== event.pointerId) return
      if (event.selection !== null && event.selection.surface.id === active.surfaceId) {
        active.lastPoint = event.selection.hitLocal
        if (!active.moved && pointsDiffer(active.startPoint, event.selection.hitLocal)) active.moved = true
        if (active.moved) {
          setDraftObstacle(active.mode === 'move'
            ? movedObstacle(active.obstacle, active.startPoint, event.selection.hitLocal)
            : obstacleFromPoints(`draft:${active.surfaceId}`, active.startPoint, event.selection.hitLocal))
          setDraftObstacleSurfaceId(active.surfaceId)
        }
      }
      if (event.phase !== 'up' && event.phase !== 'cancel') return
      const finalPoint = event.selection !== null && event.selection.surface.id === active.surfaceId
        ? event.selection.hitLocal
        : active.lastPoint
      const valid = event.phase === 'up' && active.moved && pointsDiffer(active.startPoint, finalPoint)
      if (valid) {
        if (active.mode === 'move') {
          const moved = movedObstacle(active.obstacle, active.startPoint, finalPoint)
          handleObstacleChange(active.obstacle.id, { x: moved.x, y: moved.y })
        } else {
          const obstacle = Object.freeze(obstacleFromPoints(
            `${active.surfaceId}:obstacle:${String(++obstacleIdRef.current)}`,
            active.startPoint,
            finalPoint,
          ))
          const current = obstaclesBySurfaceRef.current
          const existing = current[active.surfaceId] ?? EMPTY_OBSTACLE_LIST
          replaceObstacleMap(Object.freeze({ ...current, [active.surfaceId]: Object.freeze([...existing, obstacle]) }))
        }
      }
      clearObstacleDraft()
      return
    }

    if (activeTool === 'place' && activePanel !== null) {
      const active = activeSurfaceDrag.current
      // Viewer move events with no buttons represent hover. Keep a transient
      // manual draft attached to the cursor; only pointerup commits it.
      if (event.phase === 'move' && active === null && event.buttons === 0 && event.selection !== null) {
        const surfaceId = event.selection.surface.id
        const draft = store.getSnapshot().manualPlacement
        const placementGroupId = draft?.panelId === activePanel.id ? draft.groupId : editableGroupId
        if (draft === undefined || draft.panelId !== activePanel.id || draft.surfaceId !== surfaceId || draft.groupId !== placementGroupId) {
          store.cancelManualPlacement()
          store.cancelArrayDrag()
          store.cancelAutoFill()
          store.beginManualPlacement({ panelId: activePanel.id, surfaceId, ...(placementGroupId === undefined ? {} : { groupId: placementGroupId }) })
        }
        store.setActiveSurface(surfaceId)
        store.updateManualPlacement(event.selection.hitLocal, surfaceId)
        return
      }
      if (event.phase === 'down') {
        if (event.selection === null) return
        // Read the group from the armed draft before cancelling it. React can
        // deliver this pointer event before the selection-clearing render from
        // "+ Panel" has committed, so the render-time editableGroupId may
        // still refer to the previous array for one frame.
        const armedDraft = store.getSnapshot().manualPlacement
        const placementGroupId = armedDraft?.panelId === activePanel.id ? armedDraft.groupId : editableGroupId
        activeSurfaceDrag.current = {
          pointerId: event.pointerId,
          panelId: activePanel.id,
          surfaceId: event.selection.surface.id,
          startPoint: event.selection.hitLocal,
          ...(placementGroupId === undefined ? {} : { groupId: placementGroupId }),
          lastPoint: event.selection.hitLocal,
          moved: false,
        }
        store.cancelArrayDrag()
        store.cancelAutoFill()
        store.cancelManualPlacement()
        store.setActiveSurface(event.selection.surface.id)
        store.beginManualPlacement({ panelId: activePanel.id, surfaceId: event.selection.surface.id, ...(placementGroupId === undefined ? {} : { groupId: placementGroupId }) })
        store.updateManualPlacement(event.selection.hitLocal, event.selection.surface.id)
        return
      }
      if (active === null || active.pointerId !== event.pointerId) return
      if (event.selection !== null && event.selection.surface.id === active.surfaceId) {
        active.lastPoint = event.selection.hitLocal
        if (!active.moved && pointsDiffer(active.startPoint, event.selection.hitLocal)) {
          active.moved = true
          store.cancelManualPlacement()
          store.beginArrayDrag(active.panelId, active.surfaceId, active.startPoint, editableSettings.orientation, active.groupId)
        }
        if (active.moved) {
          store.updateArrayDrag(event.selection.hitLocal)
          store.previewAutoFill({
            panelId: active.panelId,
            surfaceId: active.surfaceId,
            region: regionFromPoints(active.startPoint, event.selection.hitLocal),
            settings: editableSettings,
            obstacles: obstaclesBySurface[active.surfaceId] ?? EMPTY_OBSTACLE_LIST,
            ...(active.groupId === undefined ? {} : { groupId: active.groupId }),
          })
        } else {
          store.updateManualPlacement(event.selection.hitLocal, active.surfaceId)
        }
      }
      if (event.phase !== 'up' && event.phase !== 'cancel') return
      const finalPoint = event.selection !== null && event.selection.surface.id === active.surfaceId
        ? event.selection.hitLocal
        : active.lastPoint
      activeSurfaceDrag.current = null
      if (active.moved) {
        if (event.phase === 'up') {
          store.updateArrayDrag(finalPoint)
          store.commitArrayDrag(finalPoint)
        } else {
          store.cancelArrayDrag()
        }
        store.cancelAutoFill()
      } else if (event.phase === 'up') {
        // Invalid geometry (for example, a click outside the panel-safe
        // setback) leaves the draft in the store so the cursor can continue
        // searching for a valid point. Do not switch to Select unless the
        // placement was actually committed; otherwise the ghost becomes a
        // permanent `Dragging 1` draft with no tool able to finish it.
        const committed = store.commitManualPlacement(finalPoint)
        if (committed !== undefined) changeTool('select')
      } else {
        store.cancelManualPlacement()
        changeTool('select')
      }
      if (active.moved) changeTool('select')
      return
    }

    if (activeTool !== 'select') return
    const box = activeSurfaceBox.current
    if (event.phase === 'down') {
      if (event.selection === null || event.button !== 0 || event.pointerType === 'touch') return
      activeSurfaceBox.current = {
        pointerId: event.pointerId,
        surfaceId: event.selection.surface.id,
        startPoint: event.selection.hitLocal,
        lastPoint: event.selection.hitLocal,
        moved: false,
        additive: event.shiftKey,
      }
      setSurfaceGestureActive(true)
      return
    }
    if (box === null || box.pointerId !== event.pointerId) return
    if (event.selection !== null && event.selection.surface.id === box.surfaceId) {
      box.lastPoint = event.selection.hitLocal
      if (pointsDiffer(box.startPoint, event.selection.hitLocal)) box.moved = true
    }
    if (event.phase !== 'up' && event.phase !== 'cancel') return
    const finalPoint = event.selection !== null && event.selection.surface.id === box.surfaceId
      ? event.selection.hitLocal
      : box.lastPoint
    clearSurfaceBox()
    if (event.phase === 'up' && box.moved) {
      const polygon = event.surfaceBox?.surfaceId === box.surfaceId ? event.surfaceBox.corners : undefined
      if (polygon !== undefined) {
        store.selectByPolygon(polygon, box.surfaceId, box.additive)
      } else {
        store.selectByBox(regionFromPoints(box.startPoint, finalPoint), box.surfaceId, box.additive)
      }
      store.setActiveSurface(box.surfaceId)
    }
  }, [activeTool, changeTool, clearObstacleDraft, clearSurfaceBox, editableGroupId, editableSettings, handleObstacleChange, obstaclesBySurface, panelSpecs, replaceObstacleMap, selectedPanelId, store, surfaceGestureActive])

  const pointerSurface = useCallback((placement: PanelPlacement): SurfaceDescriptor | undefined =>
    surfaces.find((surface) => surface.id === placement.surfaceId), [surfaces])

  const handlePanelSelect = useCallback((placement: PanelPlacement, info: PanelPointerInfo): void => {
    // PanelBatch reports selection before drag-start. Keep an existing
    // multi-selection intact when the pointer starts on one of its panels so
    // dragging that panel moves the complete group; a click on an unselected
    // panel (or an explicit Shift gesture) still applies normal selection.
    const snapshot = store.getSnapshot()
    const groupIds = placement.groupId === undefined
      ? [placement.id]
      : Object.values(snapshot.placements).filter((candidate) => candidate.groupId === placement.groupId).map((candidate) => candidate.id)
    if (info.shiftKey) store.selectPanels([placement.id], true)
    else if (!snapshot.selectedIds.includes(placement.id)) store.selectPanels(groupIds)
    store.setActiveSurface(placement.surfaceId)
  }, [store])
  const handlePanelDragStart = useCallback((placement: PanelPlacement, info: PanelPointerInfo): void => {
    const point = pointFromPointer(pointerSurface(placement), info)
    if (point === undefined) return
    const before = store.getSnapshot()
    // Dragging an already-selected panel moves the whole current selection.
    // Only replace the selection when the drag starts on an unselected panel
    // (or when the caller explicitly requests additive selection).
    const selected = before.selectedIds.includes(placement.id) && !info.shiftKey
      ? before.selectedIds
      : store.selectPanels([placement.id], info.shiftKey)
    const snapshot = store.getSnapshot()
    const sameSurface = selected.filter((id) => snapshot.placements[id]?.surfaceId === placement.surfaceId)
    const placementIds = sameSurface.length > 0 ? sameSurface : [placement.id]
    activePanelDrag.current = { placementIds, startPoint: point, lastPoint: point }
    setDraggingPlacementIds(placementIds)
    setDragStartPoint(point)
    setDragPoint(point)
  }, [pointerSurface, store])
  const handlePanelDrag = useCallback((placement: PanelPlacement, info: PanelPointerInfo): void => {
    const point = pointFromPointer(pointerSurface(placement), info)
    const active = activePanelDrag.current
    if (point === undefined || active === null || !active.placementIds.includes(placement.id)) return
    active.lastPoint = point
    setDragPoint(point)
  }, [pointerSurface])
  const handlePanelDragEnd = useCallback((placement: PanelPlacement, info: PanelPointerInfo): void => {
    const point = pointFromPointer(pointerSurface(placement), info)
    const active = activePanelDrag.current
    if (active === null || !active.placementIds.includes(placement.id)) return
    const finalPoint = point ?? active.lastPoint
    const delta = { x: finalPoint.x - active.startPoint.x, y: finalPoint.y - active.startPoint.y }
    activePanelDrag.current = null
    setDraggingPlacementIds([])
    setDragStartPoint(null)
    setDragPoint(null)
    if (delta.x !== 0 || delta.y !== 0) {
      const validation = store.previewMoveGroup(active.placementIds, delta)
      const moved = validation.valid && store.moveGroup(active.placementIds, delta)
      setInteractionNotice(moved
        ? { text: 'Array moved.', kind: 'default' }
        : { text: `Move blocked: ${validation.reason ?? 'This position is invalid.'}`, kind: 'error' })
    }
  }, [pointerSurface, store])

  const handlePanelContextMenu = useCallback((placement: PanelPlacement, info: PanelPointerInfo): void => {
    const arrayId = placement.groupId ?? `single:${placement.id}`
    const snapshot = store.getSnapshot()
    const ids = Object.values(snapshot.placements)
      .filter((candidate) => (candidate.groupId ?? `single:${candidate.id}`) === arrayId)
      .map((candidate) => candidate.id)
    store.selectPanels(ids)
    store.setActiveSurface(placement.surfaceId)
    setPanelContextMenu({
      placementId: placement.id,
      arrayId,
      clientX: info.clientX ?? 24,
      clientY: info.clientY ?? 24,
    })
  }, [store])

  useEffect(() => {
    if (panelContextMenu === null || typeof document === 'undefined') return undefined
    const close = (): void => { setPanelContextMenu(null) }
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    document.addEventListener('click', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [panelContextMenu])

  const handleImportFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    const sequence = importSequenceRef.current + 1
    importSequenceRef.current = sequence
    const openingZip = files.length === 1 && files[0]?.name.toLowerCase().endsWith('.zip') === true
    if (openingZip) {
      setLoadError(null)
      setImportNotice(`Opening ${files[0]?.name ?? 'ZIP archive'}…`)
    }
    const result = await buildViewerSourceFromSelection(files)
    if (sequence !== importSequenceRef.current) return
    if (!result.ok) {
      setLoadError(result.message)
      setImportNotice(null)
      return
    }
    setLocalSource(result.source)
    setModelMetadata(null)
    setLoadProgress(null)
    setLoadError(null)
    setImportNotice(`Loaded ${result.obj.name}`)
    resetModelPlacementContext()
  }, [resetModelPlacementContext])

  const handleImport = useCallback((file: File): void => {
    void handleImportFiles([file])
  }, [handleImportFiles])
  const handleImportFilesRequest = useCallback((files: readonly File[]): void => {
    void handleImportFiles(files)
  }, [handleImportFiles])

  const handleLoadSample = useCallback((): void => {
    importSequenceRef.current += 1
    const sampleSource = createSampleViewerSource()
    setLocalSource(sampleSource)
    setModelMetadata(null)
    setLoadProgress(null)
    setLoadError(null)
    setImportNotice(`Loaded ${sampleSource.name ?? 'sample model'}`)
    resetModelPlacementContext()
  }, [resetModelPlacementContext])

  const handleCustomPanel = useCallback((panel: PanelSpec): void => {
    store.registerPanel(toPanelDefinition(panel))
    setCustomPanels((current) => current.some((existing) => existing.id === panel.id)
      ? current.map((existing) => existing.id === panel.id ? panel : existing)
      : [...current, panel])
    setSelectedPanelId(panel.id)
  }, [store])

  const handleSettings = useCallback((patch: Partial<PlacementState['settings']>): void => {
    if (editableGroupId === undefined) {
      if (!store.setSettings(patch)) setInteractionNotice({ text: 'No setting changed.', kind: 'default' })
      return
    }
    const changed = store.setGroupSettings(editableGroupId, patch)
    setInteractionNotice(changed
      ? { text: 'Array updated.', kind: 'default' }
      : { text: 'Change blocked: the resulting array would leave the roof, cross an opening or obstacle, or overlap another panel.', kind: 'error' })
  }, [editableGroupId, store])
  const handleSurfaceEdgeChange = useCallback((edge: SurfaceEdgeMetadata | undefined): void => {
    if (activeSurface === undefined) return
    store.setSurfaceEdge(activeSurface.id, edge)
  }, [activeSurface, store])
  const handleDelete = useCallback((ids: readonly string[]): void => { store.deletePanels(ids) }, [store])
  const handleUndo = useCallback((): void => { store.undo() }, [store])
  const handleRedo = useCallback((): void => { store.redo() }, [store])
  const handleNudge = useCallback((delta: Point2): void => { store.moveSelected(delta) }, [store])
  const handleMoveArray = useCallback((): void => { changeTool('select') }, [changeTool])
  const handleRotateArray = useCallback((): void => {
    if (editableGroupId === undefined) return
    const snapshot = store.getSnapshot()
    const groupIds = Object.values(snapshot.placements).filter((placement) => placement.groupId === editableGroupId).map((placement) => placement.id)
    const changed = store.rotateGroup(true, groupIds)
    setInteractionNotice(changed
      ? { text: 'Array rotated 90°.', kind: 'default' }
      : { text: 'Rotation blocked: there is not enough valid roof space.', kind: 'error' })
  }, [editableGroupId, store])
  const handleDuplicateArray = useCallback((): void => {
    if (editableGroupId === undefined) return
    const created = store.duplicateArray(editableGroupId)
    setInteractionNotice(created.length > 0
      ? { text: `Duplicated ${String(created.length)} panels as a new array.`, kind: 'default' }
      : { text: 'Duplicate blocked: no collision-free copy fits at the proposed position.', kind: 'error' })
  }, [editableGroupId, store])
  const handleDeleteArray = useCallback((): void => {
    if (editableGroupId === undefined) return
    const deleted = store.deleteArray(editableGroupId)
    if (deleted > 0) setInteractionNotice({ text: `Deleted array (${String(deleted)} panels). Use Undo to restore it.`, kind: 'default' })
  }, [editableGroupId, store])

  const handleArraySelect = useCallback((arrayId: string): void => {
    const array = store.getArrays().find((candidate) => candidate.id === arrayId)
    if (array === undefined) return
    store.selectPanels(array.placementIds)
  }, [store])

  const handleArrayPanelChange = useCallback((panelId: string): void => {
    if (editableGroupId === undefined) return
    const changed = store.replaceArrayPanel(editableGroupId, panelId)
    setInteractionNotice(changed
      ? { text: 'Updated the panel model for the complete array.', kind: 'default' }
      : { text: 'That panel model does not fit this array in its current position.', kind: 'error' })
    if (changed) setSelectedPanelId(panelId)
  }, [editableGroupId, store])

  const autoFillReady = selectedPanel !== null && activeSurface !== undefined
  const handleAutoFill = useCallback((): void => {
    if (!autoFillReady) return
    const preview = store.previewAutoFill({
      panelId: selectedPanel.id,
      surfaceId: activeSurface.id,
      region: activeSurface.region,
      settings: editableSettings,
      obstacles: activeObstacles,
      ...(editableGroupId === undefined ? {} : { groupId: editableGroupId }),
    })
    if (preview !== undefined) changeTool('autofill')
  }, [activeObstacles, activeSurface, autoFillReady, changeTool, editableGroupId, editableSettings, selectedPanel, store])
  const confirmAutoFill = useCallback((): void => {
    store.confirmAutoFill()
    changeTool('select')
  }, [changeTool, store])
  const cancelAutoFill = useCallback((): void => {
    store.cancelAutoFill()
    changeTool('select')
  }, [changeTool, store])

  const canAlign = placementState.selectedIds.length >= 2
  const handleAlignStart = useCallback((): void => {
    if (!canAlign) return
    const anchorId = placementState.selectedIds[0]
    store.setAlignMode(true, anchorId)
    if (anchorId !== undefined) store.previewAlign(anchorId)
    changeTool('align')
  }, [canAlign, changeTool, placementState.selectedIds, store])
  const handleAlignConfirm = useCallback((): void => {
    store.confirmAlign()
    store.setAlignMode(false)
    changeTool('select')
  }, [changeTool, store])
  const handleAlignCancel = useCallback((): void => {
    store.cancelAlign()
    store.setAlignMode(false)
    changeTool('select')
  }, [changeTool, store])

  const manualGhost = useMemo<readonly PanelPlacement[]>(() => {
    const draft = placementState.manualPlacement
    if (draft === undefined || draft.localCenter === undefined) return []
    return [{
      id: 'manual-preview',
      panelId: draft.panelId,
      surfaceId: draft.surfaceId,
      localCenter: draft.localCenter,
      orientation: draft.orientation,
      clearanceM: draft.clearanceM,
      tiltDeg: draft.tiltDeg,
      ...(draft.azimuthDeg === undefined ? {} : { azimuthDeg: draft.azimuthDeg }),
      ...(draft.groupId === undefined ? {} : { groupId: draft.groupId }),
    }]
  }, [placementState.manualPlacement])
  const dragDelta = useMemo<Point2 | null>(() => {
    if (dragStartPoint === null || dragPoint === null) return null
    return { x: dragPoint.x - dragStartPoint.x, y: dragPoint.y - dragStartPoint.y }
  }, [dragPoint, dragStartPoint])
  const renderPlacements = useMemo<readonly PanelPlacement[]>(() => {
    if (dragDelta === null || draggingPlacementIds.length === 0) return placements
    const ids = new Set(draggingPlacementIds)
    return placements.map((placement) => ids.has(placement.id)
      ? { ...placement, localCenter: { x: placement.localCenter.x + dragDelta.x, y: placement.localCenter.y + dragDelta.y } }
      : placement)
  }, [dragDelta, draggingPlacementIds, placements])
  const dragValidation = useMemo(() => {
    if (dragDelta === null || draggingPlacementIds.length === 0) return null
    return store.previewMoveGroup(draggingPlacementIds, dragDelta)
  }, [dragDelta, draggingPlacementIds, store])
  const draggingIds = draggingPlacementIds
  const invalidDraggingIds = dragValidation?.valid === false ? draggingPlacementIds : []
  const renderedSummary = useMemo(() => draggingPlacementIds.length === 0
    ? summary
    : { ...summary, draggingCount: draggingPlacementIds.length }, [draggingPlacementIds.length, summary])
  const ghostPlacements = useMemo<readonly PanelPlacement[]>(() => [...manualGhost], [manualGhost])
  const panelSlotOutlines = useMemo<readonly PanelSlotOutline[]>(() => {
    if (editableGroupId === undefined || activeTool !== 'select') return []
    const groupPlacements = placements.filter((placement) => placement.groupId === editableGroupId)
    const first = groupPlacements[0]
    if (first === undefined) return []
    const panel = Object.values(definitions).find((definition) => definition.id === first.panelId)
    const surface = surfaces.find((candidate) => candidate.id === first.surfaceId)
    if (panel === undefined || surface === undefined) return []
    const edge = surfaceEdges[first.surfaceId]
    return createAdjacentPanelSlots(groupPlacements, panel, editableSettings).flatMap((input, index) => {
      const validation = store.previewPanelResult(input)
      const preview = validation.placement
      if (preview === undefined) return []
      return [{
        placement: { ...preview, id: `panel-slot-${String(index)}` },
        panel,
        surface,
        valid: validation.valid,
        ...(validation.reason === undefined ? {} : { reason: validation.reason }),
        ...(edge === undefined ? {} : { edge }),
      }]
    })
  }, [activeTool, definitions, editableGroupId, editableSettings, placements, store, surfaceEdges, surfaces])
  const handleAddPanelSlot = useCallback((slot: PanelPlacement): void => {
    const created = store.addPanel({
      panelId: slot.panelId,
      surfaceId: slot.surfaceId,
      localCenter: slot.localCenter,
      orientation: slot.orientation,
      clearanceM: slot.clearanceM,
      tiltDeg: slot.tiltDeg,
      ...(slot.azimuthDeg === undefined ? {} : { azimuthDeg: slot.azimuthDeg }),
      ...(slot.groupId === undefined ? {} : { groupId: slot.groupId }),
    })
    if (created?.groupId === undefined) return
    const snapshot = store.getSnapshot()
    store.selectPanels(Object.values(snapshot.placements).filter((placement) => placement.groupId === created.groupId).map((placement) => placement.id))
  }, [store])

  const alignPreview = useMemo<AlignPreviewState | null>(() => {
    if (!placementState.align.enabled) return null
    const preview = placementState.alignPreview
    if (preview === undefined) return { candidateCount: 0, valid: false, reason: 'Select panels on one surface to preview alignment.' }
    return {
      candidateCount: preview.placements.length,
      valid: preview.valid,
      ...(preview.reason === undefined ? {} : { reason: preview.reason }),
    }
  }, [placementState.align, placementState.alignPreview])
  const alignStage = !placementState.align.enabled ? 'idle' : placementState.alignPreview === undefined ? 'preview' : 'confirm'
  const inspector = placementState.autoFillPreview === undefined ? undefined : (
    <AutoFillInspector
      count={placementState.autoFillPreview.candidates.length}
      totalKwp={placementState.autoFillPreview.totalKwp}
      onConfirm={confirmAutoFill}
      onCancel={cancelAutoFill}
    />
  )
  const statusMessage: string | undefined = loadError
    ?? (loadProgress !== null && loadProgress.phase !== 'complete' ? `${loadProgress.phase ?? 'Loading'} ${String(Math.round(loadProgress.progress * 100))}%` : undefined)
    ?? (dragValidation === null
      ? undefined
      : dragValidation.valid
        ? 'Release to place the array.'
        : `Move blocked: ${dragValidation.reason ?? 'This position is invalid.'}`)
    ?? interactionNotice?.text
    ?? importNotice
    ?? undefined
  const statusKind: 'default' | 'progress' | 'error' = loadError !== null || interactionNotice?.kind === 'error'
    ? 'error'
    : (loadProgress !== null && loadProgress.phase !== 'complete') || importNotice?.startsWith('Opening ') === true
      ? 'progress'
      : 'default'
  const selectedShellSurface: ShellSurface | null = activeSurface === undefined ? null : toShellSurface(activeSurface)
  const selectedShellSurfaceEdge: ShellSurfaceEdge | null = activeSurface === undefined
    ? null
    : store.surfaceEdgeSummary(activeSurface.id) ?? null
  const inspectedPanel = selectedArray === undefined
    ? selectedPanel
    : selectedPanelFor(panelSpecs, selectedArray.panelId)
  const selectedShellPanel: ShellPanel | null = inspectedPanel === null ? null : toShellPanel(inspectedPanel)

  const sceneContent = (
    <PanelLayer
      panelDefinitions={definitions}
      surfaces={surfaces}
      surfaceEdges={surfaceEdges}
      placements={renderPlacements}
      panelVisuals={panelVisuals}
      selectedIds={placementState.selectedIds}
      draggingIds={draggingIds}
      invalidDraggingIds={invalidDraggingIds}
      ghostPlacements={ghostPlacements}
      autoFillPreview={placementState.autoFillPreview}
      interactivePreview={activeTool === 'autofill' || placementState.arrayDrag !== undefined}
      // The place tool owns the viewer surface pointer stream.  Panels in
      // this state include the cursor ghost, so leaving their meshes
      // interactive would let the nearest instanced mesh stop propagation
      // before Viewer can commit the surface click.  Panel drag remains
      // available through the select tool (where this flag stays enabled).
      interactionsEnabled={activeTool !== 'obstacle' && activeTool !== 'place'}
      onPanelSelect={handlePanelSelect}
      onPanelDragStart={handlePanelDragStart}
      onPanelDrag={handlePanelDrag}
      onPanelDragEnd={handlePanelDragEnd}
      onPanelContextMenu={handlePanelContextMenu}
    >
      <ObstacleLayer
        surfaces={surfaces}
        obstaclesBySurface={obstaclesBySurface}
        draftObstacle={draftObstacle}
        draftSurfaceId={draftObstacleSurfaceId}
      />
      {activeTool !== 'place' && activeTool !== 'obstacle' ? (
        <ArrayCanvasHandles
          placements={selectedArrayPlacements}
          panelDefinitions={definitionRecord}
          surfaces={surfaces}
          onMove={handleMoveArray}
          onRotate={handleRotateArray}
        />
      ) : null}
      <PanelSlotOutlines slots={panelSlotOutlines} onAdd={handleAddPanelSlot} onRejected={(reason) => { setInteractionNotice({ text: reason, kind: 'error' }) }} />
    </PanelLayer>
  )

  return (
    <>
    <Shell
      projectName={modelMetadata?.name ?? source?.name ?? projectName}
      viewer={(
        <Viewer
          source={source}
          cameraMode={cameraMode === '3d' ? 'perspective' : 'orthographic'}
          onCameraModeChange={(mode) => { setCameraMode(mode === 'perspective' ? '3d' : '2d') }}
          renderMode={renderMode}
          onRenderModeChange={setRenderMode}
          surfaceInteractionMode={activeTool === 'place' ? 'place' : activeTool === 'obstacle' ? 'obstacle' : 'select'}
          surfaceGestureActive={surfaceGestureActive}
          showGrid={showGrid}
          shadows
          sceneContent={sceneContent}
          onModelLoaded={handleModelLoaded}
          onLoadProgress={handleLoadProgress}
          onError={handleViewerError}
          onSurfacesChange={replaceSurfaces}
          onSurfaceSelect={handleSurfaceSelect}
          onSurfacePointer={handleSurfacePointer}
        />
      )}
      panelChooser={(
        <PanelChooser
          // PanelChooser owns the transient custom-panel form records. Keep
          // the chooser's source catalogue static while App retains the
          // custom records for placement definitions and render visuals;
          // passing both would add each saved custom panel twice when the
          // chooser's local state receives the same record.
          panels={PANEL_CATALOG}
          selectedPanelId={selectedPanelId}
          onPanelSelect={choosePanel}
          onAddPanel={registerAndArmPanel}
          onCreateCustomPanel={handleCustomPanel}
        />
      )}
      inspector={inspector}
      panelStatus={<PanelRenderStatus panelCount={renderedSummary.count} selectedCount={renderedSummary.selectedCount} previewCount={renderedSummary.previewCount} draggingCount={renderedSummary.draggingCount} totalKwp={renderedSummary.totalKwp} />}
      cameraMode={cameraMode}
      onCameraModeChange={setCameraMode}
      renderMode={renderMode}
      onRenderModeChange={setRenderMode}
      showGrid={showGrid}
      onShowGridChange={setShowGrid}
      activeTool={activeTool}
      onToolChange={changeTool}
      selectedSurface={selectedShellSurface}
      selectedSurfaceEdge={selectedShellSurfaceEdge}
      onSurfaceEdgeChange={handleSurfaceEdgeChange}
      selectedPanel={selectedShellPanel}
      panelOptions={shellPanelOptions}
      arrays={shellArrays}
      selectedArrayId={editableGroupId}
      onArraySelect={handleArraySelect}
      onArrayPanelChange={editableGroupId === undefined ? undefined : handleArrayPanelChange}
      onAddSelectedPanel={selectedPanel === null ? undefined : () => { registerAndArmPanel(selectedPanel) }}
      placements={placements}
      selectedPlacementIds={placementState.selectedIds}
      placementSummary={renderedSummary}
      settings={editableSettings}
      settingsScopeLabel={settingsScopeLabel}
      onSettingsChange={handleSettings}
      alignStage={alignStage}
      alignPreview={alignPreview}
      canUndo={placementState.undoDepth > 0}
      canRedo={placementState.redoDepth > 0}
      onUndo={handleUndo}
      onRedo={handleRedo}
      onDelete={handleDelete}
      onNudgeSelection={handleNudge}
      onMoveSelection={editableGroupId === undefined ? undefined : handleMoveArray}
      onRotateSelection={editableGroupId === undefined ? undefined : handleRotateArray}
      onDuplicateSelection={editableGroupId === undefined ? undefined : handleDuplicateArray}
      onDeleteArray={editableGroupId === undefined ? undefined : handleDeleteArray}
      onAutoFill={autoFillReady ? handleAutoFill : undefined}
      obstacles={activeObstacles}
      draftObstacle={draftObstacle}
      onObstacleStart={activeSurface === undefined ? undefined : handleObstacleStart}
      onObstacleCancel={handleObstacleCancel}
      onObstacleChange={handleObstacleChange}
      onObstacleRemove={handleObstacleRemove}
      onObstaclesClear={handleObstaclesClear}
      onAlignStart={canAlign ? handleAlignStart : undefined}
      onAlignConfirm={placementState.align.enabled ? handleAlignConfirm : undefined}
      onAlignCancel={placementState.align.enabled ? handleAlignCancel : undefined}
      onImport={handleImport}
      onImportFiles={handleImportFilesRequest}
      onLoadSample={handleLoadSample}
      acceptedImportTypes=".zip,.obj,.mtl,.jpg,.jpeg,.png"
      webglAvailable={webglAvailable}
      statusMessage={statusMessage}
      statusKind={statusKind}
      initialCameraMode={initialCameraMode}
      initialRenderMode={initialRenderMode}
      initialShowGrid={initialShowGrid}
    />
    {panelContextMenu === null ? null : (
      <div
        className="panel-context-menu"
        role="menu"
        aria-label="Panel actions"
        style={{ left: panelContextMenu.clientX, top: panelContextMenu.clientY }}
        onClick={(event) => { event.stopPropagation() }}
        onContextMenu={(event) => { event.preventDefault() }}
      >
        <button type="button" role="menuitem" onClick={() => {
          const deleted = store.deletePanel(panelContextMenu.placementId)
          setInteractionNotice(deleted ? { text: 'Panel deleted. Undo is available.', kind: 'default' } : { text: 'Panel could not be deleted.', kind: 'error' })
          setPanelContextMenu(null)
        }}>Delete panel</button>
        <button type="button" role="menuitem" onClick={() => {
          const deleted = store.deleteArray(panelContextMenu.arrayId)
          setInteractionNotice(deleted > 0 ? { text: `Array deleted (${String(deleted)} panels). Undo is available.`, kind: 'default' } : { text: 'Array could not be deleted.', kind: 'error' })
          setPanelContextMenu(null)
        }}>Delete array</button>
        <button type="button" role="menuitem" onClick={() => {
          const duplicated = store.duplicateArray(panelContextMenu.arrayId)
          setInteractionNotice(duplicated.length > 0 ? { text: `Array duplicated (${String(duplicated.length)} panels).`, kind: 'default' } : { text: 'Duplicate blocked: there is no valid free position beside this array.', kind: 'error' })
          setPanelContextMenu(null)
        }}>Duplicate array</button>
      </div>
    )}
    </>
  )
}
