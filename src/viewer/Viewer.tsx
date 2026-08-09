import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
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
import type { ObjDocumentBounds } from './objParser'
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
import { viewerOrbitControlsEnabled } from './viewerControls'
import type {
  ViewerCameraMode,
  ViewerLoadProgress,
  ViewerModelMetadata,
  ViewerProps,
  ViewerRenderMode,
  ViewerSurfaceInteractionMode,
  ViewerSurfacePointerEvent,
  ViewerSurfacePointerPhase,
  ViewerSurfaceSelectEvent,
} from './types'
import type { LoadedViewerModel } from './internalTypes'

interface ViewerModelState {
  readonly loaded: LoadedViewerModel
  /** Surface analysis is published asynchronously after the model is visible. */
  readonly index: ViewerSurfaceIndex | null
  readonly frame: ReturnType<typeof computeViewerFrame>
}

interface ViewerSceneProps {
  readonly model: ViewerModelState
  readonly progress: ViewerLoadProgress | null
  readonly cameraMode: ViewerCameraMode
  readonly renderMode: ViewerRenderMode
  readonly surfaceInteractionMode: ViewerSurfaceInteractionMode
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

interface ViewerPreviewMesh extends THREE.Object3D {
  readonly geometry: THREE.BufferGeometry
  readonly material: THREE.Material | THREE.Material[]
}

interface ViewerPreviewMaterial extends THREE.Material {
  readonly map?: THREE.Texture | null
}

function isViewerPreviewMesh(child: THREE.Object3D): child is ViewerPreviewMesh {
  return child instanceof THREE.Mesh
}

function isViewerPreviewMaterial(material: THREE.Material): material is ViewerPreviewMaterial {
  return 'map' in material
}

function viewerPreviewMaterialList(material: ViewerPreviewMesh['material']): readonly THREE.Material[] {
  return Array.isArray(material) ? material : [material]
}

/**
 * Build metadata that is cheap enough for the first render. Geometry counts
 * and material references are available from the built object; only the
 * expensive per-vertex metadata pass is deferred by the loader.
 */
function createViewerPreviewMetadata(object: THREE.Group, frame: ReturnType<typeof computeViewerFrame>, name: string): ViewerModelMetadata {
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  let vertexCount = 0
  let polygonCount = 0
  let meshCount = 0
  object.traverse((child) => {
    if (!isViewerPreviewMesh(child)) return
    meshCount += 1
    const position = child.geometry.getAttribute('position')
    const index = child.geometry.getIndex()
    vertexCount += position.count
    polygonCount += Math.floor((index?.count ?? position.count) / 3)
    for (const material of viewerPreviewMaterialList(child.material)) {
      materials.add(material)
      if (isViewerPreviewMaterial(material) && material.map instanceof THREE.Texture) textures.add(material.map)
    }
  })
  const halfSize = frame.size.clone().multiplyScalar(0.5)
  const min = frame.center.clone().sub(halfSize)
  const max = frame.center.clone().add(halfSize)
  return {
    name,
    vertexCount,
    polygonCount,
    meshCount,
    materialCount: materials.size,
    textureCount: textures.size,
    boundingBox: {
      min: { x: min.x, y: min.y, z: min.z },
      max: { x: max.x, y: max.y, z: max.z },
      size: { x: frame.size.x, y: frame.size.y, z: frame.size.z },
    },
    isDemo: false,
  }
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

function MetadataOverlay({ metadata }: { metadata: ViewerModelMetadata }): ReactNode {
  return (
    <details open style={{ ...overlayStyle, top: 12, left: 12, maxWidth: 220, pointerEvents: 'auto' }}>
      <summary style={{ cursor: 'pointer', padding: '6px 9px', borderRadius: 8, background: 'rgba(255,255,255,.86)', boxShadow: '0 2px 12px rgba(20,40,38,.08)' }}>
        {metadata.isDemo ? 'Demo survey site' : metadata.name}
      </summary>
      <div style={{ marginTop: 5, padding: '8px 10px', borderRadius: 8, background: 'rgba(255,255,255,.92)', boxShadow: '0 2px 12px rgba(20,40,38,.08)', lineHeight: 1.55 }}>
        <div>{metadata.vertexCount.toLocaleString()} vertices</div>
        <div>{metadata.polygonCount.toLocaleString()} polygons</div>
        <div>{metadata.meshCount.toLocaleString()} meshes</div>
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

interface PointerCaptureTarget {
  readonly setPointerCapture: (pointerId: number) => void
  readonly releasePointerCapture?: (pointerId: number) => void
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

function ViewerScene({ model, progress, cameraMode, renderMode, surfaceInteractionMode, showGrid, sceneContent, shadows, selected, onSurfaceHit, onSurfacePointer, onSurfaceMiss, onCameraMetrics }: ViewerSceneProps): ReactNode {
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
  const aspect = viewport.width > 0 && viewport.height > 0 ? viewport.width / viewport.height : 1
  const fit = useMemo(() => fitViewerCamera(normalisedFrame, aspect, cameraMode), [aspect, cameraMode, normalisedFrame])
  const orthographicFrustum = useMemo(() => createViewerOrthographicFrustum(fit.orthographicSize, aspect), [aspect, fit.orthographicSize])
  const gridY = -normalisedFrame.size.y / 2 - 0.025
  const gridExtent = Math.max(normalisedFrame.size.x, normalisedFrame.size.z, 12) * 1.6
  const cameraPosition: [number, number, number] = [fit.position.x, fit.position.y, fit.position.z]
  const cameraTarget: [number, number, number] = [fit.target.x, fit.target.y, fit.target.z]
  const orbitControlsEnabled = viewerOrbitControlsEnabled(surfaceInteractionMode)
  const pointerTrackerRef = useRef<ViewerPointerTracker>(createViewerPointerTracker())
  const pointerCaptureRef = useRef<Map<number, PointerCaptureTarget>>(new Map())

  // Surface hits are supplied by the packed model picker proxy below. Disable
  // each imported mesh's default triangle walk while it is mounted so a large
  // OBJ cannot turn every hover into an O(faceCount) R3F raycast.
  useEffect(() => disableViewerModelRaycasts(model.loaded.object), [model.loaded.object])

  const surfacePicker = useMemo(() => {
    const picker = new THREE.Object3D()
    if (model.index === null) return picker
    const inverseNormalisation = new THREE.Matrix4()
      .compose(normalised.position, new THREE.Quaternion(), new THREE.Vector3(normalised.scale, normalised.scale, normalised.scale))
      .invert()
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
  }, [model.index, normalised.position, normalised.scale])

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
    if (!pointerTrackerRef.current.finish(native.pointerId)) return
    const capture = pointerCaptureRef.current.get(native.pointerId) ?? null
    pointerCaptureRef.current.delete(native.pointerId)
    releaseNativePointer(capture, native.pointerId)
    onSurfacePointer({
      phase,
      pointerId: native.pointerId,
      button: native.button,
      buttons: native.buttons,
      shiftKey: native.shiftKey,
      altKey: native.altKey,
      ctrlKey: native.ctrlKey,
      metaKey: native.metaKey,
      selection: null,
    })
  }, [onSurfacePointer])

  const cancelTrackedPointers = useCallback((): void => {
    cancelViewerPointers(pointerTrackerRef.current, (pointerId) => {
      const capture = pointerCaptureRef.current.get(pointerId) ?? null
      pointerCaptureRef.current.delete(pointerId)
      releaseNativePointer(capture, pointerId)
      onSurfacePointer({ phase: 'cancel', pointerId, button: -1, buttons: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, selection: null })
    })
  }, [onSurfacePointer])

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
      cancelTrackedPointers()
    }
  }, [cancelTrackedPointers, notifyNativePointerTermination])

  const notifySurfacePointer = useCallback((phase: ViewerSurfacePointerPhase, event: ThreeEvent<PointerEvent>): ViewerSurfaceHit | null => {
    const point = toViewerSurfaceModelPoint(event.point, normalised.position, normalised.scale)
    const hit = selectViewerSurface(model.index, { object: event.object, faceIndex: event.faceIndex ?? undefined, point })
    const native = event.nativeEvent
    onSurfacePointer({
      phase,
      pointerId: native.pointerId,
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
    notifySurfacePointer('move', event)
  }, [notifySurfacePointer])

  const handlePointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    pointerTrackerRef.current.begin(event.nativeEvent.pointerId)
    const capture = captureNativePointer(event.nativeEvent)
    if (capture !== null) pointerCaptureRef.current.set(event.nativeEvent.pointerId, capture)
    const hit = notifySurfacePointer('down', event)
    if (hit !== null) onSurfaceHit(hit, event.nativeEvent.shiftKey)
  }, [notifySurfacePointer, onSurfaceHit])

  const handlePointerUp = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (!pointerTrackerRef.current.finish(event.nativeEvent.pointerId)) return
    const capture = pointerCaptureRef.current.get(event.nativeEvent.pointerId) ?? null
    pointerCaptureRef.current.delete(event.nativeEvent.pointerId)
    releaseNativePointer(capture, event.nativeEvent.pointerId)
    notifySurfacePointer('up', event)
  }, [notifySurfacePointer])

  const handlePointerCancel = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (!pointerTrackerRef.current.finish(event.nativeEvent.pointerId)) return
    const capture = pointerCaptureRef.current.get(event.nativeEvent.pointerId) ?? null
    pointerCaptureRef.current.delete(event.nativeEvent.pointerId)
    releaseNativePointer(capture, event.nativeEvent.pointerId)
    notifySurfacePointer('cancel', event)
  }, [notifySurfacePointer])

  return (
    <>
      {cameraMode === 'orthographic'
        ? <OrthographicCamera key="orthographic" makeDefault position={cameraPosition} near={fit.near} far={fit.far} left={orthographicFrustum.left} right={orthographicFrustum.right} top={orthographicFrustum.top} bottom={orthographicFrustum.bottom} zoom={1} />
        : <PerspectiveCamera key="perspective" makeDefault position={cameraPosition} near={fit.near} far={fit.far} fov={42} />}
      <OrbitControls
        key={`controls-${cameraMode}`}
        makeDefault
        enabled={orbitControlsEnabled}
        target={cameraTarget}
        enableDamping
        dampingFactor={0.08}
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
    <button type="button" style={{ ...buttonStyle, fontWeight: cameraMode === 'perspective' ? 700 : 400 }} aria-pressed={cameraMode === 'perspective'} onClick={() => { onCameraModeChange('perspective') }}>3D</button>
    <button type="button" style={{ ...buttonStyle, fontWeight: cameraMode === 'orthographic' ? 700 : 400 }} aria-pressed={cameraMode === 'orthographic'} onClick={() => { onCameraModeChange('orthographic') }}>Top</button>
    <button type="button" style={{ ...buttonStyle, fontWeight: renderMode === 'texture' ? 700 : 400 }} aria-pressed={renderMode === 'texture'} onClick={() => { onRenderModeChange('texture') }}>Texture</button>
    <button type="button" style={{ ...buttonStyle, fontWeight: renderMode === 'wireframe' ? 700 : 400 }} aria-pressed={renderMode === 'wireframe'} onClick={() => { onRenderModeChange('wireframe') }}>Wire</button>
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
    let pendingObject: THREE.Group | undefined
    const controller = new AbortController()
    // The loader effect owns the previous model lifecycle, so clear stale state before the replacement resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    resetViewerState(source === null ? null : { progress: 0, itemsLoaded: 0, itemsTotal: 1, phase: 'reading' })
    callbacksRef.current.onSurfacesChange?.([])
    const reportSurfaceProgress = (nextProgress: number): void => {
      const next: ViewerLoadProgress = {
        progress: nextProgress,
        itemsLoaded: nextProgress >= 1 ? 1 : 0,
        itemsTotal: 1,
        phase: nextProgress >= 1 ? 'complete' : 'finalising',
      }
      setProgress(next)
      callbacksRef.current.onLoadProgress?.(next)
    }
    const publish = async (loaded: LoadedViewerModel): Promise<void> => {
      if (!active) {
        loaded.dispose()
        return
      }
      // Publish the parsed object immediately. Surface analysis is deliberately
      // a second, abortable phase so a large model can render while its hit
      // index/descriptors are built in cooperative chunks.
      owned = loaded
      setModel({ loaded, index: null, frame: computeViewerFrameFromBounds(loaded.metadata.boundingBox) })
      callbacksRef.current.onModelLoaded?.(loaded.metadata)
      try {
        await runViewerSurfaceAnalysis({
          isActive: () => isViewerLoadActive(active, controller.signal),
          buildIndex: () => createViewerSurfaceIndexAsync(loaded.object, loaded.object.uuid, undefined, { signal: controller.signal, chunkSize: 2560 }),
          buildDescriptors: (index) => index.surfaceDescriptorsAsync({ signal: controller.signal, chunkSize: 2560 }),
          onReady: (index, surfaces) => {
            setModel((current) => current?.loaded === loaded ? { ...current, index } : current)
            callbacksRef.current.onSurfacesChange?.(surfaces)
          },
          onProgress: (phase) => { reportSurfaceProgress(phase === 'complete' ? 1 : 0.92) },
        })
      } catch (cause: unknown) {
        if (!isViewerLoadActive(active, controller.signal)) return
        // A post-render analysis failure still owns the parsed object. Dispose
        // it before surfacing the error so texture/material resources cannot
        // leak through a failed descriptor publication.
        if (owned === loaded) owned = undefined
        loaded.dispose()
        setModel((current) => current?.loaded === loaded ? null : current)
        callbacksRef.current.onSurfacesChange?.([])
        throw cause
      }
    }
    const onObjectReady = (object: THREE.Group, dispose: () => void, bounds: ObjDocumentBounds): void => {
      if (!active || controller.signal.aborted) {
        dispose()
        return
      }
      pendingObject = object
      const frame = computeViewerFrameFromBounds({
        min: bounds.min,
        max: bounds.max,
        size: {
          x: bounds.max.x - bounds.min.x,
          y: bounds.max.y - bounds.min.y,
          z: bounds.max.z - bounds.min.z,
        },
      })
      const metadata = createViewerPreviewMetadata(object, frame, source?.name ?? 'Site model')
      const provisional: LoadedViewerModel = { object, metadata, dispose }
      setModel({ loaded: provisional, index: null, frame })
    }
    if (source === null) {
      void publish(createDemoViewerModel()).catch((cause: unknown) => {
        if (!active || (cause instanceof DOMException && cause.name === 'AbortError')) return
        const nextError = cause instanceof Error ? cause : new Error(String(cause))
        setError(nextError)
        callbacksRef.current.onError?.(nextError)
      })
    } else {
      void loadViewerModel(source, { signal: controller.signal, onObjectReady, onProgress: (next) => { if (active) { setProgress(next); callbacksRef.current.onLoadProgress?.(next) } } })
        .then(publish)
        .catch((cause: unknown) => {
          if (!active || (cause instanceof DOMException && cause.name === 'AbortError')) return
          if (pendingObject !== undefined) setModel((current) => current?.loaded.object === pendingObject ? null : current)
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
    return <div className={className} style={mergedStyle} role="alert" aria-label="WebGL unavailable">WebGL is unavailable in this browser. Enable hardware acceleration to view the site model.</div>
  }
  return (
    <div className={className} style={mergedStyle} aria-label={ariaLabel} data-testid="pv-viewer">
      <Canvas {...createViewerCanvasConfig(typeof window === 'undefined' ? 1 : window.devicePixelRatio)} shadows={shadows} gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }} onPointerMissed={clearSelection}>
        {model !== null && <ViewerScene model={model} progress={progress} cameraMode={cameraMode} renderMode={renderMode} surfaceInteractionMode={surfaceInteractionMode} showGrid={showGrid} sceneContent={<>{sceneContent}{children}</>} shadows={shadows} selected={selected} onSurfaceHit={handleSurfaceHit} onSurfacePointer={handleSurfacePointer} onSurfaceMiss={clearSelection} onCameraMetrics={setCameraMetrics} />}
      </Canvas>
      {model !== null && <MetadataOverlay metadata={model.loaded.metadata} />}
      <ViewModeButtons cameraMode={cameraMode} renderMode={renderMode} onCameraModeChange={setCameraMode} onRenderModeChange={setRenderMode} />
      {showCompass && <CompassOverlay northAngleDeg={cameraMetrics?.northAngleDeg ?? 0} />}
      {showScale && model !== null && <ScaleOverlay metrics={cameraMetrics} />}
      <ModelStatus progress={progress} error={error} />
    </div>
  )
}

export default Viewer
