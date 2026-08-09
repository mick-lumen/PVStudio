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
  SurfaceSelection,
} from './core'
import { projectPointToSurface } from './core'
import { PANEL_CATALOG, toPanelDefinition, type PanelSpec } from './data'
import { createPlacementStore, type PlacementState, type PlacementStore } from './placement'
import { PanelChooser } from './panels'
import {
  PanelLayer,
  PanelRenderStatus,
  ObstacleLayer,
  type PanelPointerInfo,
} from './rendering'
import {
  Shell,
  type AlignPreviewState,
  type ShellPanel,
  type ShellSurface,
  type ToolId,
  type ViewMode,
  type RenderMode,
} from './shell/Shell'
import {
  createPanelVisuals,
  buildViewerSourceFromFiles,
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

const CATALOG_DEFINITIONS: readonly PanelDefinition[] = Object.freeze(PANEL_CATALOG.map((panel) => toPanelDefinition(panel)))

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

interface ActiveObstacleDrag {
  readonly pointerId: number
  readonly surfaceId: string
  readonly startPoint: Point2
  lastPoint: Point2
  moved: boolean
}

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
  const [obstaclesBySurface, setObstaclesBySurface] = useState<ObstacleMap>(() => EMPTY_OBSTACLES)
  const [draftObstacle, setDraftObstacle] = useState<RectangularObstacle | null>(null)
  const [draftObstacleSurfaceId, setDraftObstacleSurfaceId] = useState<string | null>(null)
  const [modelMetadata, setModelMetadata] = useState<ViewerModelMetadata | null>(null)
  const [loadProgress, setLoadProgress] = useState<ViewerLoadProgress | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [importNotice, setImportNotice] = useState<string | null>(null)
  const surfacesRef = useRef<readonly SurfaceDescriptor[]>([])
  const activePanelDrag = useRef<ActivePanelDrag | null>(null)
  const activeSurfaceDrag = useRef<ActiveSurfaceDrag | null>(null)
  const activeSurfaceBox = useRef<ActiveSurfaceBox | null>(null)
  const activeObstacleDrag = useRef<ActiveObstacleDrag | null>(null)
  const obstaclesBySurfaceRef = useRef<ObstacleMap>(EMPTY_OBSTACLES)
  const obstacleIdRef = useRef(0)
  const previousControlledSource = useRef<ViewerModelSource | null | undefined>(controlledSource)
  const [draggingPlacementIds, setDraggingPlacementIds] = useState<readonly string[]>([])
  const [dragStartPoint, setDragStartPoint] = useState<Point2 | null>(null)
  const [dragPoint, setDragPoint] = useState<Point2 | null>(null)

  const source = controlledSource !== undefined ? controlledSource : localSource

  const replaceObstacleMap = useCallback((next: ObstacleMap): void => {
    if (!store.setObstacles(next)) return
    obstaclesBySurfaceRef.current = next
    setObstaclesBySurface(next)
  }, [store])

  // A controlled model replacement invalidates the previous surface topology
  // and its placements. Clear the topology eagerly so a stale callback from
  // the replaced viewer cannot be mistaken for the new model's surfaces.
  useEffect(() => {
    if (previousControlledSource.current === controlledSource) return
    previousControlledSource.current = controlledSource
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
    setActiveTool('select')
    store.replaceContext({ panels: store.context.panels ?? [], surfaces: [], obstacles: EMPTY_OBSTACLES })
  }, [controlledSource, replaceObstacleMap, store])

  const panelSpecs = useMemo<readonly PanelSpec[]>(
    () => Object.freeze([...PANEL_CATALOG, ...customPanels]),
    [customPanels],
  )
  const selectedPanel = useMemo(() => selectedPanelFor(panelSpecs, selectedPanelId), [selectedPanelId, panelSpecs])
  const panelVisuals = useMemo(() => createPanelVisuals(panelSpecs), [panelSpecs])
  const definitions = store.context.panels ?? []
  const placements = useMemo(() => placementValues(placementState), [placementState])
  const activeSurface = selectedSurfaceFor(surfaces, placementState)
  const activeObstacles = activeSurface === undefined
    ? EMPTY_OBSTACLE_LIST
    : obstaclesBySurface[activeSurface.id] ?? EMPTY_OBSTACLE_LIST
  const summary = useMemo(() => summarisePlacementState(placementState, store), [placementState, store])

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
    replaceObstacleMap(EMPTY_OBSTACLES)
    setDraftObstacle(null)
    setDraftObstacleSurfaceId(null)
    // The first surface topology notification can arrive after a user arms a
    // panel before the viewer has emitted its surfaces. Preserve that pending
    // placement tool while there was no previous topology to invalidate; an
    // existing topology replacement still resets to select.
    if (hadSurfaceTopology) setActiveTool('select')
    const contextPanels = store.context.panels ?? []
    store.replaceContext({ panels: contextPanels, surfaces: frozen, obstacles: EMPTY_OBSTACLES })
    const firstSurface = frozen[0]
    if (firstSurface !== undefined) store.setActiveSurface(firstSurface.id)
  }, [replaceObstacleMap, store])

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
    replaceObstacleMap(EMPTY_OBSTACLES)
    setDraftObstacle(null)
    setDraftObstacleSurfaceId(null)
    setActiveTool('select')
    store.replaceContext({ panels: store.context.panels ?? [], surfaces: [], obstacles: EMPTY_OBSTACLES })
  }, [replaceObstacleMap, store])

  const choosePanel = useCallback((panel: PanelSpec | null): void => {
    setSelectedPanelId(panel?.id ?? null)
    if (panel === null) {
      setActiveTool('select')
      store.cancelManualPlacement()
    }
  }, [store])

  const registerAndArmPanel = useCallback((panel: PanelSpec): void => {
    const definition = toPanelDefinition(panel)
    store.registerPanel(definition)
    setSelectedPanelId(panel.id)
    const surface = selectedSurfaceFor(surfaces, store.getSnapshot()) ?? surfaces[0]
    if (surface === undefined) {
      setActiveTool('place')
      return
    }
    store.setActiveSurface(surface.id)
    store.beginManualPlacement({ panelId: panel.id, surfaceId: surface.id })
    setActiveTool('place')
  }, [store, surfaces])

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
    activeSurfaceBox.current = null
    store.cancelManualPlacement()
    store.cancelArrayDrag()
    store.cancelAutoFill()
    clearObstacleDraft()
    setActiveTool('obstacle')
  }, [clearObstacleDraft, store])

  const handleObstacleCancel = useCallback((): void => {
    clearObstacleDraft()
    setActiveTool('select')
  }, [clearObstacleDraft])

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
    if (activeTool !== 'select' && activeSurfaceBox.current !== null) {
      activeSurfaceBox.current = null
    }
    if (activeTool !== 'obstacle' && activeObstacleDrag.current !== null) clearObstacleDraft()

    if (activeTool === 'obstacle') {
      const active = activeObstacleDrag.current
      if (event.phase === 'down') {
        if (event.selection === null) return
        activeObstacleDrag.current = {
          pointerId: event.pointerId,
          surfaceId: event.selection.surface.id,
          startPoint: event.selection.hitLocal,
          lastPoint: event.selection.hitLocal,
          moved: false,
        }
        store.cancelManualPlacement()
        store.cancelArrayDrag()
        store.cancelAutoFill()
        store.setActiveSurface(event.selection.surface.id)
        setDraftObstacle(null)
        setDraftObstacleSurfaceId(event.selection.surface.id)
        return
      }
      if (active === null || active.pointerId !== event.pointerId) return
      if (event.selection !== null && event.selection.surface.id === active.surfaceId) {
        active.lastPoint = event.selection.hitLocal
        if (!active.moved && pointsDiffer(active.startPoint, event.selection.hitLocal)) active.moved = true
        if (active.moved) {
          setDraftObstacle(obstacleFromPoints(`draft:${active.surfaceId}`, active.startPoint, event.selection.hitLocal))
          setDraftObstacleSurfaceId(active.surfaceId)
        }
      }
      if (event.phase !== 'up' && event.phase !== 'cancel') return
      const finalPoint = event.selection !== null && event.selection.surface.id === active.surfaceId
        ? event.selection.hitLocal
        : active.lastPoint
      const valid = event.phase === 'up' && active.moved && pointsDiffer(active.startPoint, finalPoint)
      if (valid) {
        const obstacle = Object.freeze(obstacleFromPoints(
          `${active.surfaceId}:obstacle:${String(++obstacleIdRef.current)}`,
          active.startPoint,
          finalPoint,
        ))
        const current = obstaclesBySurfaceRef.current
        const existing = current[active.surfaceId] ?? EMPTY_OBSTACLE_LIST
        replaceObstacleMap(Object.freeze({ ...current, [active.surfaceId]: Object.freeze([...existing, obstacle]) }))
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
        if (draft === undefined || draft.panelId !== activePanel.id || draft.surfaceId !== surfaceId) {
          store.cancelManualPlacement()
          store.cancelArrayDrag()
          store.cancelAutoFill()
          store.beginManualPlacement({ panelId: activePanel.id, surfaceId })
        }
        store.setActiveSurface(surfaceId)
        store.updateManualPlacement(event.selection.hitLocal, surfaceId)
        return
      }
      if (event.phase === 'down') {
        if (event.selection === null) return
        activeSurfaceDrag.current = {
          pointerId: event.pointerId,
          panelId: activePanel.id,
          surfaceId: event.selection.surface.id,
          startPoint: event.selection.hitLocal,
          lastPoint: event.selection.hitLocal,
          moved: false,
        }
        store.cancelArrayDrag()
        store.cancelAutoFill()
        store.cancelManualPlacement()
        store.setActiveSurface(event.selection.surface.id)
        store.beginManualPlacement({ panelId: activePanel.id, surfaceId: event.selection.surface.id })
        store.updateManualPlacement(event.selection.hitLocal, event.selection.surface.id)
        return
      }
      if (active === null || active.pointerId !== event.pointerId) return
      if (event.selection !== null && event.selection.surface.id === active.surfaceId) {
        active.lastPoint = event.selection.hitLocal
        if (!active.moved && pointsDiffer(active.startPoint, event.selection.hitLocal)) {
          active.moved = true
          store.cancelManualPlacement()
          store.beginArrayDrag(active.panelId, active.surfaceId, active.startPoint, store.getSnapshot().settings.orientation)
        }
        if (active.moved) {
          store.updateArrayDrag(event.selection.hitLocal)
          store.previewAutoFill({
            panelId: active.panelId,
            surfaceId: active.surfaceId,
            region: regionFromPoints(active.startPoint, event.selection.hitLocal),
            settings: store.getSnapshot().settings,
            obstacles: obstaclesBySurface[active.surfaceId] ?? EMPTY_OBSTACLE_LIST,
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
        if (committed !== undefined) setActiveTool('select')
      } else {
        store.cancelManualPlacement()
        setActiveTool('select')
      }
      if (active.moved) setActiveTool('select')
      return
    }

    if (activeTool !== 'select') return
    const box = activeSurfaceBox.current
    if (event.phase === 'down') {
      if (event.selection === null) return
      activeSurfaceBox.current = {
        pointerId: event.pointerId,
        surfaceId: event.selection.surface.id,
        startPoint: event.selection.hitLocal,
        lastPoint: event.selection.hitLocal,
        moved: false,
        additive: event.shiftKey,
      }
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
    activeSurfaceBox.current = null
    if (event.phase === 'up' && box.moved) {
      store.selectByBox(regionFromPoints(box.startPoint, finalPoint), box.surfaceId, box.additive)
      store.setActiveSurface(box.surfaceId)
    }
  }, [activeTool, clearObstacleDraft, obstaclesBySurface, panelSpecs, replaceObstacleMap, selectedPanelId, store])

  const pointerSurface = useCallback((placement: PanelPlacement): SurfaceDescriptor | undefined =>
    surfaces.find((surface) => surface.id === placement.surfaceId), [surfaces])

  const handlePanelSelect = useCallback((placement: PanelPlacement, info: PanelPointerInfo): void => {
    store.selectPanels([placement.id], info.shiftKey)
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
    if (delta.x !== 0 || delta.y !== 0) store.moveGroup(active.placementIds, delta)
  }, [pointerSurface, store])

  const handleImportFiles = useCallback((files: readonly File[]): void => {
    const result = buildViewerSourceFromFiles(files)
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
    handleImportFiles([file])
  }, [handleImportFiles])

  const handleLoadSample = useCallback((): void => {
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
    store.setSettings(patch)
  }, [store])
  const handleDelete = useCallback((ids: readonly string[]): void => { store.deletePanels(ids) }, [store])
  const handleUndo = useCallback((): void => { store.undo() }, [store])
  const handleRedo = useCallback((): void => { store.redo() }, [store])
  const handleNudge = useCallback((delta: Point2): void => { store.moveSelected(delta) }, [store])

  const autoFillReady = selectedPanel !== null && activeSurface !== undefined
  const handleAutoFill = useCallback((): void => {
    if (!autoFillReady) return
    const preview = store.previewAutoFill({
      panelId: selectedPanel.id,
      surfaceId: activeSurface.id,
      region: activeSurface.region,
      settings: store.getSnapshot().settings,
      obstacles: activeObstacles,
    })
    if (preview !== undefined) setActiveTool('autofill')
  }, [activeObstacles, activeSurface, autoFillReady, selectedPanel, store])
  const confirmAutoFill = useCallback((): void => {
    store.confirmAutoFill()
    setActiveTool('select')
  }, [store])
  const cancelAutoFill = useCallback((): void => {
    store.cancelAutoFill()
    setActiveTool('select')
  }, [store])

  const canAlign = placementState.selectedIds.length >= 2
  const handleAlignStart = useCallback((): void => {
    if (!canAlign) return
    const anchorId = placementState.selectedIds[0]
    store.setAlignMode(true, anchorId)
    if (anchorId !== undefined) store.previewAlign(anchorId)
    setActiveTool('align')
  }, [canAlign, placementState.selectedIds, store])
  const handleAlignConfirm = useCallback((): void => {
    store.confirmAlign()
    store.setAlignMode(false)
    setActiveTool('select')
  }, [store])
  const handleAlignCancel = useCallback((): void => {
    store.cancelAlign()
    store.setAlignMode(false)
    setActiveTool('select')
  }, [store])

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
  const draggingIds = draggingPlacementIds
  const renderedSummary = useMemo(() => draggingPlacementIds.length === 0
    ? summary
    : { ...summary, draggingCount: draggingPlacementIds.length }, [draggingPlacementIds.length, summary])
  const ghostPlacements = useMemo<readonly PanelPlacement[]>(() => [...manualGhost], [manualGhost])

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
    ?? importNotice
    ?? undefined
  const selectedShellSurface: ShellSurface | null = activeSurface === undefined ? null : toShellSurface(activeSurface)
  const selectedShellPanel: ShellPanel | null = selectedPanel === null ? null : toShellPanel(selectedPanel)

  const sceneContent = (
    <PanelLayer
      panelDefinitions={definitions}
      surfaces={surfaces}
      placements={renderPlacements}
      panelVisuals={panelVisuals}
      selectedIds={placementState.selectedIds}
      draggingIds={draggingIds}
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
    >
      <ObstacleLayer
        surfaces={surfaces}
        obstaclesBySurface={obstaclesBySurface}
        draftObstacle={draftObstacle}
        draftSurfaceId={draftObstacleSurfaceId}
      />
    </PanelLayer>
  )

  return (
    <Shell
      projectName={modelMetadata?.name ?? source?.name ?? projectName}
      viewer={(
        <Viewer
          source={source}
          cameraMode={cameraMode === '3d' ? 'perspective' : 'orthographic'}
          renderMode={renderMode}
          surfaceInteractionMode={activeTool === 'place' ? 'place' : activeTool === 'obstacle' ? 'obstacle' : 'select'}
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
      onToolChange={setActiveTool}
      selectedSurface={selectedShellSurface}
      selectedPanel={selectedShellPanel}
      placements={placements}
      selectedPlacementIds={placementState.selectedIds}
      placementSummary={renderedSummary}
      settings={placementState.settings}
      onSettingsChange={handleSettings}
      alignStage={alignStage}
      alignPreview={alignPreview}
      canUndo={placementState.undoDepth > 0}
      canRedo={placementState.redoDepth > 0}
      onUndo={handleUndo}
      onRedo={handleRedo}
      onDelete={handleDelete}
      onNudgeSelection={handleNudge}
      onAutoFill={autoFillReady ? handleAutoFill : undefined}
      obstacles={activeObstacles}
      draftObstacle={draftObstacle}
      onObstacleStart={activeSurface === undefined ? undefined : handleObstacleStart}
      onObstacleCancel={handleObstacleCancel}
      onObstacleRemove={handleObstacleRemove}
      onObstaclesClear={handleObstaclesClear}
      onAlignStart={canAlign ? handleAlignStart : undefined}
      onAlignConfirm={placementState.align.enabled ? handleAlignConfirm : undefined}
      onAlignCancel={placementState.align.enabled ? handleAlignCancel : undefined}
      onImport={handleImport}
      onImportFiles={handleImportFiles}
      onLoadSample={handleLoadSample}
      acceptedImportTypes=".obj,.mtl,.jpg,.jpeg,.png"
      webglAvailable={webglAvailable}
      statusMessage={statusMessage}
      initialCameraMode={initialCameraMode}
      initialRenderMode={initialRenderMode}
      initialShowGrid={initialShowGrid}
    />
  )
}
