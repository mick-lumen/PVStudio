import {
  AlertTriangle,
  ArrowDownToLine,
  Box,
  Check,
  CircleHelp,
  Copy,
  FileUp,
  Grid2X2,
  Keyboard,
  Layers3,
  Maximize2,
  Menu,
  Moon,
  MousePointer2,
  Move3d,
  PanelTop,
  PanelsTopLeft,
  Plus,
  Redo2,
  RotateCw,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  Component,
  type ChangeEvent,
  type ErrorInfo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  Orientation,
  PanelDefinition,
  PanelGroupSettings,
  PanelPlacement,
  Point2,
  RectangularObstacle,
  SurfaceDescriptor,
  SurfaceEdgeLine,
  SurfaceEdgeMetadata,
  SurfaceEdgeSide,
  SurfaceEdgeType,
} from '../core'
import { isSurfaceEdgeMetadata } from '../core'
import { supportsWebGL } from './webgl'

export type Theme = 'light' | 'dark'
export type ToolId = 'select' | 'place' | 'obstacle' | 'autofill' | 'align'
export type ViewMode = '3d' | '2d'
export type RenderMode = 'texture' | 'wireframe'
export type InspectorTab = 'panel' | 'inspector'
export type AlignStage = 'idle' | 'preview' | 'confirm'

/** A display-ready surface summary. SurfaceDescriptor is structurally compatible. */
export type ShellSurface = Pick<SurfaceDescriptor, 'id' | 'area' | 'usableArea' | 'azimuthDeg' | 'tiltDeg'> & {
  readonly label?: string
}

/** Display-ready edge metadata for the selected surface inspector. */
export interface ShellSurfaceEdge extends SurfaceEdgeMetadata {
  readonly surfaceId: string
  readonly label: string
  readonly path: string
  readonly line?: SurfaceEdgeLine
}

/** The minimum panel data the shell may display. Panel catalogues stay in PanelChooser. */
export type ShellPanel = Pick<PanelDefinition, 'id' | 'manufacturer' | 'model' | 'wattageW'> & {
  readonly efficiencyPct?: number
}

export interface ShellArray {
  readonly id: string
  readonly panelId: string
  readonly panelCount: number
}

export interface PanelPlacementSummary {
  readonly count: number
  readonly selectedCount: number
  readonly previewCount: number
  readonly draggingCount: number
  readonly totalWattageW?: number
  readonly arrayCount?: number
  readonly selectedArrayPanelCount?: number
  readonly individualSelectedCount?: number
}

export interface AlignPreviewState {
  readonly candidateCount: number
  readonly valid: boolean
  readonly reason?: string
}

export interface ShellProps {
  /** Feature slots. They are wrapped in an error boundary independently. */
  readonly viewer?: ReactNode
  readonly panelChooser?: ReactNode
  /** `library` is retained as an alias for hosts using the first shell API. */
  readonly library?: ReactNode
  readonly inspector?: ReactNode
  readonly panelStatus?: ReactNode

  /** Project chrome. Project name is omitted when not supplied rather than invented. */
  readonly projectName?: string
  readonly headerSlot?: ReactNode
  readonly initialTheme?: Theme
  readonly theme?: Theme
  readonly onThemeChange?: (theme: Theme) => void

  /** Camera and display state. Supplying a value makes that control controlled. */
  readonly cameraMode?: ViewMode
  readonly viewMode?: ViewMode
  readonly initialCameraMode?: ViewMode
  readonly onCameraModeChange?: (mode: ViewMode) => void
  readonly renderMode?: RenderMode
  readonly initialRenderMode?: RenderMode
  readonly onRenderModeChange?: (mode: RenderMode) => void
  readonly showGrid?: boolean
  readonly initialShowGrid?: boolean
  readonly onShowGridChange?: (visible: boolean) => void

  /** Placement context shown by the shell and sent back through callbacks. */
  readonly activeTool?: ToolId
  readonly initialActiveTool?: ToolId
  readonly onToolChange?: (tool: ToolId) => void
  readonly selectedSurface?: ShellSurface | null
  readonly selectedSurfaceEdge?: ShellSurfaceEdge | null
  readonly onSurfaceEdgeChange?: (edge: SurfaceEdgeMetadata | undefined) => void
  readonly selectedPanel?: ShellPanel | null
  readonly panelOptions?: readonly ShellPanel[]
  readonly arrays?: readonly ShellArray[]
  readonly selectedArrayId?: string
  readonly onArraySelect?: (arrayId: string) => void
  readonly onArrayPanelChange?: (panelId: string) => void
  /** Re-arm the currently selected catalogue panel from the array inspector. */
  readonly onAddSelectedPanel?: () => void
  readonly placements?: readonly PanelPlacement[]
  readonly selectedPlacementIds?: readonly string[]
  readonly placementSummary?: PanelPlacementSummary
  readonly settings?: PanelGroupSettings
  /** Copy shown beside array settings to make the editing scope explicit. */
  readonly settingsScopeLabel?: string
  readonly onSettingsChange?: (patch: Partial<PanelGroupSettings>) => void
  readonly alignStage?: AlignStage
  readonly initialAlignStage?: AlignStage
  readonly alignPreview?: AlignPreviewState | null

  /** Actions are optional so the same shell can host read-only previews. */
  readonly canUndo?: boolean
  readonly canRedo?: boolean
  readonly onUndo?: () => void
  readonly onRedo?: () => void
  readonly onDelete?: (ids: readonly string[]) => void
  readonly onMoveSelection?: () => void
  readonly onRotateSelection?: () => void
  readonly onDuplicateSelection?: () => void
  readonly onDeleteArray?: () => void
  /** Optional host actions for the shell's utility controls. */
  readonly onFitView?: () => void
  readonly onHelp?: () => void
  readonly onLayersOpen?: () => void
  readonly onAutoFill?: () => void
  readonly obstacles?: readonly RectangularObstacle[]
  readonly draftObstacle?: RectangularObstacle | null
  readonly onObstacleStart?: () => void
  readonly onObstacleCancel?: () => void
  readonly onObstacleChange?: (id: string, patch: ObstacleGeometryPatch) => void
  readonly onObstacleRemove?: (id: string) => void
  readonly onObstaclesClear?: () => void
  readonly onAlignStart?: () => void
  readonly onAlignConfirm?: () => void
  readonly onAlignCancel?: () => void
  readonly onNudgeSelection?: (delta: Point2) => void
  readonly nudgeStepM?: number

  /** OBJ/MTL/texture import. Multi-file imports take precedence over legacy callbacks. */
  readonly onImportFiles?: (files: readonly File[]) => void
  /** Load the checked-in browser-safe WebODM fixture without opening a picker. */
  readonly onLoadSample?: () => void
  /** Legacy single-file import callbacks remain supported. */
  readonly onImport?: (file: File) => void
  readonly onImportModel?: (file: File) => void
  readonly acceptedImportTypes?: string
  readonly webglAvailable?: boolean
  readonly statusMessage?: string
  /** Elevates import work and failures above the persistent footer status. */
  readonly statusKind?: 'default' | 'progress' | 'error'
  readonly className?: string
}

export type ObstacleGeometryPatch = Partial<Pick<RectangularObstacle, 'x' | 'y' | 'width' | 'height'>>

interface ErrorBoundaryProps {
  readonly children: ReactNode
  readonly area: string
  /** Stable host-owned identity used to reset a failed slot after replacement. */
  readonly resetKey?: unknown
}

interface ErrorBoundaryState {
  readonly error: Error | null
}

interface ToolDefinition {
  readonly id: ToolId
  readonly label: string
  readonly shortcut: string
  readonly description: string
  readonly icon: typeof MousePointer2
}

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  { id: 'select', label: 'Select', shortcut: 'V', description: 'Select a surface or panel', icon: MousePointer2 },
  { id: 'place', label: 'Place', shortcut: 'P', description: 'Place a panel on the active surface', icon: Plus },
  { id: 'obstacle', label: 'Obstacle', shortcut: 'B', description: 'Draw or move a rectangular obstacle — drag empty surface to draw, or drag an existing obstacle to move it. Press Escape to cancel', icon: Square },
  { id: 'autofill', label: 'Auto-fill', shortcut: 'A', description: 'Preview a filled layout', icon: Sparkles },
  { id: 'align', label: 'Align', shortcut: 'L', description: 'Align selected panels in a preview', icon: Layers3 },
]

const INSPECTOR_TABS: readonly InspectorTab[] = ['panel', 'inspector']

function getInitialTheme(requestedTheme: Theme | undefined): Theme {
  if (requestedTheme !== undefined) return requestedTheme
  if (typeof window !== 'undefined') {
    try {
      const storedTheme = window.localStorage.getItem('pvstudio-theme')
      if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme
    } catch {
      // Storage can be unavailable in private browsing or a restricted iframe.
    }
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  }
  return 'light'
}

function isCompactViewport(): boolean {
  if (typeof window === 'undefined') return false
  const mediaQueryMatches = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 820px)').matches
  return mediaQueryMatches || (window.innerWidth > 0 && window.innerWidth <= 820)
}

function persistTheme(theme: Theme): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem('pvstudio-theme', theme)
  } catch {
    // A theme preference is optional; an unavailable storage backend must not break the shell.
  }
}

function formatAcceptedImportTypes(acceptedTypes: string): string {
  const labels = acceptedTypes
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
    .map((value) => {
      const knownMimeLabels: Record<string, string> = {
        'image/jpeg': 'JPEG',
        'image/png': 'PNG',
        'model/mtl': 'MTL',
        'model/obj': 'OBJ',
      }
      return knownMimeLabels[value] ?? (value.startsWith('.') ? value.slice(1).toUpperCase() : value.toUpperCase())
    })
    .filter((value, index, all) => all.indexOf(value) === index)
  return labels.length === 0 ? 'Supported file types' : labels.join(' · ')
}

function parseFiniteInput(value: string): number | undefined {
  if (value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const DIALOG_FOCUSABLE_SELECTOR = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function getDialogFocusable(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR))
}

function numericInputValue(value: number): number | '' {
  return Number.isFinite(value) ? value : ''
}

function optionalNumericInputValue(value: number | undefined): number | '' {
  return value === undefined ? '' : numericInputValue(value)
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function formatArea(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)} m²` : '—'
}

function formatDegrees(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(0)}°` : '—'
}

function formatMillimetres(value: number): string {
  return Number.isFinite(value) ? `${String(Math.round(value * 1000))} mm` : '—'
}

const surfaceEdgeTypeFromValue = (value: string): SurfaceEdgeType | undefined => {
  if (value === 'gutter' || value === 'ridge' || value === 'valley' || value === 'rake') return value
  return undefined
}

const reverseEdgeDirection = (direction: SurfaceEdgeLine['direction']): SurfaceEdgeLine['direction'] => ({
  x: direction.x === 0 ? 0 : -direction.x,
  y: direction.y === 0 ? 0 : -direction.y,
})

export class ShellErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { error: null }

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Hosts can wrap this boundary and report to their own telemetry provider.
    void error
    void errorInfo
  }

  public componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    const changed = previousProps.area !== this.props.area || (this.props.resetKey === undefined
      ? previousProps.children !== this.props.children
      : previousProps.resetKey !== this.props.resetKey)
    if (this.state.error !== null && changed) {
      this.setState({ error: null })
    }
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  public render(): ReactNode {
    if (this.state.error !== null) return <ErrorFallback area={this.props.area} onRetry={this.reset} />
    return this.props.children
  }
}

function ErrorFallback({ area, onRetry }: { readonly area: string; readonly onRetry: () => void }): ReactNode {
  return (
    <section className="shell-error" role="alert" aria-label={`${area} error`}>
      <div className="shell-error__icon" aria-hidden="true"><AlertTriangle size={18} /></div>
      <div>
        <h2>We hit a snag in {area.toLowerCase()}</h2>
        <p>This area can be restarted without losing the rest of your design.</p>
        <button className="button button--quiet" type="button" onClick={onRetry}>Try again</button>
      </div>
    </section>
  )
}

export function WebGLFallback(): ReactNode {
  return (
    <section className="webgl-fallback" role="alert" aria-label="WebGL unavailable">
      <div className="webgl-fallback__mark" aria-hidden="true"><Box size={24} strokeWidth={1.7} /></div>
      <div className="webgl-fallback__copy">
        <p className="eyebrow">3D preview unavailable</p>
        <h2>Enable hardware acceleration to view your site</h2>
        <p>PV Studio needs WebGL for the interactive model. Update your browser or enable hardware acceleration, then reload this tab.</p>
        <a href="https://get.webgl.org/" target="_blank" rel="noreferrer">Check WebGL support <ArrowDownToLine size={14} aria-hidden="true" /></a>
      </div>
    </section>
  )
}

function EmptySlot({ label, action, onAction }: { readonly label: string; readonly action?: string; readonly onAction?: () => void }): ReactNode {
  return (
    <div className="slot-empty" role="status">
      <div className="slot-empty__icon" aria-hidden="true"><Box size={18} /></div>
      <strong>{label} is ready to connect</strong>
      <span>Provide the {label.toLowerCase()} slot from the feature host.</span>
      {action !== undefined && onAction !== undefined ? <button className="button button--primary button--full" type="button" onClick={onAction}><FileUp size={15} aria-hidden="true" />{action}</button> : null}
    </div>
  )
}

function ViewerPlaceholder({ onImport, onLoadSample, acceptedTypeHint }: { readonly onImport?: () => void; readonly onLoadSample?: () => void; readonly acceptedTypeHint: string }): ReactNode {
  return (
    <div className="viewer-placeholder" data-testid="viewer-placeholder">
      <div className="viewer-placeholder__halo" aria-hidden="true" />
      <div className="viewer-placeholder__content">
        <div className="viewer-placeholder__icon" aria-hidden="true"><Upload size={20} strokeWidth={1.8} /></div>
        <p className="eyebrow">Start a new design</p>
        <h2>Bring your site into view</h2>
        <p className="viewer-placeholder__intro">Lightweight Demo is ready in the browser. Import your own WebODM model, or try the sample when you want a full textured house.</p>
        {onImport === undefined ? null : <button className="button button--quiet" type="button" onClick={onImport}><FileUp size={16} aria-hidden="true" />Import site model</button>}
        {onLoadSample === undefined ? null : <button className="button button--primary" type="button" onClick={onLoadSample} data-testid="load-sample-model"><Sparkles size={16} aria-hidden="true" />Try WebODM sample</button>}
        {onLoadSample === undefined ? null : <span className="viewer-placeholder__sample-note">The sample downloads only after you click Try WebODM sample.</span>}
        <span className="viewer-placeholder__hint">{acceptedTypeHint}</span>
      </div>
    </div>
  )
}

function SurfaceSummary({ surface, edge, onEdgeChange }: { readonly surface: ShellSurface; readonly edge?: ShellSurfaceEdge | null; readonly onEdgeChange?: (next: SurfaceEdgeMetadata | undefined) => void }): ReactNode {
  const disabled = onEdgeChange === undefined
  const directionLabel = edge === undefined || edge === null
    ? '—'
    : `${edge.direction.x.toFixed(2)}, ${edge.direction.y.toFixed(2)}`
  const emit = (next: SurfaceEdgeMetadata | undefined): void => {
    if (next === undefined) {
      onEdgeChange?.(undefined)
      return
    }
    if (isSurfaceEdgeMetadata(next)) onEdgeChange?.(next)
  }
  const currentMetadata = (): SurfaceEdgeMetadata => ({
    type: edge?.type ?? 'gutter',
    direction: edge?.direction ?? { x: 1, y: 0 },
    ...(edge?.line === undefined ? {} : { line: edge.line }),
    ...(edge?.side === undefined ? {} : { side: edge.side }),
  })
  const changeType = (value: string): void => {
    const type = surfaceEdgeTypeFromValue(value)
    if (type === undefined) {
      emit(undefined)
      return
    }
    emit({ ...currentMetadata(), type })
  }
  const reverse = (): void => {
    if (edge === undefined || edge === null) return
    emit({ ...currentMetadata(), direction: reverseEdgeDirection(edge.direction) })
  }
  const changeDirection = (axis: 'x' | 'y', rawValue: string): void => {
    const value = parseFiniteInput(rawValue)
    if (value === undefined) return
    const direction = { ...currentMetadata().direction, [axis]: value }
    emit({ ...currentMetadata(), direction })
  }
  const changeLine = (field: 'originX' | 'originY' | 'directionX' | 'directionY', rawValue: string): void => {
    const value = parseFiniteInput(rawValue)
    if (value === undefined) return
    const line = edge?.line ?? { origin: { x: 0, y: 0 }, direction: { x: 1, y: 0 } }
    const nextLine: SurfaceEdgeLine = field === 'originX'
      ? { ...line, origin: { ...line.origin, x: value } }
      : field === 'originY'
        ? { ...line, origin: { ...line.origin, y: value } }
        : field === 'directionX'
          ? { ...line, direction: { ...line.direction, x: value } }
          : { ...line, direction: { ...line.direction, y: value } }
    emit({ ...currentMetadata(), line: nextLine })
  }
  const changeSide = (value: string): void => {
    const side: SurfaceEdgeSide | undefined = value === 'left' || value === 'right' ? value : undefined
    const metadata = currentMetadata()
    emit(side === undefined ? { type: metadata.type, direction: metadata.direction, ...(metadata.line === undefined ? {} : { line: metadata.line }) } : { ...metadata, side })
  }
  const metadataLine = edge?.line
  return (
    <section className="inspector-card inspector-card--surface" aria-labelledby="surface-summary-title">
      <div className="inspector-card__title-row"><h3 id="surface-summary-title">Surface summary</h3><span className="surface-status"><span aria-hidden="true" />Active</span></div>
      <dl className="metric-grid">
        <div><dt>Area</dt><dd>{formatArea(surface.area)}</dd></div>
        <div><dt>Azimuth</dt><dd>{formatDegrees(surface.azimuthDeg)}</dd></div>
        <div><dt>Tilt</dt><dd>{formatDegrees(surface.tiltDeg)}</dd></div>
        <div><dt>Usable</dt><dd>{formatArea(surface.usableArea)}</dd></div>
      </dl>
      <div className="surface-edge-editor" data-testid="surface-edge-editor">
        <p className="inspector-note">Selected edge</p>
        <p className="inspector-note" data-testid="surface-edge-path">{edge?.path ?? `Surface ${surface.id} › No edge metadata`}</p>
        <label className="setting-row"><span>Type</span><select value={edge?.type ?? ''} disabled={disabled} aria-label="Surface edge type" onChange={(event) => { changeType(event.currentTarget.value) }}><option value="">Not set</option><option value="gutter">Gutter</option><option value="ridge">Ridge</option><option value="valley">Valley</option><option value="rake">Rake</option></select></label>
        <div className="setting-row"><span>Direction</span><span className="surface-edge-direction" data-testid="surface-edge-direction">{directionLabel}</span></div>
        <label className="setting-row"><span>Direction X</span><input data-testid="surface-edge-direction-x" aria-label="Surface edge direction X" type="number" step="0.1" value={numericInputValue(edge?.direction.x ?? 1)} disabled={disabled || edge === undefined || edge === null} onChange={(event) => { changeDirection('x', event.currentTarget.value) }} /></label>
        <label className="setting-row"><span>Direction Y</span><input data-testid="surface-edge-direction-y" aria-label="Surface edge direction Y" type="number" step="0.1" value={numericInputValue(edge?.direction.y ?? 0)} disabled={disabled || edge === undefined || edge === null} onChange={(event) => { changeDirection('y', event.currentTarget.value) }} /></label>
        <label className="setting-row"><span>Line origin X</span><input data-testid="surface-edge-line-origin-x" aria-label="Surface edge line origin X" type="number" step="0.1" value={numericInputValue(metadataLine?.origin.x ?? 0)} disabled={disabled || edge === undefined || edge === null} onChange={(event) => { changeLine('originX', event.currentTarget.value) }} /></label>
        <label className="setting-row"><span>Line origin Y</span><input data-testid="surface-edge-line-origin-y" aria-label="Surface edge line origin Y" type="number" step="0.1" value={numericInputValue(metadataLine?.origin.y ?? 0)} disabled={disabled || edge === undefined || edge === null} onChange={(event) => { changeLine('originY', event.currentTarget.value) }} /></label>
        <label className="setting-row"><span>Line direction X</span><input data-testid="surface-edge-line-direction-x" aria-label="Surface edge line direction X" type="number" step="0.1" value={numericInputValue(metadataLine?.direction.x ?? 1)} disabled={disabled || edge === undefined || edge === null} onChange={(event) => { changeLine('directionX', event.currentTarget.value) }} /></label>
        <label className="setting-row"><span>Line direction Y</span><input data-testid="surface-edge-line-direction-y" aria-label="Surface edge line direction Y" type="number" step="0.1" value={numericInputValue(metadataLine?.direction.y ?? 0)} disabled={disabled || edge === undefined || edge === null} onChange={(event) => { changeLine('directionY', event.currentTarget.value) }} /></label>
        <label className="setting-row"><span>Interior side</span><select data-testid="surface-edge-side" aria-label="Surface edge interior side" value={edge?.side ?? ''} disabled={disabled || edge === undefined || edge === null || metadataLine === undefined} onChange={(event) => { changeSide(event.currentTarget.value) }}><option value="">Auto / downhill</option><option value="left">Left of line</option><option value="right">Right of line</option></select></label>
        <button className="button button--quiet button--full" type="button" aria-label="Reverse surface edge direction" disabled={disabled || edge === undefined || edge === null} onClick={reverse}>Reverse direction</button>
      </div>
    </section>
  )
}

function PanelSummary({ panel }: { readonly panel: ShellPanel }): ReactNode {
  return (
    <section className="inspector-card" aria-labelledby="panel-summary-title">
      <div className="inspector-card__title-row"><h3 id="panel-summary-title">Selected panel</h3><Check size={15} aria-hidden="true" /></div>
      <p className="panel-summary__name">{panel.manufacturer} · {panel.model}</p>
      <dl className="metric-grid metric-grid--two">
        <div><dt>Output</dt><dd>{Number.isFinite(panel.wattageW) ? `${String(panel.wattageW)} W` : '—'}</dd></div>
        {panel.efficiencyPct === undefined ? null : <div><dt>Efficiency</dt><dd>{Number.isFinite(panel.efficiencyPct) ? `${panel.efficiencyPct.toFixed(1)}%` : '—'}</dd></div>}
      </dl>
    </section>
  )
}

function SettingsSummary({ settings, scopeLabel, onChange }: { readonly settings: PanelGroupSettings; readonly scopeLabel?: string; readonly onChange?: (patch: Partial<PanelGroupSettings>) => void }): ReactNode {
  const [advanced, setAdvanced] = useState(false)
  const disabled = onChange === undefined
  const change = (patch: Partial<PanelGroupSettings>): void => { onChange?.(patch) }
  const changeNumber = (key: 'setbackM' | 'interPanelSpacingM' | 'rowSpacingM' | 'clearanceM' | 'tiltDeg' | 'azimuthDeg' | 'horizontalGroupSpacingM' | 'verticalGroupSpacingM', rawValue: string): void => {
    const value = parseFiniteInput(rawValue)
    if (value === undefined) return
    if (key !== 'tiltDeg' && key !== 'azimuthDeg' && value < 0) return
    if (key === 'tiltDeg' && (value < 0 || value > 90)) return
    change({ [key]: value })
  }
  const changeOptionalNumber = (
    key: 'modulesPerRow' | 'modulesPerColumn' | 'rowOffsetM' | 'obstacleClearanceM',
    rawValue: string,
  ): void => {
    if (rawValue.trim().length === 0) {
      change({ [key]: undefined })
      return
    }
    const value = parseFiniteInput(rawValue)
    if (value === undefined) return
    if ((key === 'modulesPerRow' || key === 'modulesPerColumn') && (!Number.isInteger(value) || value < 1)) return
    if ((key === 'rowOffsetM' || key === 'obstacleClearanceM') && value < 0) return
    change({ [key]: value })
  }
  return (
    <section className="inspector-card" aria-labelledby="layout-settings-title">
      <div className="inspector-card__title-row"><h3 id="layout-settings-title">Array settings</h3><Settings2 size={15} aria-hidden="true" /></div>
      <p className="inspector-note settings-scope" data-testid="settings-scope">Editing {scopeLabel ?? 'Global defaults'}</p>
      <div className="inspector-tabs" role="tablist" aria-label="Array setting level"><button className={`inspector-tab${advanced ? '' : ' inspector-tab--active'}`} type="button" role="tab" aria-selected={!advanced} onClick={() => { setAdvanced(false) }}>Basic</button><button className={`inspector-tab${advanced ? ' inspector-tab--active' : ''}`} type="button" role="tab" aria-selected={advanced} onClick={() => { setAdvanced(true) }}>Advanced</button></div>
      <div className={`settings-section${advanced ? '' : ' settings-section--active'}`} aria-label="Basic array settings">
        <label className="setting-row"><span>Orientation</span><select value={settings.orientation} disabled={disabled} aria-label="Panel orientation" onChange={(event) => { change({ orientation: event.currentTarget.value as Orientation }); }}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
        <label className="setting-row"><span>Azimuth</span><span className="input-with-unit"><input type="number" step={1} value={numericInputValue(settings.azimuthDeg ?? 0)} disabled={disabled} aria-label="Array azimuth in degrees" onChange={(event) => { changeNumber('azimuthDeg', event.currentTarget.value) }} /><small>°</small></span></label>
        <label className="setting-row"><span>Tilt</span><span className="input-with-unit"><input type="number" min={0} max={90} step={1} value={numericInputValue(settings.tiltDeg)} disabled={disabled} aria-label="Panel tilt in degrees" onChange={(event) => { changeNumber('tiltDeg', event.currentTarget.value) }} /><small>°</small></span></label>
        <label className="setting-row"><span>Height / roof clearance</span><span className="input-with-unit"><input type="number" min={0} step={0.01} value={numericInputValue(settings.clearanceM)} disabled={disabled} aria-label="Panel clearance in metres" onChange={(event) => { changeNumber('clearanceM', event.currentTarget.value) }} /><small>m</small></span></label>
      </div>
      <div className={`settings-section${advanced ? ' settings-section--active' : ''}`} aria-label="Advanced array settings">
        <label className="setting-row"><span>Horizontal module spacing</span><span className="input-with-unit"><input type="number" min={0} step={0.01} value={numericInputValue(settings.interPanelSpacingM)} disabled={disabled} aria-label="Horizontal module spacing in metres" onChange={(event) => { changeNumber('interPanelSpacingM', event.currentTarget.value) }} /><small>m</small></span></label>
        <label className="setting-row"><span>Vertical module spacing</span><span className="input-with-unit"><input type="number" min={0} step={0.01} value={numericInputValue(settings.rowSpacingM)} disabled={disabled} aria-label="Vertical module spacing in metres" onChange={(event) => { changeNumber('rowSpacingM', event.currentTarget.value) }} /><small>m</small></span></label>
        <label className="setting-row"><span>Modules per row</span><input data-testid="autofill-modules-per-row" type="number" min={1} step={1} placeholder="Auto" value={optionalNumericInputValue(settings.modulesPerRow)} disabled={disabled} aria-label="Modules per row" onChange={(event) => { changeOptionalNumber('modulesPerRow', event.currentTarget.value) }} /></label>
        <label className="setting-row"><span>Modules per column</span><input type="number" min={1} step={1} placeholder="Auto" value={optionalNumericInputValue(settings.modulesPerColumn)} disabled={disabled} aria-label="Modules per column" onChange={(event) => { changeOptionalNumber('modulesPerColumn', event.currentTarget.value) }} /></label>
        <label className="setting-row"><span>Horizontal group spacing</span><span className="input-with-unit"><input type="number" min={0} step={0.01} value={numericInputValue(settings.horizontalGroupSpacingM ?? 0)} disabled={disabled} aria-label="Horizontal group spacing in metres" onChange={(event) => { changeNumber('horizontalGroupSpacingM', event.currentTarget.value) }} /><small>m</small></span></label>
        <label className="setting-row"><span>Vertical group spacing</span><span className="input-with-unit"><input type="number" min={0} step={0.01} value={numericInputValue(settings.verticalGroupSpacingM ?? 0)} disabled={disabled} aria-label="Vertical group spacing in metres" onChange={(event) => { changeNumber('verticalGroupSpacingM', event.currentTarget.value) }} /><small>m</small></span></label>
        <label className="setting-row"><span>Edge setback</span><span className="input-with-unit"><input type="number" min={0} step={0.01} value={numericInputValue(settings.setbackM)} disabled={disabled} aria-label="Edge setback in metres" onChange={(event) => { changeNumber('setbackM', event.currentTarget.value) }} /><small>m</small></span></label>
        <label className="setting-row"><span>Row offset</span><span className="input-with-unit"><input data-testid="autofill-row-offset" type="number" min={0} step={0.01} placeholder="Auto" value={optionalNumericInputValue(settings.rowOffsetM)} disabled={disabled} aria-label="Row offset in metres" onChange={(event) => { changeOptionalNumber('rowOffsetM', event.currentTarget.value) }} /><small>m</small></span></label>
        <label className="setting-row"><span>Obstacle clearance</span><span className="input-with-unit"><input data-testid="autofill-obstacle-clearance" type="number" min={0} step={0.01} placeholder="Auto" value={optionalNumericInputValue(settings.obstacleClearanceM)} disabled={disabled} aria-label="Obstacle clearance in metres" onChange={(event) => { changeOptionalNumber('obstacleClearanceM', event.currentTarget.value) }} /><small>m</small></span></label>
      </div>
      <p className="inspector-note"><SlidersHorizontal size={13} aria-hidden="true" /> Setback {formatMillimetres(settings.setbackM)} · row {formatMillimetres(settings.rowSpacingM)}</p>
    </section>
  )
}

function PlacementSummary({ summary }: { readonly summary: PanelPlacementSummary }): ReactNode {
  return (
    <section className="inspector-card inspector-card--status" aria-labelledby="placement-summary-title">
      <div className="inspector-card__title-row"><h3 id="placement-summary-title">Array status</h3><span className="status-dot" aria-hidden="true" /></div>
      <dl className="metric-grid metric-grid--two">
        <div><dt>Project panels</dt><dd>{String(summary.count)}</dd></div>
        <div><dt>Arrays</dt><dd>{String(summary.arrayCount ?? 0)}</dd></div>
        <div><dt>Selected array</dt><dd>{String(summary.selectedArrayPanelCount ?? 0)}</dd></div>
        <div><dt>Selected panels</dt><dd>{String(summary.individualSelectedCount ?? summary.selectedCount)}</dd></div>
        <div><dt>Preview</dt><dd>{String(summary.previewCount)}</dd></div>
        <div><dt>Dragging</dt><dd>{String(summary.draggingCount)}</dd></div>
      </dl>
      {summary.totalWattageW === undefined ? null : <p className="inspector-note"><ZapIcon aria-hidden={true} /> {String(summary.totalWattageW)} W nominal</p>}
    </section>
  )
}

function ArrayOverview({ arrays, selectedArrayId, onSelect }: { readonly arrays: readonly ShellArray[]; readonly selectedArrayId?: string; readonly onSelect?: (arrayId: string) => void }): ReactNode {
  if (arrays.length === 0) return null
  return (
    <section className="inspector-card" aria-labelledby="array-overview-title">
      <div className="inspector-card__title-row"><h3 id="array-overview-title">Panel arrays</h3><span className="surface-status"><span aria-hidden="true" />{String(arrays.length)}</span></div>
      <div className="array-list">
        {arrays.map((array, index) => <button className={`button button--quiet button--full${array.id === selectedArrayId ? ' is-selected' : ''}`} type="button" key={array.id} aria-pressed={array.id === selectedArrayId} onClick={() => { onSelect?.(array.id) }}><span>Array {String(index + 1)}</span><strong>{String(array.panelCount)} panels</strong></button>)}
      </div>
    </section>
  )
}

function ArrayPanelModel({ panels, panelId, onChange }: { readonly panels: readonly ShellPanel[]; readonly panelId: string; readonly onChange?: (panelId: string) => void }): ReactNode {
  return (
    <section className="inspector-card" aria-labelledby="array-panel-model-title">
      <div className="inspector-card__title-row"><h3 id="array-panel-model-title">Panel model</h3><PanelsTopLeft size={15} aria-hidden="true" /></div>
      <label className="setting-row"><span>Model for this array</span><select value={panelId} disabled={onChange === undefined} aria-label="Panel model for selected array" onChange={(event) => { onChange?.(event.currentTarget.value) }}>{panels.map((panel) => <option key={panel.id} value={panel.id}>{panel.manufacturer} {panel.model} · {String(panel.wattageW)} W</option>)}</select></label>
      <p className="inspector-note">Changing this updates every module in this array together.</p>
    </section>
  )
}

function ArrayActions({ selectedCount, onMove, onRotate, onDuplicate, onDelete }: { readonly selectedCount: number; readonly onMove?: () => void; readonly onRotate?: () => void; readonly onDuplicate?: () => void; readonly onDelete?: () => void }): ReactNode {
  if (selectedCount === 0) return null
  return (
    <section className="inspector-card" aria-labelledby="array-actions-title">
      <div className="inspector-card__title-row"><h3 id="array-actions-title">Panel group</h3><span className="surface-status"><span aria-hidden="true" />{String(selectedCount)} panels</span></div>
      <div className="array-action-grid">
        <button className="button button--quiet" type="button" disabled={onMove === undefined} onClick={onMove}><Move3d size={15} aria-hidden="true" />Move array</button>
        <button className="button button--quiet" type="button" disabled={onRotate === undefined} onClick={onRotate}><RotateCw size={15} aria-hidden="true" />Rotate 90°</button>
        <button className="button button--quiet" type="button" disabled={onDuplicate === undefined} onClick={onDuplicate}><Copy size={15} aria-hidden="true" />Duplicate</button>
        <button className="button button--quiet button--danger" type="button" disabled={onDelete === undefined} onClick={onDelete}><Trash2 size={15} aria-hidden="true" />Delete array</button>
      </div>
      <p className="inspector-note">Drag any highlighted panel to move the complete array. White outlines add the next panel.</p>
    </section>
  )
}

function ZapIcon({ 'aria-hidden': ariaHidden }: { readonly 'aria-hidden'?: boolean }): ReactNode {
  return <span className="inline-icon" aria-hidden={ariaHidden}>⚡</span>
}

function ObstacleNumberField({ label, value, minimum, onCommit }: { readonly label: string; readonly value: number; readonly minimum?: number; readonly onCommit: (value: number) => void }): ReactNode {
  const [editor, setEditor] = useState({ committedValue: value, draft: String(value) })
  if (editor.committedValue !== value) {
    setEditor({ committedValue: value, draft: String(value) })
  }

  const commit = (): void => {
    const next = Number(editor.draft)
    if (!Number.isFinite(next) || (minimum !== undefined && next < minimum)) {
      setEditor({ committedValue: value, draft: String(value) })
      return
    }
    if (next !== value) onCommit(next)
  }

  return (
    <label className="obstacle-field">
      <span>{label}</span>
      <span className="input-with-unit">
        <input
          type="number"
          step={0.1}
          {...(minimum === undefined ? {} : { min: minimum })}
          value={editor.draft}
          aria-label={`${label} in metres`}
          onChange={(event) => { setEditor({ committedValue: value, draft: event.currentTarget.value }) }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              setEditor({ committedValue: value, draft: String(value) })
              event.currentTarget.blur()
            }
          }}
        />
        <small>m</small>
      </span>
    </label>
  )
}

function ObstacleSummary({ obstacles, draftObstacle, onChange, onRemove, onClear }: { readonly obstacles: readonly RectangularObstacle[]; readonly draftObstacle?: RectangularObstacle | null; readonly onChange?: (id: string, patch: ObstacleGeometryPatch) => void; readonly onRemove?: (id: string) => void; readonly onClear?: () => void }): ReactNode {
  return (
    <section className="inspector-card" aria-labelledby="obstacle-summary-title">
      <div className="inspector-card__title-row"><h3 id="obstacle-summary-title">Surface obstacles</h3><span className="surface-status"><span aria-hidden="true" />{String(obstacles.length)}</span></div>
      {draftObstacle === null || draftObstacle === undefined ? null : <p className="inspector-note" role="status">Obstacle preview · {draftObstacle.width.toFixed(2)} × {draftObstacle.height.toFixed(2)} m</p>}
      {obstacles.length === 0 ? <p className="inspector-note">No obstacles on this surface.</p> : <ul className="obstacle-list">{obstacles.map((obstacle, index) => <li key={obstacle.id} className="obstacle-list__item"><div className="obstacle-list__header"><strong>Obstacle {String(index + 1)}</strong><span>{obstacle.width.toFixed(2)} × {obstacle.height.toFixed(2)} m</span><button className="icon-button icon-button--small" type="button" aria-label={`Remove obstacle ${obstacle.id}`} disabled={onRemove === undefined} onClick={() => { onRemove?.(obstacle.id) }}><X size={13} aria-hidden="true" /></button></div>{onChange === undefined ? null : <div className="obstacle-field-grid"><ObstacleNumberField label={`Obstacle ${String(index + 1)} X position`} value={obstacle.x} onCommit={(value) => { onChange(obstacle.id, { x: value }) }} /><ObstacleNumberField label={`Obstacle ${String(index + 1)} Y position`} value={obstacle.y} onCommit={(value) => { onChange(obstacle.id, { y: value }) }} /><ObstacleNumberField label={`Obstacle ${String(index + 1)} width`} value={obstacle.width} minimum={0.05} onCommit={(value) => { onChange(obstacle.id, { width: value }) }} /><ObstacleNumberField label={`Obstacle ${String(index + 1)} height`} value={obstacle.height} minimum={0.05} onCommit={(value) => { onChange(obstacle.id, { height: value }) }} /></div>}</li>)}</ul>}
      {onClear === undefined ? null : <button className="button button--quiet button--full" type="button" disabled={obstacles.length === 0} onClick={onClear}>Clear all obstacles</button>}
    </section>
  )
}

function InspectorFallback({ selectedSurface, selectedSurfaceEdge, onSurfaceEdgeChange, selectedPanel, panelOptions = [], arrays = [], selectedArrayId, onArraySelect, onArrayPanelChange, settings, settingsScopeLabel, onSettingsChange, selectedCount, onMoveSelection, onRotateSelection, onDuplicateSelection, onDeleteArray, placementSummary, onAutoFill, obstacles, draftObstacle, onObstacleChange, onObstacleRemove, onObstaclesClear }: { readonly selectedSurface?: ShellSurface | null; readonly selectedSurfaceEdge?: ShellSurfaceEdge | null; readonly onSurfaceEdgeChange?: (edge: SurfaceEdgeMetadata | undefined) => void; readonly selectedPanel?: ShellPanel | null; readonly panelOptions?: readonly ShellPanel[]; readonly arrays?: readonly ShellArray[]; readonly selectedArrayId?: string; readonly onArraySelect?: (arrayId: string) => void; readonly onArrayPanelChange?: (panelId: string) => void; readonly settings?: PanelGroupSettings; readonly settingsScopeLabel?: string; readonly onSettingsChange?: (patch: Partial<PanelGroupSettings>) => void; readonly selectedCount: number; readonly onMoveSelection?: () => void; readonly onRotateSelection?: () => void; readonly onDuplicateSelection?: () => void; readonly onDeleteArray?: () => void; readonly placementSummary?: PanelPlacementSummary; readonly onAutoFill?: () => void; readonly obstacles?: readonly RectangularObstacle[]; readonly draftObstacle?: RectangularObstacle | null; readonly onObstacleChange?: (id: string, patch: ObstacleGeometryPatch) => void; readonly onObstacleRemove?: (id: string) => void; readonly onObstaclesClear?: () => void }): ReactNode {
  if (selectedSurface === undefined && selectedPanel === undefined && settings === undefined && placementSummary === undefined && obstacles === undefined) return <EmptySlot label="Inspector" />
  return (
    <div className="inspector-content">
      <div className="inspector-heading"><div><p className="eyebrow">Inspector</p><h2>{selectedSurface?.label ?? 'Selection'}</h2></div><span className="surface-status"><span aria-hidden="true" />Active</span></div>
      {selectedArrayId === undefined || selectedPanel === undefined || selectedPanel === null ? null : <ArrayPanelModel panels={panelOptions} panelId={selectedPanel.id} onChange={onArrayPanelChange} />}
      <ArrayOverview arrays={arrays} selectedArrayId={selectedArrayId} onSelect={onArraySelect} />
      {selectedSurface === null ? <EmptySlot label="Surface" /> : selectedSurface === undefined ? null : <SurfaceSummary surface={selectedSurface} edge={selectedSurfaceEdge} onEdgeChange={onSurfaceEdgeChange} />}
      {selectedPanel === null ? null : selectedPanel === undefined ? null : <PanelSummary panel={selectedPanel} />}
      <ArrayActions selectedCount={selectedCount} onMove={onMoveSelection} onRotate={onRotateSelection} onDuplicate={onDuplicateSelection} onDelete={onDeleteArray} />
      {settings === undefined ? null : <SettingsSummary settings={settings} scopeLabel={settingsScopeLabel} onChange={onSettingsChange} />}
      {placementSummary === undefined ? null : <PlacementSummary summary={placementSummary} />}
      {obstacles === undefined ? null : <ObstacleSummary obstacles={obstacles} draftObstacle={draftObstacle} onChange={onObstacleChange} onRemove={onObstacleRemove} onClear={onObstaclesClear} />}
      {onAutoFill === undefined ? null : <button className="button button--primary button--full" type="button" onClick={onAutoFill}><Sparkles size={15} aria-hidden="true" />Auto-fill surface</button>}
    </div>
  )
}

function KeyboardShortcuts({ onClose }: { readonly onClose: () => void }): ReactNode {
  return (
    <div className="shortcuts-popover" role="dialog" aria-modal="false" aria-labelledby="shortcuts-title">
      <div className="shortcuts-popover__header"><h2 id="shortcuts-title"><Keyboard size={15} aria-hidden="true" /> Keyboard shortcuts</h2><button className="icon-button icon-button--small" type="button" aria-label="Close shortcuts" onClick={onClose}><X size={14} aria-hidden="true" /></button></div>
      <div className="shortcut-list">
        {TOOL_DEFINITIONS.map((tool) => <div className="shortcut-row" key={tool.id}><span>{tool.label}</span><kbd>{tool.shortcut}</kbd></div>)}
        <div className="shortcut-row"><span>Nudge selection</span><kbd>← ↑ ↓ →</kbd></div>
        <div className="shortcut-row"><span>Undo / redo</span><kbd>⌘/Ctrl Z</kbd></div>
        <div className="shortcut-row"><span>Close / cancel</span><kbd>Esc</kbd></div>
      </div>
    </div>
  )
}

function AlignmentBanner({ stage, preview, onConfirm, onCancel, dialogRef }: { readonly stage: AlignStage; readonly preview?: AlignPreviewState | null; readonly onConfirm?: () => void; readonly onCancel?: () => void; readonly dialogRef?: { readonly current: HTMLDivElement | null } }): ReactNode {
  if (stage === 'idle') return null
  const count = preview?.candidateCount
  const isPreview = stage === 'preview'
  const title = isPreview ? 'Align preview' : 'Confirm alignment'
  const descriptionId = isPreview ? 'align-preview-description' : 'align-confirm-description'
  const description = preview?.valid === false
    ? (preview.reason ?? 'This alignment cannot be applied.')
    : count === undefined
      ? (isPreview ? 'Review the proposed row before applying it.' : 'Review the proposed alignment before applying it.')
      : `${String(count)} panel${count === 1 ? '' : 's'} ${isPreview ? 'will move.' : 'are ready to move.'}`
  return (
    <div className="align-modal">
      <div
        ref={dialogRef}
        className="align-banner"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel?.()
            return
          }
          if (event.key === 'Tab') {
            const focusable = getDialogFocusable(event.currentTarget)
            if (focusable.length === 0) {
              event.preventDefault()
              return
            }
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            if (first === undefined || last === undefined) {
              event.preventDefault()
              return
            }
            if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
              event.preventDefault()
              first.focus()
            }
          }
        }}
      >
        <div className="align-banner__copy"><span className="align-banner__label">{title}</span><p id={descriptionId}>{description}</p></div>
        <div className="align-banner__actions">
          <button className="button button--quiet" type="button" disabled={onCancel === undefined} onClick={onCancel}>{isPreview ? 'Cancel' : 'Back'}</button>
          <button className="button button--primary" type="button" disabled={preview?.valid === false || onConfirm === undefined} onClick={onConfirm}>{isPreview ? 'Confirm align' : 'Apply alignment'}</button>
        </div>
      </div>
    </div>
  )
}

export function Shell({
  viewer,
  panelChooser,
  library,
  inspector,
  panelStatus,
  projectName,
  headerSlot,
  initialTheme,
  theme: controlledTheme,
  onThemeChange,
  cameraMode: controlledCameraMode,
  viewMode: legacyViewMode,
  initialCameraMode = '3d',
  onCameraModeChange,
  renderMode: controlledRenderMode,
  initialRenderMode = 'texture',
  onRenderModeChange,
  showGrid: controlledShowGrid,
  initialShowGrid = true,
  onShowGridChange,
  activeTool: controlledActiveTool,
  initialActiveTool = 'select',
  onToolChange,
  selectedSurface,
  selectedSurfaceEdge,
  onSurfaceEdgeChange,
  selectedPanel,
  panelOptions,
  arrays,
  selectedArrayId,
  onArraySelect,
  onArrayPanelChange,
  onAddSelectedPanel,
  placements,
  selectedPlacementIds = [],
  placementSummary,
  settings,
  settingsScopeLabel,
  onSettingsChange,
  alignStage: controlledAlignStage,
  initialAlignStage = 'idle',
  alignPreview,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onDelete,
  onMoveSelection,
  onRotateSelection,
  onDuplicateSelection,
  onDeleteArray,
  onFitView,
  onHelp,
  onLayersOpen,
  onAutoFill,
  obstacles,
  draftObstacle,
  onObstacleStart,
  onObstacleCancel,
  onObstacleChange,
  onObstacleRemove,
  onObstaclesClear,
  onAlignStart,
  onAlignConfirm,
  onAlignCancel,
  onNudgeSelection,
  nudgeStepM = 0.1,
  onImportFiles,
  onLoadSample,
  onImport,
  onImportModel,
  acceptedImportTypes = '.zip,.obj,.mtl,.jpg,.jpeg,.png',
  webglAvailable,
  statusMessage: externalStatusMessage,
  statusKind = 'default',
  className = '',
}: ShellProps): ReactNode {
  const [themeState, setThemeState] = useState<Theme>(() => getInitialTheme(initialTheme))
  const [cameraModeState, setCameraModeState] = useState<ViewMode>(initialCameraMode)
  const [renderModeState, setRenderModeState] = useState<RenderMode>(initialRenderMode)
  const [showGridState, setShowGridState] = useState(initialShowGrid)
  const [activeToolState, setActiveToolState] = useState<ToolId>(initialActiveTool)
  const [alignStageState, setAlignStageState] = useState<AlignStage>(initialAlignStage)
  const [selectedTab, setSelectedTab] = useState<InspectorTab>('panel')
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false)
  const [compactViewport, setCompactViewport] = useState(() => isCompactViewport())
  const [rightPanelOpen, setRightPanelOpen] = useState(() => !isCompactViewport())
  const [localStatus, setLocalStatus] = useState('Ready')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)
  const mobileFirstToolRef = useRef<HTMLButtonElement>(null)
  const reopenInspectorRef = useRef<HTMLButtonElement>(null)
  const panelTabRef = useRef<HTMLButtonElement>(null)
  const inspectorTabRef = useRef<HTMLButtonElement>(null)
  const alignDialogRef = useRef<HTMLDivElement>(null)
  const alignReturnFocusRef = useRef<HTMLElement | null>(null)
  const previousCompactViewportRef = useRef(compactViewport)
  const previousMobileToolsOpenRef = useRef(mobileToolsOpen)
  const previousRightPanelOpenRef = useRef(rightPanelOpen)
  // Start from idle so an initially-open controlled dialog receives focus on mount.
  const previousAlignStageRef = useRef<AlignStage>('idle')
  const detectedWebGL = useMemo(() => (webglAvailable === undefined ? supportsWebGL() : webglAvailable), [webglAvailable])
  const hasWebGL = detectedWebGL

  const theme = controlledTheme ?? themeState
  const cameraMode = controlledCameraMode ?? legacyViewMode ?? cameraModeState
  const renderMode = controlledRenderMode ?? renderModeState
  const showGrid = controlledShowGrid ?? showGridState
  const activeTool = controlledActiveTool ?? activeToolState
  const alignStage = controlledAlignStage ?? alignStageState
  const panelSlot = panelChooser ?? library
  const importHandler = onImport ?? onImportModel
  const hasImportHandler = onImportFiles !== undefined || importHandler !== undefined

  const closeMobileTools = useCallback((): void => {
    setMobileToolsOpen(false)
  }, [])
  const closeRightPanel = useCallback((): void => {
    setRightPanelOpen(false)
  }, [])

  useEffect(() => {
    const handleResize = (): void => {
      const nextCompact = isCompactViewport()
      setCompactViewport(nextCompact)
      const previousCompact = previousCompactViewportRef.current
      previousCompactViewportRef.current = nextCompact
      if (previousCompact !== nextCompact) {
        setRightPanelOpen(!nextCompact)
        setMobileToolsOpen(false)
      }
    }
    window.addEventListener('resize', handleResize)
    return () => { window.removeEventListener('resize', handleResize) }
  }, [])

  useEffect(() => {
    const previous = previousMobileToolsOpenRef.current
    previousMobileToolsOpenRef.current = mobileToolsOpen
    if (previous === mobileToolsOpen) return
    if (mobileToolsOpen) mobileFirstToolRef.current?.focus()
    else mobileMenuButtonRef.current?.focus()
  }, [mobileToolsOpen])

  useEffect(() => {
    const previous = previousRightPanelOpenRef.current
    previousRightPanelOpenRef.current = rightPanelOpen
    if (previous && !rightPanelOpen) reopenInspectorRef.current?.focus()
  }, [rightPanelOpen])

  useEffect(() => {
    // Placement keeps the catalogue visible so repeated clicks can add panels.
    // Selecting or dragging an existing array opens its inspector automatically.
    if (selectedPlacementIds.length === 0 || activeTool === 'place') return
    let current = true
    queueMicrotask(() => {
      if (!current) return
      setSelectedTab('inspector')
      setRightPanelOpen(true)
    })
    return () => { current = false }
  }, [activeTool, selectedPlacementIds])

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme
    persistTheme(theme)
  }, [theme])

  useEffect(() => {
    const previousStage = previousAlignStageRef.current
    if (previousStage === 'idle' && alignStage !== 'idle') {
      const activeElement = typeof document === 'undefined' ? null : document.activeElement
      alignReturnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null
      alignDialogRef.current?.focus()
    } else if (previousStage !== 'idle' && alignStage === 'idle') {
      alignReturnFocusRef.current?.focus()
      alignReturnFocusRef.current = null
    }
    previousAlignStageRef.current = alignStage
  }, [alignStage])

  useEffect(() => {
    if (alignStage === 'idle' || typeof document === 'undefined') return undefined
    const dialog = alignDialogRef.current
    if (dialog === null) return undefined
    const containFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && dialog.contains(event.target)) return
      const first = getDialogFocusable(dialog)[0]
      const focusTarget = first ?? dialog
      focusTarget.focus()
    }
    document.addEventListener('focusin', containFocus)
    return () => { document.removeEventListener('focusin', containFocus) }
  }, [alignStage])

  const announce = useCallback((message: string): void => { setLocalStatus(message) }, [])
  const moveSelection = useCallback((): void => {
    onMoveSelection?.()
    announce('Move array active — drag any highlighted panel')
  }, [announce, onMoveSelection])
  const rotateSelection = useCallback((): void => {
    onRotateSelection?.()
    announce('Array rotated 90 degrees')
  }, [announce, onRotateSelection])
  const handleThemeChange = useCallback((): void => {
    const next = theme === 'light' ? 'dark' : 'light'
    if (controlledTheme === undefined) setThemeState(next)
    onThemeChange?.(next)
  }, [controlledTheme, onThemeChange, theme])
  const handleImportClick = useCallback((): void => {
    if (!hasImportHandler) return
    fileInputRef.current?.click()
  }, [hasImportHandler])
  const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const selected = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (selected.length === 0 || !hasImportHandler) return

    const files: readonly File[] = Object.freeze(selected.slice())
    const first = files[0]
    if (onImportFiles !== undefined) onImportFiles(files)
    else if (first !== undefined) importHandler?.(first)

    const names = files.map((file) => file.name).join(', ')
    announce(`Selected ${String(files.length)} file${files.length === 1 ? '' : 's'}: ${names}`)
  }, [announce, hasImportHandler, importHandler, onImportFiles])
  const focusInspectorTab = useCallback((tab: InspectorTab): void => {
    setSelectedTab(tab)
    const target = tab === 'panel' ? panelTabRef.current : inspectorTabRef.current
    target?.focus()
  }, [])
  const handleInspectorTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const currentTab: InspectorTab = event.currentTarget.id === 'inspector-tab' ? 'inspector' : 'panel'
    const currentIndex = INSPECTOR_TABS.indexOf(currentTab)
    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % INSPECTOR_TABS.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = INSPECTOR_TABS.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const nextTab = INSPECTOR_TABS[nextIndex]
    if (nextTab !== undefined) focusInspectorTab(nextTab)
  }, [focusInspectorTab])
  const setCameraMode = useCallback((next: ViewMode): void => {
    if (controlledCameraMode === undefined && legacyViewMode === undefined) setCameraModeState(next)
    onCameraModeChange?.(next)
    announce(next === '3d' ? '3D perspective view' : '2D plan view')
  }, [announce, controlledCameraMode, legacyViewMode, onCameraModeChange])
  const setRenderMode = useCallback((next: RenderMode): void => {
    if (controlledRenderMode === undefined) setRenderModeState(next)
    onRenderModeChange?.(next)
    announce(next === 'texture' ? 'Textured render mode' : 'Wireframe render mode')
  }, [announce, controlledRenderMode, onRenderModeChange])
  const setGrid = useCallback((): void => {
    const next = !showGrid
    if (controlledShowGrid === undefined) setShowGridState(next)
    onShowGridChange?.(next)
    announce(next ? 'Layout grid shown' : 'Layout grid hidden')
  }, [announce, controlledShowGrid, onShowGridChange, showGrid])
  const activateTool = useCallback((next: ToolId): void => {
    if (next === 'align' && onAlignStart === undefined) return
    if (next === 'autofill' && onAutoFill === undefined) return
    if (next === 'obstacle' && (onObstacleStart === undefined || selectedSurface === undefined || selectedSurface === null)) return
    if (controlledActiveTool === undefined) setActiveToolState(next)
    onToolChange?.(next)
    if (next === 'align') {
      if (controlledAlignStage === undefined) setAlignStageState('preview')
      onAlignStart?.()
    }
    if (next === 'autofill') onAutoFill?.()
    if (next === 'obstacle') onObstacleStart?.()
    announce(TOOL_DEFINITIONS.find((tool) => tool.id === next)?.description ?? 'Tool selected')
  }, [announce, controlledActiveTool, controlledAlignStage, onAlignStart, onAutoFill, onObstacleStart, onToolChange, selectedSurface])
  const cancelObstacle = useCallback((): void => {
    onObstacleCancel?.()
    if (controlledActiveTool === undefined) setActiveToolState('select')
    onToolChange?.('select')
    announce('Obstacle drawing cancelled')
  }, [announce, controlledActiveTool, onObstacleCancel, onToolChange])
  const cancelAlign = useCallback((): void => {
    if (controlledAlignStage === undefined) setAlignStageState('idle')
    onAlignCancel?.()
    announce('Align preview cancelled')
  }, [announce, controlledAlignStage, onAlignCancel])
  const confirmAlign = useCallback((): void => {
    onAlignConfirm?.()
    if (controlledAlignStage === undefined) setAlignStageState('idle')
    announce('Alignment applied')
  }, [announce, controlledAlignStage, onAlignConfirm])
  const deleteSelection = useCallback((): void => {
    if (selectedPlacementIds.length === 0 || onDelete === undefined) return
    onDelete(selectedPlacementIds)
    announce(`${String(selectedPlacementIds.length)} selected panel${selectedPlacementIds.length === 1 ? '' : 's'} deleted`)
  }, [announce, onDelete, selectedPlacementIds])

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      // Escape always cancels obstacle drawing, even when focus is in an
      // inspector field. Other shortcuts remain protected from text entry.
      if (key === 'escape' && activeTool === 'obstacle') {
        event.preventDefault()
        setShortcutsOpen(false)
        closeMobileTools()
        if (compactViewport && rightPanelOpen) closeRightPanel()
        cancelObstacle()
        return
      }
      if (isEditableTarget(event.target)) return
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && key === 'z') {
        const undo = !event.shiftKey && canUndo && onUndo !== undefined
        const redo = event.shiftKey && canRedo && onRedo !== undefined
        if (undo || redo) {
          event.preventDefault()
          if (redo) onRedo()
          else onUndo?.()
        }
        return
      }
      if (modifier && key === 'y') {
        if (canRedo && onRedo !== undefined) {
          event.preventDefault()
          onRedo()
        }
        return
      }
      if ((key === 'delete' || key === 'backspace') && onDelete !== undefined && selectedPlacementIds.length > 0) {
        event.preventDefault()
        deleteSelection()
        return
      }
      if (key === 'escape') { setShortcutsOpen(false); closeMobileTools(); if (compactViewport && rightPanelOpen) closeRightPanel(); if (activeTool === 'obstacle') cancelObstacle(); if (alignStage !== 'idle') cancelAlign(); return }
      if (key === '?') { event.preventDefault(); setShortcutsOpen((open) => !open); return }
      const nudge: Record<string, Point2> = { arrowup: { x: 0, y: nudgeStepM }, arrowdown: { x: 0, y: -nudgeStepM }, arrowleft: { x: -nudgeStepM, y: 0 }, arrowright: { x: nudgeStepM, y: 0 } }
      const delta = nudge[key]
      if (delta !== undefined && onNudgeSelection !== undefined) { event.preventDefault(); onNudgeSelection(delta); return }
      const shortcut = TOOL_DEFINITIONS.find((tool) => tool.shortcut.toLowerCase() === key)
      if (shortcut !== undefined) { event.preventDefault(); activateTool(shortcut.id) }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => { window.removeEventListener('keydown', handleKeyDown); }
  }, [activateTool, activeTool, alignStage, canRedo, canUndo, cancelAlign, cancelObstacle, closeMobileTools, closeRightPanel, compactViewport, deleteSelection, nudgeStepM, onDelete, onNudgeSelection, onRedo, onUndo, rightPanelOpen, selectedPlacementIds.length])

  const handleViewerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateTool('select'); announce('Surface selection active') }
  }, [activateTool, announce])

  const viewerContent = hasWebGL ? (viewer ?? <ViewerPlaceholder onImport={hasImportHandler ? handleImportClick : undefined} onLoadSample={onLoadSample} acceptedTypeHint={formatAcceptedImportTypes(acceptedImportTypes)} />) : <WebGLFallback />
  const summary = placementSummary ?? (placements === undefined ? undefined : { count: placements.length, selectedCount: selectedPlacementIds.length, previewCount: 0, draggingCount: 0 })

  return (
    <div className={`pv-shell pv-shell--${theme} ${className}`.trim()} data-testid="pv-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <button ref={mobileMenuButtonRef} className="mobile-menu-button icon-button" type="button" aria-label={mobileToolsOpen ? 'Close design tools' : 'Open design tools'} aria-expanded={mobileToolsOpen} aria-controls="design-tools" onClick={() => { setMobileToolsOpen((open) => !open); }}><Menu size={18} aria-hidden="true" /></button>
          <span className="brand-mark" aria-hidden="true"><Sun size={17} strokeWidth={2.1} /></span><h1>PV Studio</h1><span className="brand-divider" aria-hidden="true" />
          {projectName === undefined ? <span className="brand-context">Design workspace</span> : <span className="brand-context">{projectName}</span>}
        </div>
        <div className="topbar__actions">
          <input ref={fileInputRef} className="sr-only" type="file" accept={acceptedImportTypes} multiple aria-label="Import site model" tabIndex={-1} disabled={!hasImportHandler} onChange={handleFileChange} />
          <button className="topbar-action topbar-action--import" type="button" disabled={!hasImportHandler} onClick={handleImportClick}><Upload size={15} aria-hidden="true" /><span>Import</span></button>
          {onLoadSample === undefined ? null : <>
            <span id="sample-description" className="sr-only">Lightweight Demo stays in this browser. Try sample loads the WebODM house only after you click.</span>
            <button className="topbar-action topbar-action--sample" type="button" onClick={onLoadSample} aria-label="Try WebODM sample" aria-describedby="sample-description" data-testid="load-sample-model"><Sparkles size={15} aria-hidden="true" /><span>Try sample</span></button>
          </>}
          <ShellErrorBoundary area="header actions" resetKey={headerSlot ?? 'empty-header'}>{headerSlot}</ShellErrorBoundary>
          {onHelp === undefined ? null : <button className="icon-button" type="button" aria-label="Help and documentation" title="Help and documentation" onClick={onHelp}><CircleHelp size={17} aria-hidden="true" /></button>}
          <button className="icon-button" type="button" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={handleThemeChange}>{theme === 'light' ? <Moon size={17} aria-hidden="true" /> : <Sun size={17} aria-hidden="true" />}</button>
        </div>
      </header>

      <div className="workspace-layout">
        <aside id="design-tools" className={`tool-rail${mobileToolsOpen ? ' tool-rail--mobile-open' : ''}`} aria-label="Design tools" aria-hidden={compactViewport && !mobileToolsOpen} inert={compactViewport && !mobileToolsOpen}>
          <div className="tool-rail__section"><p className="tool-rail__label">Tools</p><nav className="tool-nav" aria-label="Placement tools">
            {TOOL_DEFINITIONS.map((tool, index) => { const Icon = tool.icon; const isActive = activeTool === tool.id; const unavailable = (tool.id === 'align' && onAlignStart === undefined) || (tool.id === 'autofill' && onAutoFill === undefined) || (tool.id === 'obstacle' && (onObstacleStart === undefined || selectedSurface === undefined || selectedSurface === null)); return <button ref={index === 0 ? mobileFirstToolRef : undefined} className={`tool-button${isActive ? ' tool-button--active' : ''}`} type="button" key={tool.id} aria-label={tool.label} aria-pressed={isActive} title={`${tool.label} (${tool.shortcut})`} disabled={unavailable} onClick={() => { activateTool(tool.id); }}><Icon size={18} strokeWidth={isActive ? 2.1 : 1.75} aria-hidden="true" /><span>{tool.label}</span><kbd>{tool.shortcut}</kbd></button> })}
          </nav></div>
          <div className="tool-rail__bottom">{onLayersOpen === undefined ? null : <button className="tool-button tool-button--muted" type="button" title="Project layers" aria-label="Project layers" onClick={onLayersOpen}><Layers3 size={18} strokeWidth={1.75} aria-hidden="true" /><span>Layers</span></button>}<button className="tool-button tool-button--muted" type="button" title="Workspace preferences" onClick={() => { setSelectedTab('inspector'); setRightPanelOpen(true); }}><SlidersHorizontal size={18} strokeWidth={1.75} aria-hidden="true" /><span>Preferences</span></button></div>
        </aside>

        <main className="design-stage" aria-label="Design workspace">
          <div className="stage-toolbar">
            <div className="stage-toolbar__group" role="group" aria-label="Camera mode"><button className={`view-toggle${cameraMode === '3d' ? ' view-toggle--active' : ''}`} type="button" aria-pressed={cameraMode === '3d'} onClick={() => { setCameraMode('3d'); }}><Move3d size={14} aria-hidden="true" />3D</button><button className={`view-toggle${cameraMode === '2d' ? ' view-toggle--active' : ''}`} type="button" aria-pressed={cameraMode === '2d'} onClick={() => { setCameraMode('2d'); }}><PanelTop size={14} aria-hidden="true" />2D plan</button></div>
            <div className="stage-toolbar__group" role="group" aria-label="Render mode"><button className={`view-toggle${renderMode === 'texture' ? ' view-toggle--active' : ''}`} type="button" aria-pressed={renderMode === 'texture'} onClick={() => { setRenderMode('texture'); }}>Texture</button><button className={`view-toggle${renderMode === 'wireframe' ? ' view-toggle--active' : ''}`} type="button" aria-pressed={renderMode === 'wireframe'} onClick={() => { setRenderMode('wireframe'); }}>Wire</button></div>
            <div className="stage-toolbar__group stage-toolbar__group--right"><button className={`stage-icon-button${showGrid ? ' stage-icon-button--active' : ''}`} type="button" aria-pressed={showGrid} aria-label={`${showGrid ? 'Hide' : 'Show'} layout grid`} title={`${showGrid ? 'Hide' : 'Show'} layout grid`} onClick={setGrid}><Grid2X2 size={16} aria-hidden="true" /></button>{onFitView === undefined ? null : <button className="stage-icon-button" type="button" aria-label="Fit model to view" title="Fit model to view" onClick={onFitView}><Maximize2 size={16} aria-hidden="true" /></button>}<span className="toolbar-divider" aria-hidden="true" /><button className="stage-icon-button" type="button" aria-label="Undo" title="Undo" disabled={!canUndo || onUndo === undefined} onClick={onUndo}><Redo2 size={16} className="icon-flip-x" aria-hidden="true" /></button><button className="stage-icon-button" type="button" aria-label="Redo" title="Redo" disabled={!canRedo || onRedo === undefined} onClick={onRedo}><Redo2 size={16} aria-hidden="true" /></button></div>
          </div>

          <div className={`viewer-frame viewer-frame--${cameraMode}${showGrid && cameraMode === '2d' ? ' viewer-frame--grid' : ''}${alignStage !== 'idle' ? ' viewer-frame--align-preview' : ''}`}>
            <div className="viewer-frame__canvas" tabIndex={0} role="region" aria-label={`${cameraMode === '3d' ? '3D' : '2D'} site viewer. Drag to orbit, scroll or pinch to zoom, and shift-drag or two-finger drag to pan. Press Enter to select a surface.`} onKeyDown={handleViewerKeyDown}><ShellErrorBoundary area="site viewer" resetKey={viewer ?? (hasWebGL ? `placeholder:${acceptedImportTypes}:${hasImportHandler ? 'ready' : 'disabled'}` : 'webgl-fallback')}>{viewerContent}</ShellErrorBoundary></div>
            {externalStatusMessage === undefined || statusKind === 'default' ? null : (
              <div
                className={`viewer-import-status viewer-import-status--${statusKind}`}
                role={statusKind === 'error' ? 'alert' : 'status'}
                aria-label={statusKind === 'error' ? 'Import failed' : 'Preparing site model'}
                aria-live={statusKind === 'error' ? 'assertive' : 'polite'}
              >
                {statusKind === 'error'
                  ? <AlertTriangle size={20} aria-hidden="true" />
                  : <span className="viewer-import-status__spinner" aria-hidden="true" />}
                <span className="viewer-import-status__copy">
                  <strong>{statusKind === 'error' ? 'Import failed' : 'Opening site model'}</strong>
                  <span>{externalStatusMessage}</span>
                  {statusKind === 'error' ? <small>Choose Import to try another file.</small> : <small>Large WebODM archives can take a few minutes to unpack.</small>}
                </span>
              </div>
            )}
            <div className="viewer-overlay viewer-overlay--top-left"><span className="view-status"><span className="view-status__dot" aria-hidden="true" />{cameraMode === '3d' ? 'Perspective' : 'Top-down plan'}</span><span className="view-status view-status--secondary">{renderMode === 'texture' ? 'Textured' : 'Wireframe'}</span></div>
            <div className="viewer-overlay viewer-overlay--top-right viewer-navigation-hint" role="note">Drag to orbit · wheel/pinch to zoom · shift-drag/two fingers to pan</div>
            {onLoadSample !== undefined && projectName === undefined ? <div className="viewer-onboarding" role="note"><p className="eyebrow">Lightweight Demo</p><p>Demo stays in this browser. Use the <strong>Try WebODM sample</strong> action when you want to load a textured house. Nothing downloads until you choose it.</p></div> : null}
            {activeTool === 'obstacle' ? <div className="viewer-overlay viewer-overlay--bottom-right obstacle-drawing-hint" role="status" aria-live="polite">Drag empty surface to draw an obstacle (minimum 0.05 m), or drag an existing obstacle to move it. Press <kbd>Esc</kbd> to cancel.</div> : null}
            {selectedSurface === undefined || selectedSurface === null ? null : <div className="viewer-overlay viewer-overlay--bottom-left"><span className="surface-chip"><span className="surface-chip__swatch" aria-hidden="true" />{selectedSurface.label ?? selectedSurface.id}<span className="surface-chip__muted">· {formatArea(selectedSurface.area)}</span></span></div>}
            <AlignmentBanner stage={alignStage} preview={alignPreview} onConfirm={onAlignConfirm === undefined ? undefined : confirmAlign} onCancel={controlledAlignStage !== undefined && onAlignCancel === undefined ? undefined : cancelAlign} dialogRef={alignDialogRef} />
          </div>

          <div className="stage-footer"><div className="stage-footer__hint"><Keyboard size={14} aria-hidden="true" /><span>Press <kbd>?</kbd> for shortcuts</span></div><div className="stage-footer__actions"><button className="stage-footer__action" type="button" aria-label="Undo last action" disabled={!canUndo || onUndo === undefined} onClick={onUndo}><Redo2 className="icon-flip-x" size={14} aria-hidden="true" />Undo</button><button className="stage-footer__action" type="button" aria-label="Redo last action" disabled={!canRedo || onRedo === undefined} onClick={onRedo}><Redo2 size={14} aria-hidden="true" />Redo</button>{onDelete === undefined ? null : <button className="stage-footer__action stage-footer__action--danger" type="button" aria-label="Delete selected panels" disabled={selectedPlacementIds.length === 0} onClick={deleteSelection}><X size={14} aria-hidden="true" />Delete</button>}</div></div>
        </main>

        {rightPanelOpen ? <button className="inspector-backdrop" type="button" aria-label="Dismiss side panel" onClick={closeRightPanel} /> : null}
        <aside id="workspace-side-panel" className={`inspector-panel${rightPanelOpen ? ' inspector-panel--open' : ''}`} aria-label="Panel library and inspector" aria-hidden={!rightPanelOpen} inert={!rightPanelOpen}>
          <div className="inspector-tabs" role="tablist" aria-orientation="horizontal" aria-label="Workspace side panel"><button ref={panelTabRef} className={`inspector-tab${selectedTab === 'panel' ? ' inspector-tab--active' : ''}`} id="panel-tab" type="button" role="tab" aria-selected={selectedTab === 'panel'} aria-controls="panel-panel" tabIndex={selectedTab === 'panel' ? 0 : -1} onKeyDown={handleInspectorTabKeyDown} onClick={() => { setSelectedTab('panel'); }}><PanelsTopLeft size={15} aria-hidden="true" />Panel</button><button ref={inspectorTabRef} className={`inspector-tab${selectedTab === 'inspector' ? ' inspector-tab--active' : ''}`} id="inspector-tab" type="button" role="tab" aria-selected={selectedTab === 'inspector'} aria-controls="inspector-panel" tabIndex={selectedTab === 'inspector' ? 0 : -1} onKeyDown={handleInspectorTabKeyDown} onClick={() => { setSelectedTab('inspector'); }}><Settings2 size={15} aria-hidden="true" />Inspector</button>{selectedTab !== 'inspector' || onAddSelectedPanel === undefined ? null : <button className="inspector-add-panel" type="button" aria-label="+ Panel" onClick={onAddSelectedPanel}><Plus size={14} aria-hidden="true" />Panel</button>}<button className="inspector-close icon-button icon-button--small" type="button" aria-label="Close side panel" onClick={closeRightPanel}><X size={15} aria-hidden="true" /></button></div>
          <div className="inspector-panel__body">{selectedTab === 'panel' ? <div id="panel-panel" role="tabpanel" aria-labelledby="panel-tab"><ShellErrorBoundary area="panel library" resetKey={panelSlot ?? `empty-library:${hasImportHandler ? 'ready' : 'disabled'}`}>{panelSlot ?? <EmptySlot label="Panel library" action={hasImportHandler ? 'Import site model' : undefined} onAction={hasImportHandler ? handleImportClick : undefined} />}</ShellErrorBoundary></div> : <div id="inspector-panel" role="tabpanel" aria-labelledby="inspector-tab"><ShellErrorBoundary area="inspector" resetKey={inspector ?? settingsScopeLabel ?? settings ?? selectedSurface ?? selectedSurfaceEdge ?? selectedPanel ?? summary ?? obstacles ?? 'fallback-inspector'}>{inspector ?? <InspectorFallback selectedSurface={selectedSurface} selectedSurfaceEdge={selectedSurfaceEdge} onSurfaceEdgeChange={onSurfaceEdgeChange} selectedPanel={selectedPanel} panelOptions={panelOptions} arrays={arrays} selectedArrayId={selectedArrayId} onArraySelect={onArraySelect} onArrayPanelChange={onArrayPanelChange} settings={settings} settingsScopeLabel={settingsScopeLabel} onSettingsChange={onSettingsChange} selectedCount={selectedPlacementIds.length} onMoveSelection={onMoveSelection === undefined ? undefined : moveSelection} onRotateSelection={onRotateSelection === undefined ? undefined : rotateSelection} onDuplicateSelection={onDuplicateSelection} onDeleteArray={onDeleteArray} placementSummary={summary} onAutoFill={onAutoFill} obstacles={obstacles} draftObstacle={draftObstacle} onObstacleChange={onObstacleChange} onObstacleRemove={onObstacleRemove} onObstaclesClear={onObstaclesClear} />}</ShellErrorBoundary>{panelStatus === undefined ? null : <div className="panel-status-slot"><ShellErrorBoundary area="panel status" resetKey={panelStatus}>{panelStatus}</ShellErrorBoundary></div>}{panelStatus === undefined && summary === undefined ? null : panelStatus === undefined ? <div className="panel-status-slot"><PlacementSummary summary={summary as PanelPlacementSummary} /></div> : null}</div>}</div>
        </aside>
        {!rightPanelOpen ? <button ref={reopenInspectorRef} className="reopen-inspector" type="button" aria-controls="workspace-side-panel" aria-expanded={rightPanelOpen} onClick={() => { setRightPanelOpen(true); }}><PanelTop size={15} aria-hidden="true" />Open panel</button> : null}
      </div>

      <footer className="statusbar" aria-label="Workspace status"><div className="statusbar__left" role="status" aria-live="polite"><span className="connection-indicator"><span aria-hidden="true" />Local workspace</span><span className="statusbar-divider" aria-hidden="true" />{externalStatusMessage ?? localStatus}</div><div className="statusbar__right"><span>Metric units</span><span className="statusbar-divider" aria-hidden="true" /><button type="button" onClick={() => { setShortcutsOpen(true); }}><Keyboard size={13} aria-hidden="true" />Shortcuts</button></div></footer>
      {shortcutsOpen ? <KeyboardShortcuts onClose={() => { setShortcutsOpen(false); }} /> : null}
    </div>
  )
}
