import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import type { OrbitControls as OrbitControlsObject } from 'three-stdlib'
import * as THREE from 'three'
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createDemoViewerModel } from './demoScene'
import { cameraNorthAngleDegrees, computeViewerFrame, computeViewerFrameFromBounds, createViewerOrthographicFrustum, fitViewerCamera, perspectiveWorldUnitsPerPixel } from './framing'
import { loadViewerModel } from './modelLoader'
import { formatViewerCount } from './metadata'
import { cancelViewerPointers, createViewerPointerTracker, type ViewerPointerTracker } from './pointerTracker'
import { applyViewerRenderMode } from './renderMode'
import { createViewerCanvasConfig } from './canvasConfig'
import {
  createViewerHighlightGeometry,
  createViewerSurfaceIndexAsync,
  disableViewerModelRaycasts,
  type ViewerSurfaceHit,
  type ViewerSurfaceIndex,
} from './surfaceSelection'
import { runViewerSurfaceAnalysis, selectViewerSurface } from './viewerLifecycle'
import { toViewerSurfaceModelPoint } from './surfacePointer'
import { createViewerOrbitControlsConfig, usePrefersReducedMotion, viewerOrbitControlsEnabled } from './viewerControls'
import './viewer.css'
import type { Point2, SurfaceFrame } from '../core'
import type {
  ViewerCameraMode,
  ViewerLoadProgress,
  ViewerModelMetadata,
  ViewerProps,
  ViewerRenderMode,
  ViewerSurfaceInteractionMode,
  ViewerSurfacePointerEvent,
  ViewerSurfacePointerBox,
  ViewerSurfacePointerPhase,
  ViewerSurfaceSelectEvent,
} from './types'
import type { LoadedViewerModel } from './internalTypes'

// A full panel footprint is larger than this. Keeping sub-square-metre
// photogrammetry shards visible but out of the interactive index prevents a
// noisy survey mesh from publishing tens of thousands of unusable patches.
const MINIMUM_DESIGN_SURFACE_AREA_M2 = 1

interface ViewerModelState {
  readonly loaded: LoadedViewerModel
  /** The model and its design-surface index are published atomically. */
  readonly index: ViewerSurfaceIndex | null
  readonly frame: ReturnType<typeof computeViewerFrame>
  /** Number of placement-ready surfaces published with the model. */
  readonly surfaceCount: number
}

interface ViewerSceneProps {
  readonly model: ViewerModelState
  readonly progress: ViewerLoadProgress | null
  readonly cameraMode: ViewerCameraMode
  readonly renderMode: ViewerRenderMode
  readonly surfaceInteractionMode: ViewerSurfaceInteractionMode
  readonly surfaceGestureActive: boolean
  readonly showGrid: boolean
  readonly sceneContent: ReactNode
  readonly shadows: boolean
  readonly selected: readonly ViewerSurfaceHit[]
  readonly onSurfaceHit: (hit: ViewerSurfaceHit, shiftKey: boolean) => void
  readonly onSurfacePointer: (event: ViewerSurfacePointerEvent) => void
  readonly onSurfaceMiss: () => void
  readonly onCameraMetrics: (metrics: ViewerCameraMetrics) => void
}

interface ViewerCameraMetrics {
  readonly northAngleDeg: number
  readonly scaleLengthM: number
  readonly scalePixels: number
}

const viewerStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minHeight: 320,
  overflow: 'hidden',
  background: '#edf1f0',
  borderRadius: 12,
  isolation: 'isolate',
}

const overlayStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 2,
  pointerEvents: 'none',
  color: '#253735',
  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
  fontSize: 12,
}

function detectWebGL(): boolean {
  if (typeof document === 'undefined') return true
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

function isViewerLoadActive(active: boolean, signal: AbortSignal): boolean {
  return active && !signal.aborted
}

function formatEta(progress: ViewerLoadProgress): string {
  if (progress.etaMs === undefined || !Number.isFinite(progress.etaMs)) return 'Preparing…'
  const seconds = Math.max(1, Math.ceil(progress.etaMs / 1000))
  return `About ${String(seconds)}s remaining`
}

function progressLabel(progress: ViewerLoadProgress): string {
  switch (progress.phase) {
    case 'reading': return 'Reading model files'
    case 'parsing': return 'Parsing geometry'
    case 'materials': return 'Preparing materials'
    case 'textures': return 'Loading textures'
    case 'finalising': return 'Fitting site to view'
    case 'indexing': return 'Finding design surfaces'
    case 'describing': return 'Preparing design surfaces'
    case 'complete': return 'Model ready'
    default: return 'Loading model'
  }
}

function ModelStatus({ progress, error }: { progress: ViewerLoadProgress | null; error: Error | null }): ReactNode {
  if (error !== null) {
    return (
      <div role="alert" style={{ ...overlayStyle, inset: '50% auto auto 50%', transform: 'translate(-50%, -50%)', width: 'min(420px, calc(100% - 32px))', padding: 20, borderRadius: 12, background: 'rgba(255,250,249,.96)', boxShadow: '0 12px 40px rgba(20,40,38,.2)', pointerEvents: 'auto' }}>
        <strong style={{ display: 'block', marginBottom: 6 }}>Couldn’t load this site model</strong>
        <span style={{ display: 'block', lineHeight: 1.5 }}>{error.message}</span>
      </div>
    )
  }
  if (progress === null || progress.progress >= 1) return null
  return (
    <div role="status" aria-live="polite" style={{ ...overlayStyle, inset: '50% auto auto 50%', transform: 'translate(-50%, -50%)', width: 'min(360px, calc(100% - 32px))', padding: 18, borderRadius: 12, background: 'rgba(255,255,255,.94)', boxShadow: '0 12px 40px rgba(20,40,38,.16)' }}>
      <strong style={{ display: 'block', marginBottom: 8 }}>{progressLabel(progress)}</strong>
      <div style={{ height: 5, overflow: 'hidden', borderRadius: 99, background: '#d9e3e0' }}>
        <div style={{ height: '100%', width: `${String(Math.round(progress.progress * 100))}%`, borderRadius: 99, background: '#1d7069', transition: 'width .2s ease' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 8, color: '#5d716d' }}>
        <span>{Math.round(progress.progress * 100)}%</span>
        <span>{formatEta(progress)}</span>
      </div>
    </div>
  )
}

function MetadataOverlay({ metadata, surfaceCount }: { metadata: ViewerModelMetadata; surfaceCount: number }): ReactNode {
  // OBJ source counts are stable across render backends. Rendered BufferGeometry
  // counts can legitimately differ when a loader expands UV or normal seams,
  // so prefer the parser-owned source measurements for user-facing survey
  // identity and automated acceptance evidence.
  const vertexCount = metadata.sourceVertexCount ?? metadata.vertexCount
  const polygonCount = metadata.sourcePolygonCount ?? metadata.polygonCount
  return (
    <details open style={{ ...overlayStyle, top: 12, left: 12, maxWidth: 220, pointerEvents: 'auto' }}>
      <summary style={{ cursor: 'pointer', padding: '6px 9px', borderRadius: 8, background: 'rgba(255,255,255,.86)', boxShadow: '0 2px 12px rgba(20,40,38,.08)' }}>
        {metadata.isDemo ? 'Demo survey site' : metadata.name}
      </summary>
      <div style={{ marginTop: 5, padding: '8px 10px', borderRadius: 8, background: 'rgba(255,255,255,.92)', boxShadow: '0 2px 12px rgba(20,40,38,.08)', lineHeight: 1.55 }}>
        <div>{formatViewerCount(vertexCount)} vertices</div>
        <div>{formatViewerCount(polygonCount)} polygons</div>
        <div>{formatViewerCount(metadata.meshCount)} meshes</div>
        <div>{formatViewerCount(surfaceCount)} design surfaces</div>
        <div>{metadata.boundingBox.size.x.toFixed(1)} × {metadata.boundingBox.size.z.toFixed(1)} m</div>
      </div>
    </details>
  )
}

function Highlight({ hit, targetParent }: { hit: ViewerSurfaceHit; targetParent?: THREE.Object3D }): ReactNode {
  const geometry = useMemo(() => createViewerHighlightGeometry(hit.mesh, hit.selection, targetParent), [hit, targetParent])
  useEffect(() => {
    return () => {
      geometry.dispose()
    }
  }, [geometry])
  return (
    <mesh geometry={geometry} renderOrder={10}>
      <meshBasicMaterial color="#2e9cff" transparent opacity={0.34} depthWrite={false} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-1} />
    </mesh>
  )
}

function chooseScaleLength(rawLengthM: number): number {
  if (!Number.isFinite(rawLengthM) || rawLengthM <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rawLengthM))
  const unit = rawLengthM / magnitude
  const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10
  return step * magnitude
}

function controlsTargetOrFallback(controls: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  if (typeof controls !== 'object' || controls === null || !('target' in controls)) return fallback
  const candidate = controls.target
  return candidate instanceof THREE.Vector3 ? candidate : fallback
}

interface ViewerOrbitControlsHandle {
  enabled: boolean
}

function viewerOrbitControlsHandle(value: unknown): ViewerOrbitControlsHandle | null {
  if (typeof value !== 'object' || value === null || !('enabled' in value)) return null
  const enabled = value.enabled
  return typeof enabled === 'boolean' ? value as ViewerOrbitControlsHandle : null
}

interface PointerCaptureTarget {
  readonly setPointerCapture: (pointerId: number) => void
  readonly releasePointerCapture?: (pointerId: number) => void
}

interface NativeSurfaceIntersection {
  readonly hit: ViewerSurfaceHit
}

interface NativeSurfacePointer {
  readonly surfaceId: string
  readonly frame: SurfaceFrame
  readonly startX: number
  readonly startY: number
}

function pointerCaptureTarget(value: EventTarget | null): PointerCaptureTarget | null {
  if (typeof value !== 'object' || value === null || !('setPointerCapture' in value) || typeof value.setPointerCapture !== 'function') return null
  return value as PointerCaptureTarget
}

function captureNativePointer(native: PointerEvent): PointerCaptureTarget | null {
  const target = pointerCaptureTarget(native.currentTarget ?? native.target)
  if (target === null) return null
  try {
    target.setPointerCapture(native.pointerId)
    return target
  } catch {
    // A browser can reject capture when the Canvas has already been removed.
    return null
  }
}

function releaseNativePointer(target: PointerCaptureTarget | null, pointerId: number): void {
  if (target?.releasePointerCapture === undefined) return
  try {
    target.releasePointerCapture(pointerId)
  } catch {
    // Capture may already have been released by a browser cancellation path.
  }
}

function CameraMetrics({ frame, target, onChange }: { frame: ReturnType<typeof computeViewerFrame>; target: THREE.Vector3; onChange: (metrics: ViewerCameraMetrics) => void }): null {
  const camera = useThree((state) => state.camera)
  const viewport = useThree((state) => state.size)
  const controls = useThree((state) => state.controls)
  const last = useRef<ViewerCameraMetrics | null>(null)
  useFrame(() => {
    const viewportHeight = Math.max(1, viewport.height)
    const controlsTarget = controlsTargetOrFallback(controls, target)
    const normalisedPerPixel = camera instanceof THREE.OrthographicCamera
      ? Math.abs(camera.top - camera.bottom) / Math.max(camera.zoom, 0.001) / viewportHeight
      : perspectiveWorldUnitsPerPixel(camera, controlsTarget, viewportHeight)
    const metresPerPixel = normalisedPerPixel / Math.max(frame.scale, Number.EPSILON)
    const scaleLengthM = chooseScaleLength(metresPerPixel * 72)
    const scalePixels = scaleLengthM / Math.max(metresPerPixel, Number.EPSILON)
    const next: ViewerCameraMetrics = {
      northAngleDeg: cameraNorthAngleDegrees(camera),
      scaleLengthM,
      scalePixels: Math.min(132, Math.max(30, scalePixels)),
    }
    const previous = last.current
    if (previous === null || Math.abs(previous.northAngleDeg - next.northAngleDeg) > 0.2 || Math.abs(previous.scaleLengthM - next.scaleLengthM) > Number.EPSILON || Math.abs(previous.scalePixels - next.scalePixels) > 0.5) {
      last.current = next
      onChange(next)
    }
  })
  return null
}

function ViewerScene({ model, progress, cameraMode, renderMode, surfaceInteractionMode, surfaceGestureActive, showGrid, sceneContent, shadows, selected, onSurfaceHit, onSurfacePointer, onSurfaceMiss, onCameraMetrics }: ViewerSceneProps): ReactNode {
  const normalised = useMemo(() => ({
    position: model.frame.center.clone().multiplyScalar(-model.frame.scale),
    scale: model.frame.scale,
  }), [model.frame])
  const normalisedFrame = useMemo(() => ({
    ...model.frame,
    center: new THREE.Vector3(),
    size: model.frame.size.clone().multiplyScalar(model.frame.scale),
    radius: model.frame.radius * model.frame.scale,
  }), [model.frame])
  const viewport = useThree((state) => state.size)
  const invalidate = useThree((state) => state.invalidate)
  const controls = useThree((state) => state.controls)
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)
  const aspect = viewport.width > 0 && viewport.height > 0 ? viewport.width / viewport.height : 1
  const fit = useMemo(() => fitViewerCamera(normalisedFrame, aspect, cameraMode), [aspect, cameraMode, normalisedFrame])
  const orthographicFrustum = useMemo(() => createViewerOrthographicFrustum(fit.orthographicSize, aspect), [aspect, fit.orthographicSize])
  const gridY = -normalisedFrame.size.y / 2 - 0.025
  const gridExtent = Math.max(normalisedFrame.size.x, normalisedFrame.size.z, 12) * 1.6
  const cameraPosition: [number, number, number] = [fit.position.x, fit.position.y, fit.position.z]
  const cameraTarget: [number, number, number] = [fit.target.x, fit.target.y, fit.target.z]
  const prefersReducedMotion = usePrefersReducedMotion()
  const orbitControlsConfig = createViewerOrbitControlsConfig(prefersReducedMotion)
  const pointerTrackerRef = useRef<ViewerPointerTracker>(createViewerPointerTracker())
  const pointerCaptureRef = useRef<Map<number, PointerCaptureTarget>>(new Map())
  const activeSurfacePointersRef = useRef<Set<number>>(new Set())
  const nativeSurfacePointersRef = useRef<Map<number, NativeSurfacePointer>>(new Map())
  const orbitControlsRef = useRef<OrbitControlsObject | null>(null)
  const pointerRaycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster())
  const [surfacePointerActive, setSurfacePointerActive] = useState(false)
  const orbitControlsEnabled = viewerOrbitControlsEnabled(surfaceInteractionMode, surfaceGestureActive || surfacePointerActive)
  // OrbitControls receives events from the renderer's actual canvas. Attach
  // capture arbitration there so it runs before the controls' host listener,
  // regardless of which R3F event source a Canvas version selects.
  const pointerEventTarget = gl.domElement

  const syncOrbitControlsEnabled = useCallback((enabled: boolean): void => {
    const handle = orbitControlsRef.current ?? viewerOrbitControlsHandle(controls)
    if (handle !== null) handle.enabled = enabled
  }, [controls])

  // React state keeps the declarative OrbitControls prop in sync, while this
  // imperative write closes the native-listener race on pointerdown. drei's
  // controls are attached to the same Canvas element as R3F's pointer manager.
  useEffect(() => {
    syncOrbitControlsEnabled(orbitControlsEnabled)
  }, [orbitControlsEnabled, syncOrbitControlsEnabled])

  const beginSurfacePointer = useCallback((pointerId: number): void => {
    activeSurfacePointersRef.current.add(pointerId)
    setSurfacePointerActive(true)
    syncOrbitControlsEnabled(false)
  }, [syncOrbitControlsEnabled])

  const finishSurfacePointer = useCallback((pointerId: number): void => {
    if (!activeSurfacePointersRef.current.delete(pointerId)) return
    const remaining = activeSurfacePointersRef.current.size > 0
    setSurfacePointerActive(remaining)
    syncOrbitControlsEnabled(viewerOrbitControlsEnabled(surfaceInteractionMode, surfaceGestureActive || remaining))
  }, [surfaceGestureActive, surfaceInteractionMode, syncOrbitControlsEnabled])

  const clearSurfacePointers = useCallback((): void => {
    nativeSurfacePointersRef.current.clear()
    if (activeSurfacePointersRef.current.size === 0) {
      syncOrbitControlsEnabled(viewerOrbitControlsEnabled(surfaceInteractionMode, surfaceGestureActive))
      return
    }
    activeSurfacePointersRef.current.clear()
    setSurfacePointerActive(false)
    syncOrbitControlsEnabled(viewerOrbitControlsEnabled(surfaceInteractionMode, surfaceGestureActive))
  }, [surfaceGestureActive, surfaceInteractionMode, syncOrbitControlsEnabled])

  // Surface hits are supplied by the packed model picker proxy below. Disable
  // each imported mesh's default triangle walk while it is mounted so a large
  // OBJ cannot turn every hover into an O(faceCount) R3F raycast.
  useEffect(() => disableViewerModelRaycasts(model.loaded.object), [model.loaded.object])

  const inverseNormalisation = useMemo(() => new THREE.Matrix4()
    .compose(normalised.position, new THREE.Quaternion(), new THREE.Vector3(normalised.scale, normalised.scale, normalised.scale))
    .invert(), [normalised.position, normalised.scale])

  const surfacePicker = useMemo(() => {
    const picker = new THREE.Object3D()
    if (model.index === null) return picker
    picker.raycast = (raycaster: THREE.Raycaster, intersections: THREE.Intersection[]): void => {
      const rawOrigin = raycaster.ray.origin.clone().applyMatrix4(inverseNormalisation)
      const rawDirection = raycaster.ray.direction.clone().transformDirection(inverseNormalisation).normalize()
      const hit = model.index?.raycastRawRay(new THREE.Ray(rawOrigin, rawDirection))
      if (hit === undefined || hit === null) return
      const displayPoint = hit.point.clone().applyMatrix4(inverseNormalisation.clone().invert())
      const distance = displayPoint.distanceTo(raycaster.ray.origin)
      if (!Number.isFinite(distance)) return
      intersections.push({ distance, point: displayPoint, object: hit.mesh, faceIndex: hit.faceIndex })
    }
    return picker
  }, [inverseNormalisation, model.index])

  /**
   * OrbitControls listens natively on the Canvas host. A pointerdown capture
   * listener arbitrates surface drags before that listener runs, while still
   * allowing R3F's bubble handler to publish the actual selection event.
   */
  const nativeDisplayRay = useCallback((clientX: number, clientY: number): THREE.Ray | null => {
    const bounds = pointerEventTarget.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null
    const pointer = new THREE.Vector2(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    )
    const raycaster = pointerRaycasterRef.current
    raycaster.setFromCamera(pointer, camera)
    return raycaster.ray.clone()
  }, [camera, pointerEventTarget])

  const nativeRawRay = useCallback((clientX: number, clientY: number): THREE.Ray | null => {
    const displayRay = nativeDisplayRay(clientX, clientY)
    if (displayRay === null) return null
    return new THREE.Ray(
      displayRay.origin.clone().applyMatrix4(inverseNormalisation),
      displayRay.direction.clone().transformDirection(inverseNormalisation).normalize(),
    )
  }, [inverseNormalisation, nativeDisplayRay])

  const nativeSurfaceIntersection = useCallback((clientX: number, clientY: number): NativeSurfaceIntersection | null => {
    if (model.index === null) return null
    const bounds = pointerEventTarget.getBoundingClientRect()
    const displayRay = nativeDisplayRay(clientX, clientY)
    if (bounds.width <= 0 || bounds.height <= 0 || displayRay === null) return null
    const raycaster = pointerRaycasterRef.current
    raycaster.ray.copy(displayRay)
    const intersections: THREE.Intersection[] = []
    surfacePicker.raycast(raycaster, intersections)
    const intersection = intersections[0]
    if (intersection === undefined) return null
    const point = toViewerSurfaceModelPoint(intersection.point, normalised.position, normalised.scale)
    const hit = selectViewerSurface(model.index, {
      object: intersection.object,
      faceIndex: intersection.faceIndex ?? undefined,
      point,
    })
    return hit === null ? null : { hit }
  }, [model.index, nativeDisplayRay, normalised.position, normalised.scale, pointerEventTarget, surfacePicker])

  /** Project an arbitrary screen point onto the surface plane captured at
   * pointerdown. This preserves the screen rectangle's perspective shear even
   * when a corner lies outside the indexed mesh or over another model object. */
  const nativeSurfacePlanePoint = useCallback((clientX: number, clientY: number, frame: SurfaceFrame): Point2 | null => {
    const ray = nativeRawRay(clientX, clientY)
    if (ray === null) return null
    const origin = new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)
    const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z)
    const tangentX = new THREE.Vector3(frame.tangentX.x, frame.tangentX.y, frame.tangentX.z)
    const tangentY = new THREE.Vector3(frame.tangentY.x, frame.tangentY.y, frame.tangentY.z)
    if (normal.lengthSq() <= Number.EPSILON || tangentX.lengthSq() <= Number.EPSILON || tangentY.lengthSq() <= Number.EPSILON) return null
    normal.normalize(); tangentX.normalize(); tangentY.normalize()
    const denominator = ray.direction.dot(normal)
    if (Math.abs(denominator) <= 1e-8) return null
    const distance = origin.clone().sub(ray.origin).dot(normal) / denominator
    if (!Number.isFinite(distance) || distance < -1e-6) return null
    const point = ray.origin.clone().addScaledVector(ray.direction, Math.max(0, distance)).sub(origin)
    return { x: point.dot(tangentX), y: point.dot(tangentY) }
  }, [nativeRawRay])

  const nativeSurfaceBox = useCallback((pointer: NativeSurfacePointer, native: PointerEvent): ViewerSurfacePointerBox | undefined => {
    const minX = Math.min(pointer.startX, native.clientX)
    const maxX = Math.max(pointer.startX, native.clientX)
    const minY = Math.min(pointer.startY, native.clientY)
    const maxY = Math.max(pointer.startY, native.clientY)
    const screenCorners: readonly [number, number][] = [
      [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY],
    ]
    const corners: Point2[] = []
    for (const [x, y] of screenCorners) {
      const point = nativeSurfacePlanePoint(x, y, pointer.frame)
      if (point === null) return undefined
      corners.push(point)
    }
    return { surfaceId: pointer.surfaceId, corners }
  }, [nativeSurfacePlanePoint])

  const nativePointerHitsPanel = useCallback((event: PointerEvent): boolean => {
    const displayRay = nativeDisplayRay(event.clientX, event.clientY)
    if (displayRay === null) return false
    const raycaster = pointerRaycasterRef.current
    raycaster.ray.copy(displayRay)
    const panelLayer = scene.getObjectByName('pv-panel-layer')
    if (panelLayer === undefined) return false
    const panelMeshes: THREE.Object3D[] = []
    panelLayer.traverse((child) => {
      if (child instanceof THREE.Mesh && typeof child.raycast === 'function') panelMeshes.push(child)
    })
    // Raycast only the panel meshes. The scene also contains lights and
    // Object3D helpers without a raycast method; passing those to
    // Raycaster.intersectObjects throws before the surface arbitration can
    // run. The first panel intersection is the nearest visible hit.
    const intersections = raycaster.intersectObjects(panelMeshes, false)
    return intersections.length > 0
  }, [nativeDisplayRay, scene])

  useEffect(() => {
    if (surfaceInteractionMode !== 'select' || model.index === null) return
    const handleNativePointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || event.pointerType === 'touch') return
      const startsOnPanel = nativePointerHitsPanel(event)
      if (startsOnPanel) {
        return
      }
      const intersection = nativeSurfaceIntersection(event.clientX, event.clientY)
      if (intersection === null) {
        return
      }
      // This runs in the DOM capture phase, before both R3F's synthetic
      // pointerdown and OrbitControls' native bubble listener.
      pointerTrackerRef.current.begin(event.pointerId)
      const capture = captureNativePointer(event)
      if (capture !== null) pointerCaptureRef.current.set(event.pointerId, capture)
      nativeSurfacePointersRef.current.set(event.pointerId, {
        surfaceId: intersection.hit.selection.surface.id,
        frame: intersection.hit.selection.surface.frame,
        startX: event.clientX,
        startY: event.clientY,
      })
      beginSurfacePointer(event.pointerId)
      onSurfacePointer({
        phase: 'down',
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        button: event.button,
        buttons: event.buttons,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        selection: intersection.hit.selection,
      })
      onSurfaceHit(intersection.hit, event.shiftKey)
    }
    const handleNativePointerMove = (event: PointerEvent): void => {
      if (!nativeSurfacePointersRef.current.has(event.pointerId)) return
      const intersection = nativeSurfaceIntersection(event.clientX, event.clientY)
      onSurfacePointer({
        phase: 'move',
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        button: event.button,
        buttons: event.buttons,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        selection: intersection?.hit.selection ?? null,
      })
    }
    pointerEventTarget.addEventListener('pointerdown', handleNativePointerDown, true)
    // Pointer capture can move the stream outside the renderer element. Keep
    // one authoritative move listener at the window level so a box gesture
    // cannot silently stop updating when it crosses the canvas edge.
    window.addEventListener('pointermove', handleNativePointerMove, true)
    return () => {
      pointerEventTarget.removeEventListener('pointerdown', handleNativePointerDown, true)
      window.removeEventListener('pointermove', handleNativePointerMove, true)
    }
  }, [beginSurfacePointer, model.index, nativePointerHitsPanel, nativeSurfaceIntersection, onSurfaceHit, onSurfacePointer, pointerEventTarget, surfaceInteractionMode])

  useEffect(() => {
    applyViewerRenderMode(model.loaded.object, renderMode)
  }, [model.loaded.object, renderMode])

  // Progress and model state are updated outside the R3F render loop. Keep a
  // demand-rendered canvas visually current without forcing a continuous
  // software-WebGL frame while large geometry is being analysed.
  useEffect(() => {
    invalidate()
  }, [cameraMode, invalidate, model, progress, renderMode, sceneContent, selected, shadows, showGrid])

  const notifyNativePointerTermination = useCallback((phase: 'up' | 'cancel', native: PointerEvent): void => {
    const nativePointer = nativeSurfacePointersRef.current.get(native.pointerId)
    nativeSurfacePointersRef.current.delete(native.pointerId)
    if (!pointerTrackerRef.current.finish(native.pointerId)) return
    finishSurfacePointer(native.pointerId)
    const capture = pointerCaptureRef.current.get(native.pointerId) ?? null
    pointerCaptureRef.current.delete(native.pointerId)
    releaseNativePointer(capture, native.pointerId)
    const intersection = nativePointer !== undefined && phase === 'up' ? nativeSurfaceIntersection(native.clientX, native.clientY) : null
    const selectionBox = nativePointer !== undefined && phase === 'up'
      ? nativeSurfaceBox(nativePointer, native)
      : undefined
    onSurfacePointer({
      phase,
      pointerId: native.pointerId,
      pointerType: native.pointerType,
      button: native.button,
      buttons: native.buttons,
      shiftKey: native.shiftKey,
      altKey: native.altKey,
      ctrlKey: native.ctrlKey,
      metaKey: native.metaKey,
      selection: intersection?.hit.selection ?? null,
      ...(selectionBox === undefined ? {} : { surfaceBox: selectionBox }),
    })
  }, [finishSurfacePointer, nativeSurfaceBox, nativeSurfaceIntersection, onSurfacePointer])

  const cancelTrackedPointers = useCallback((): void => {
    cancelViewerPointers(pointerTrackerRef.current, (pointerId) => {
      nativeSurfacePointersRef.current.delete(pointerId)
      finishSurfacePointer(pointerId)
      const capture = pointerCaptureRef.current.get(pointerId) ?? null
      pointerCaptureRef.current.delete(pointerId)
      releaseNativePointer(capture, pointerId)
      onSurfacePointer({ phase: 'cancel', pointerId, button: -1, buttons: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, selection: null })
    })
    clearSurfacePointers()
  }, [clearSurfacePointers, finishSurfacePointer, onSurfacePointer])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleWindowPointerUp = (event: PointerEvent): void => { notifyNativePointerTermination('up', event) }
    const handleWindowPointerCancel = (event: PointerEvent): void => { notifyNativePointerTermination('cancel', event) }
    const handleWindowLostCapture = (event: PointerEvent): void => { notifyNativePointerTermination('cancel', event) }
    const handleWindowBlur = (): void => { cancelTrackedPointers() }
    const handleVisibilityChange = (): void => { cancelTrackedPointers() }
    window.addEventListener('pointerup', handleWindowPointerUp)
    window.addEventListener('pointercancel', handleWindowPointerCancel)
    window.addEventListener('lostpointercapture', handleWindowLostCapture)
    window.addEventListener('blur', handleWindowBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('pointerup', handleWindowPointerUp)
      window.removeEventListener('pointercancel', handleWindowPointerCancel)
      window.removeEventListener('lostpointercapture', handleWindowLostCapture)
      window.removeEventListener('blur', handleWindowBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [cancelTrackedPointers, notifyNativePointerTermination])

  const notifySurfacePointer = useCallback((phase: ViewerSurfacePointerPhase, event: ThreeEvent<PointerEvent>): ViewerSurfaceHit | null => {
    const point = toViewerSurfaceModelPoint(event.point, normalised.position, normalised.scale)
    const hit = selectViewerSurface(model.index, { object: event.object, faceIndex: event.faceIndex ?? undefined, point })
    const native = event.nativeEvent
    onSurfacePointer({
      phase,
      pointerId: native.pointerId,
      pointerType: native.pointerType,
      button: native.button,
      buttons: native.buttons,
      shiftKey: native.shiftKey,
      altKey: native.altKey,
      ctrlKey: native.ctrlKey,
      metaKey: native.metaKey,
      selection: hit?.selection ?? null,
    })
    return hit
  }, [model.index, normalised.position, normalised.scale, onSurfacePointer])

  const handlePointerMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (nativeSurfacePointersRef.current.has(event.nativeEvent.pointerId)) return
    notifySurfacePointer('move', event)
  }, [notifySurfacePointer])

  const handlePointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    const native = event.nativeEvent
    if (nativeSurfacePointersRef.current.has(native.pointerId)) return
    pointerTrackerRef.current.begin(native.pointerId)
    const capture = captureNativePointer(native)
    if (capture !== null) pointerCaptureRef.current.set(native.pointerId, capture)
    const hit = notifySurfacePointer('down', event)
    if (hit !== null) {
      // Touch pointers remain available for one-finger OrbitControls camera
      // navigation. Mouse/pen primary drags over a surface are the explicit
      // select-box gesture and must stop the native controls listener before
      // it can rotate the camera.
      if (surfaceInteractionMode === 'select' && native.button === 0 && native.pointerType !== 'touch') {
        beginSurfacePointer(native.pointerId)
        native.stopImmediatePropagation()
      }
      onSurfaceHit(hit, native.shiftKey)
    }
  }, [beginSurfacePointer, notifySurfacePointer, onSurfaceHit, surfaceInteractionMode])

  const handlePointerUp = useCallback((event: ThreeEvent<PointerEvent>) => {
    const native = event.nativeEvent
    if (nativeSurfacePointersRef.current.has(native.pointerId)) return
    if (!pointerTrackerRef.current.finish(native.pointerId)) return
    finishSurfacePointer(native.pointerId)
    const capture = pointerCaptureRef.current.get(native.pointerId) ?? null
    pointerCaptureRef.current.delete(native.pointerId)
    releaseNativePointer(capture, native.pointerId)
    notifySurfacePointer('up', event)
  }, [finishSurfacePointer, notifySurfacePointer])

  const handlePointerCancel = useCallback((event: ThreeEvent<PointerEvent>) => {
    const native = event.nativeEvent
    if (nativeSurfacePointersRef.current.has(native.pointerId)) return
    if (!pointerTrackerRef.current.finish(native.pointerId)) return
    finishSurfacePointer(native.pointerId)
    const capture = pointerCaptureRef.current.get(native.pointerId) ?? null
    pointerCaptureRef.current.delete(native.pointerId)
    releaseNativePointer(capture, native.pointerId)
    notifySurfacePointer('cancel', event)
  }, [finishSurfacePointer, notifySurfacePointer])

  return (
    <>
      {cameraMode === 'orthographic'
        ? <OrthographicCamera key="orthographic" makeDefault position={cameraPosition} near={fit.near} far={fit.far} left={orthographicFrustum.left} right={orthographicFrustum.right} top={orthographicFrustum.top} bottom={orthographicFrustum.bottom} zoom={1} />
        : <PerspectiveCamera key="perspective" makeDefault position={cameraPosition} near={fit.near} far={fit.far} fov={42} />}
      <OrbitControls
        ref={orbitControlsRef}
        key={`controls-${cameraMode}`}
        makeDefault
        enabled={orbitControlsEnabled}
        target={cameraTarget}
        enableDamping={orbitControlsConfig.enableDamping}
        dampingFactor={orbitControlsConfig.dampingFactor}
        enablePan
        enableZoom
        minDistance={Math.max(0.5, normalisedFrame.radius * 0.18)}
        maxDistance={Math.max(20, normalisedFrame.radius * 12)}
        minZoom={0.35}
        maxZoom={12}
        minPolarAngle={cameraMode === 'orthographic' ? 0 : 0.15}
        maxPolarAngle={cameraMode === 'orthographic' ? 0.01 : Math.PI * 0.49}
        touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
        onStart={() => { invalidate() }}
        onChange={() => { invalidate() }}
        onEnd={() => { invalidate() }}
      />
      <ambientLight intensity={1.55} />
      <directionalLight position={[6, 12, 8]} intensity={2.2} castShadow={shadows} />
      <color attach="background" args={['#edf1f0']} />
      <group position={normalised.position.toArray()} scale={normalised.scale} onPointerMove={handlePointerMove} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerCancel={handlePointerCancel} onPointerMissed={onSurfaceMiss}>
        {model.index !== null && <primitive object={surfacePicker} />}
        <primitive object={model.loaded.object} />
        {sceneContent}
        {model.index !== null && selected.map((hit) => <Highlight key={hit.selection.surface.id} hit={hit} targetParent={model.loaded.object.parent ?? undefined} />)}
      </group>
      {cameraMode === 'orthographic' && showGrid && <gridHelper args={[gridExtent, 24, '#9ab0aa', '#c5d2cf']} position={[0, gridY, 0]} />}
      <CameraMetrics frame={model.frame} target={fit.target} onChange={onCameraMetrics} />
    </>
  )
}

function CompassOverlay({ northAngleDeg }: { northAngleDeg: number }): ReactNode {
  return <div aria-label="Compass: north" style={{ ...overlayStyle, top: 14, right: 14, width: 42, height: 42, display: 'grid', placeItems: 'center', border: '1px solid rgba(55,86,81,.25)', borderRadius: '50%', background: 'rgba(255,255,255,.82)', fontWeight: 700, transform: `rotate(${String(northAngleDeg)}deg)` }}>N</div>
}

function ScaleOverlay({ metrics }: { metrics: ViewerCameraMetrics | null }): ReactNode {
  if (metrics === null) return null
  return <div aria-label={`Scale indicator: ${String(metrics.scaleLengthM)} metres`} style={{ ...overlayStyle, bottom: 14, right: 14, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 7, background: 'rgba(255,255,255,.82)' }}><span style={{ display: 'inline-block', width: metrics.scalePixels, height: 2, background: '#365650' }} />{metrics.scaleLengthM} m</div>
}

function ViewModeButtons({ cameraMode, renderMode, onCameraModeChange, onRenderModeChange }: { cameraMode: ViewerCameraMode; renderMode: ViewerRenderMode; onCameraModeChange: (mode: ViewerCameraMode) => void; onRenderModeChange: (mode: ViewerRenderMode) => void }): ReactNode {
  const buttonStyle: CSSProperties = { border: '1px solid rgba(55,86,81,.22)', borderRadius: 7, padding: '6px 8px', background: 'rgba(255,255,255,.9)', color: '#2b4843', cursor: 'pointer', font: 'inherit' }
  return <div role="toolbar" aria-label="Viewer display controls" style={{ ...overlayStyle, top: 14, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 5, pointerEvents: 'auto' }}>
    <button type="button" className="viewer-control-button" style={{ ...buttonStyle, fontWeight: cameraMode === 'perspective' ? 700 : 400 }} aria-pressed={cameraMode === 'perspective'} onClick={() => { onCameraModeChange('perspective') }}>3D</button>
    <button type="button" className="viewer-control-button" style={{ ...buttonStyle, fontWeight: cameraMode === 'orthographic' ? 700 : 400 }} aria-pressed={cameraMode === 'orthographic'} onClick={() => { onCameraModeChange('orthographic') }}>Top</button>
    <button type="button" className="viewer-control-button" style={{ ...buttonStyle, fontWeight: renderMode === 'texture' ? 700 : 400 }} aria-pressed={renderMode === 'texture'} onClick={() => { onRenderModeChange('texture') }}>Texture</button>
    <button type="button" className="viewer-control-button" style={{ ...buttonStyle, fontWeight: renderMode === 'wireframe' ? 700 : 400 }} aria-pressed={renderMode === 'wireframe'} onClick={() => { onRenderModeChange('wireframe') }}>Wire</button>
  </div>
}

/** Interactive, resource-safe OBJ/MTL site viewer with demo content by default. */
export function Viewer(props: ViewerProps): ReactNode {
  const {
    source = null,
    cameraMode: controlledCameraMode,
    defaultCameraMode = 'perspective',
    onCameraModeChange,
    renderMode: controlledRenderMode,
    defaultRenderMode = 'texture',
    onRenderModeChange,
    showGrid = true,
    showCompass = true,
    showScale = true,
    sceneContent = null,
    children = null,
    onSurfacesChange,
    shadows = true,
    className,
    style,
    ariaLabel = 'PV Studio site viewer',
    onModelLoaded,
    onLoadProgress,
    onError,
    onSurfaceSelect,
    onSurfacePointer,
    surfaceInteractionMode = 'select',
    surfaceGestureActive = false,
  } = props
  const [internalCameraMode, setInternalCameraMode] = useState<ViewerCameraMode>(defaultCameraMode)
  const [internalRenderMode, setInternalRenderMode] = useState<ViewerRenderMode>(defaultRenderMode)
  const cameraMode = controlledCameraMode ?? internalCameraMode
  const renderMode = controlledRenderMode ?? internalRenderMode
  const [model, setModel] = useState<ViewerModelState | null>(null)
  const [progress, setProgress] = useState<ViewerLoadProgress | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [selected, setSelected] = useState<readonly ViewerSurfaceHit[]>([])
  const [cameraMetrics, setCameraMetrics] = useState<ViewerCameraMetrics | null>(null)
  const [webglAvailable] = useState(detectWebGL)
  const selectedRef = useRef<readonly ViewerSurfaceHit[]>([])
  const callbacksRef = useRef({ onModelLoaded, onLoadProgress, onError, onSurfaceSelect, onSurfacePointer, onSurfacesChange })
  useEffect(() => {
    callbacksRef.current = { onModelLoaded, onLoadProgress, onError, onSurfaceSelect, onSurfacePointer, onSurfacesChange }
  }, [onModelLoaded, onLoadProgress, onError, onSurfaceSelect, onSurfacePointer, onSurfacesChange])

  const resetViewerState = useCallback((nextProgress: ViewerLoadProgress | null): void => {
    setModel(null)
    selectedRef.current = []
    setSelected([])
    setCameraMetrics(null)
    setError(null)
    setProgress(nextProgress)
  }, [])

  useEffect(() => {
    let active = true
    let owned: LoadedViewerModel | undefined
    const controller = new AbortController()
    // The loader effect owns the previous model lifecycle, so clear stale state before the replacement resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    resetViewerState(source === null ? null : { progress: 0, itemsLoaded: 0, itemsTotal: 1, phase: 'reading' })
    callbacksRef.current.onSurfacesChange?.([])
    const reportSurfaceProgress = (phase: 'started' | 'indexed' | 'complete'): void => {
      const nextProgress = phase === 'complete' ? 1 : phase === 'indexed' ? 0.98 : 0.95
      const next: ViewerLoadProgress = {
        progress: nextProgress,
        itemsLoaded: nextProgress >= 1 ? 1 : 0,
        itemsTotal: 1,
        phase: phase === 'complete' ? 'complete' : phase === 'indexed' ? 'describing' : 'indexing',
      }
      setProgress(next)
      callbacksRef.current.onLoadProgress?.(next)
    }
    const publish = async (loaded: LoadedViewerModel): Promise<void> => {
      if (!active) {
        loaded.dispose()
        return
      }
      // Analyse before rendering. Uploading a photogrammetry scene containing
      // hundreds of thousands of textured faces can starve main-thread design
      // preparation on constrained GPUs. Publishing the object and surface
      // index together guarantees that a visible model is immediately usable.
      owned = loaded
      try {
        let publishedIndex: ViewerSurfaceIndex | undefined
        await runViewerSurfaceAnalysis({
          isActive: () => isViewerLoadActive(active, controller.signal),
          buildIndex: () => createViewerSurfaceIndexAsync(loaded.object, loaded.object.uuid, undefined, {
            signal: controller.signal,
            chunkSize: 2560,
            minimumSurfaceAreaM2: MINIMUM_DESIGN_SURFACE_AREA_M2,
            deferRaycastGrids: true,
          }),
          buildDescriptors: (index) => index.surfaceDescriptorsAsync({ signal: controller.signal, chunkSize: 2560 }),
          onReady: (index, surfaces) => {
            publishedIndex = index
            setModel({ loaded, index, frame: computeViewerFrameFromBounds(loaded.metadata.boundingBox), surfaceCount: surfaces.length })
            callbacksRef.current.onModelLoaded?.(loaded.metadata)
            callbacksRef.current.onSurfacesChange?.(surfaces)
          },
          onProgress: reportSurfaceProgress,
        })
        if (publishedIndex !== undefined && isViewerLoadActive(active, controller.signal)) {
          try {
            await publishedIndex.prepareRaycastGridsAsync({ signal: controller.signal, chunkSize: 2560 })
          } catch {
            // Acceleration is optional: the published packed index retains a
            // correct face-scan fallback if background grid preparation is
            // aborted or cannot complete on a constrained device.
          }
        }
      } catch (cause: unknown) {
        if (!isViewerLoadActive(active, controller.signal)) return
        // Surface analysis owns the parsed object until atomic publication.
        // Dispose it before surfacing the error so texture/material resources
        // cannot leak through a failed descriptor publication.
        if (owned === loaded) owned = undefined
        loaded.dispose()
        callbacksRef.current.onSurfacesChange?.([])
        throw cause
      }
    }
    if (source === null) {
      void publish(createDemoViewerModel()).catch((cause: unknown) => {
        if (!active || (cause instanceof DOMException && cause.name === 'AbortError')) return
        const nextError = cause instanceof Error ? cause : new Error(String(cause))
        setError(nextError)
        callbacksRef.current.onError?.(nextError)
      })
    } else {
      void loadViewerModel(source, { signal: controller.signal, onProgress: (next) => { if (active) { setProgress(next); callbacksRef.current.onLoadProgress?.(next) } } })
        .then(publish)
        .catch((cause: unknown) => {
          if (!active || (cause instanceof DOMException && cause.name === 'AbortError')) return
          const nextError = cause instanceof Error ? cause : new Error(String(cause))
          setError(nextError)
          callbacksRef.current.onError?.(nextError)
        })
    }
    return () => {
      active = false
      controller.abort()
      owned?.dispose()
    }
  }, [resetViewerState, source])

  const setCameraMode = useCallback((mode: ViewerCameraMode): void => {
    if (controlledCameraMode === undefined) setInternalCameraMode(mode)
    onCameraModeChange?.(mode)
  }, [controlledCameraMode, onCameraModeChange])
  const setRenderMode = useCallback((mode: ViewerRenderMode): void => {
    if (controlledRenderMode === undefined) setInternalRenderMode(mode)
    onRenderModeChange?.(mode)
  }, [controlledRenderMode, onRenderModeChange])
  const handleSurfaceHit = useCallback((hit: ViewerSurfaceHit, shiftKey: boolean): void => {
    const current = selectedRef.current
    const next = shiftKey
      ? current.some((entry) => entry.selection.surface.id === hit.selection.surface.id)
        ? current.filter((entry) => entry.selection.surface.id !== hit.selection.surface.id)
        : [...current, hit]
      : [hit]
    selectedRef.current = next
    setSelected(next)
    const event: ViewerSurfaceSelectEvent = { shiftKey, selectedSurfaceIds: next.map((entry) => entry.selection.surface.id) }
    callbacksRef.current.onSurfaceSelect?.(next.at(-1)?.selection ?? null, event)
  }, [])
  const clearSelection = useCallback((): void => {
    selectedRef.current = []
    setSelected([])
    callbacksRef.current.onSurfaceSelect?.(null, { shiftKey: false, selectedSurfaceIds: [] })
  }, [])
  const handleSurfacePointer = useCallback((event: ViewerSurfacePointerEvent): void => {
    callbacksRef.current.onSurfacePointer?.(event)
  }, [])

  const mergedStyle = { ...viewerStyle, ...style }
  if (!webglAvailable) {
    return <div className={`pv-viewer ${className ?? ''}`.trim()} style={mergedStyle} role="alert" aria-label="WebGL unavailable">WebGL is unavailable in this browser. Enable hardware acceleration to view the site model.</div>
  }
  return (
    <div className={`pv-viewer ${className ?? ''}`.trim()} style={mergedStyle} aria-label={ariaLabel} data-testid="pv-viewer" data-surface-count={model?.surfaceCount ?? 0}>
      <Canvas className="pv-viewer__canvas" {...createViewerCanvasConfig(typeof window === 'undefined' ? 1 : window.devicePixelRatio)} shadows={shadows} gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }} onPointerMissed={clearSelection}>
        {model !== null && <ViewerScene model={model} progress={progress} cameraMode={cameraMode} renderMode={renderMode} surfaceInteractionMode={surfaceInteractionMode} surfaceGestureActive={surfaceGestureActive} showGrid={showGrid} sceneContent={<>{sceneContent}{children}</>} shadows={shadows} selected={selected} onSurfaceHit={handleSurfaceHit} onSurfacePointer={handleSurfacePointer} onSurfaceMiss={clearSelection} onCameraMetrics={setCameraMetrics} />}
      </Canvas>
      {model !== null && <MetadataOverlay metadata={model.loaded.metadata} surfaceCount={model.surfaceCount} />}
      <ViewModeButtons cameraMode={cameraMode} renderMode={renderMode} onCameraModeChange={setCameraMode} onRenderModeChange={setRenderMode} />
      {showCompass && <CompassOverlay northAngleDeg={cameraMetrics?.northAngleDeg ?? 0} />}
      {showScale && model !== null && <ScaleOverlay metrics={cameraMetrics} />}
      <ModelStatus progress={progress} error={error} />
    </div>
  )
}

export default Viewer
