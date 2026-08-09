import {
  AlertTriangle,
  ArrowDownToLine,
  Box,
  Check,
  CircleHelp,
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
  Rotate3d,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
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
} from '../core'
import { supportsWebGL } from './webgl'

export type Theme = 'light' | 'dark'
export type ToolId = 'select' | 'place' | 'obstacle' | 'autofill' | 'align' | 'orbit' | 'measure'
export type ViewMode = '3d' | '2d'
export type RenderMode = 'texture' | 'wireframe'
export type InspectorTab = 'panel' | 'inspector'
export type AlignStage = 'idle' | 'preview' | 'confirm'

/** A display-ready surface summary. SurfaceDescriptor is structurally compatible. */
export type ShellSurface = Pick<SurfaceDescriptor, 'id' | 'area' | 'usableArea' | 'azimuthDeg' | 'tiltDeg'> & {
  readonly label?: string
}

/** The minimum panel data the shell may display. Panel catalogues stay in PanelChooser. */
export type ShellPanel = Pick<PanelDefinition, 'id' | 'manufacturer' | 'model' | 'wattageW'> & {
  readonly efficiencyPct?: number
}

export interface PanelPlacementSummary {
  readonly count: number
  readonly selectedCount: number
  readonly previewCount: number
  readonly draggingCount: number
  readonly totalWattageW?: number
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
  readonly selectedPanel?: ShellPanel | null
  readonly placements?: readonly PanelPlacement[]
  readonly selectedPlacementIds?: readonly string[]
  readonly placementSummary?: PanelPlacementSummary
  readonly settings?: PanelGroupSettings
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
  /** Optional host actions for the shell's utility controls. */
  readonly onFitView?: () => void
  readonly onHelp?: () => void
  readonly onLayersOpen?: () => void
  readonly onAutoFill?: () => void
  readonly obstacles?: readonly RectangularObstacle[]
  readonly draftObstacle?: RectangularObstacle | null
  readonly onObstacleStart?: () => void
  readonly onObstacleCancel?: () => void
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
  readonly className?: string
}

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
  { id: 'obstacle', label: 'Obstacle', shortcut: 'B', description: 'Draw a rectangular obstacle — drag on the active surface (minimum 0.05 m). Press Escape to cancel', icon: Square },
  { id: 'autofill', label: 'Auto-fill', shortcut: 'A', description: 'Preview a filled layout', icon: Sparkles },
  { id: 'align', label: 'Align', shortcut: 'L', description: 'Align selected panels in a preview', icon: Layers3 },
  { id: 'orbit', label: 'Orbit', shortcut: 'O', description: 'Orbit the 3D view', icon: Rotate3d },
  { id: 'measure', label: 'Measure', shortcut: 'M', description: 'Measure between two points', icon: SlidersHorizontal },
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
        <p>{onImport === undefined ? 'Connect an importer to begin placing panels.' : 'Load a model or texture file to begin placing panels.'}</p>
        {onImport === undefined ? null : <button className="button button--quiet" type="button" onClick={onImport}><FileUp size={16} aria-hidden="true" />Import site model</button>}
        {onLoadSample === undefined ? null : <button className="button button--primary" type="button" onClick={onLoadSample} data-testid="load-sample-model"><Sparkles size={16} aria-hidden="true" />Load sample WebODM house</button>}
        <span className="viewer-placeholder__hint">{acceptedTypeHint}</span>
      </div>
    </div>
  )
}

function SurfaceSummary({ surface }: { readonly surface: ShellSurface }): ReactNode {
  return (
    <section className="inspector-card inspector-card--surface" aria-labelledby="surface-summary-title">
      <div className="inspector-card__title-row"><h3 id="surface-summary-title">Surface summary</h3><span className="surface-status"><span aria-hidden="true" />Active</span></div>
      <dl className="metric-grid">
        <div><dt>Area</dt><dd>{formatArea(surface.area)}</dd></div>
        <div><dt>Azimuth</dt><dd>{formatDegrees(surface.azimuthDeg)}</dd></div>
        <div><dt>Tilt</dt><dd>{formatDegrees(surface.tiltDeg)}</dd></div>
        <div><dt>Usable</dt><dd>{formatArea(surface.usableArea)}</dd></div>
      </dl>
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

function SettingsSummary({ settings, onChange }: { readonly settings: PanelGroupSettings; readonly onChange?: (patch: Partial<PanelGroupSettings>) => void }): ReactNode {
  const disabled = onChange === undefined
  const change = (patch: Partial<PanelGroupSettings>): void => { onChange?.(patch) }
  const changeNumber = (key: 'setbackM' | 'interPanelSpacingM' | 'rowSpacingM' | 'clearanceM' | 'tiltDeg', rawValue: string): void => {
    const value = parseFiniteInput(rawValue)
    if (value === undefined) return
    if (key === 'clearanceM' && value < 0) return
    if (key === 'tiltDeg' && (value < 0 || value > 90)) return
    change({ [key]: value })
  }
  return (
    <section className="inspector-card" aria-labelledby="layout-settings-title">
      <div className="inspector-card__title-row"><h3 id="layout-settings-title">Array settings</h3><Settings2 size={15} aria-hidden="true" /></div>
      <label className="setting-row"><span>Orientation</span><select value={settings.orientation} disabled={disabled} aria-label="Panel orientation" onChange={(event) => { change({ orientation: event.currentTarget.value as Orientation }); }}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
      <label className="setting-row"><span>Edge setback</span><span className="input-with-unit"><input type="number" min={0} step={0.01} value={numericInputValue(settings.setbackM)} disabled={disabled} aria-label="Edge setback in metres" onChange={(event) => { changeNumber('setbackM', event.currentTarget.value) }} /><small>m</small></span></label>
      <label className="setting-row"><span>Panel spacing</span><span className="input-with-unit"><input type="number" min={0} step={0.01} value={numericInputValue(settings.interPanelSpacingM)} disabled={disabled} aria-label="Panel spacing in metres" onChange={(event) => { changeNumber('interPanelSpacingM', event.currentTarget.value) }} /><small>m</small></span></label>
      <label className="setting-row"><span>Row spacing</span><span className="input-with-unit"><input type="number" min={0} step={0.01} value={numericInputValue(settings.rowSpacingM)} disabled={disabled} aria-label="Row spacing in metres" onChange={(event) => { changeNumber('rowSpacingM', event.currentTarget.value) }} /><small>m</small></span></label>
      <label className="setting-row"><span>Clearance</span><span className="input-with-unit"><input type="number" min={0} step={0.01} value={numericInputValue(settings.clearanceM)} disabled={disabled} aria-label="Panel clearance in metres" onChange={(event) => { changeNumber('clearanceM', event.currentTarget.value) }} /><small>m</small></span></label>
      <label className="setting-row"><span>Tilt</span><span className="input-with-unit"><input type="number" min={0} max={90} step={1} value={numericInputValue(settings.tiltDeg)} disabled={disabled} aria-label="Panel tilt in degrees" onChange={(event) => { changeNumber('tiltDeg', event.currentTarget.value) }} /><small>°</small></span></label>
      <p className="inspector-note"><SlidersHorizontal size={13} aria-hidden="true" /> Setback {formatMillimetres(settings.setbackM)} · row {formatMillimetres(settings.rowSpacingM)}</p>
    </section>
  )
}

function PlacementSummary({ summary }: { readonly summary: PanelPlacementSummary }): ReactNode {
  return (
    <section className="inspector-card inspector-card--status" aria-labelledby="placement-summary-title">
      <div className="inspector-card__title-row"><h3 id="placement-summary-title">Array status</h3><span className="status-dot" aria-hidden="true" /></div>
      <dl className="metric-grid metric-grid--two">
        <div><dt>Panels</dt><dd>{String(summary.count)}</dd></div>
        <div><dt>Selected</dt><dd>{String(summary.selectedCount)}</dd></div>
        <div><dt>Preview</dt><dd>{String(summary.previewCount)}</dd></div>
        <div><dt>Dragging</dt><dd>{String(summary.draggingCount)}</dd></div>
      </dl>
      {summary.totalWattageW === undefined ? null : <p className="inspector-note"><ZapIcon aria-hidden={true} /> {String(summary.totalWattageW)} W nominal</p>}
    </section>
  )
}

function ZapIcon({ 'aria-hidden': ariaHidden }: { readonly 'aria-hidden'?: boolean }): ReactNode {
  return <span className="inline-icon" aria-hidden={ariaHidden}>⚡</span>
}

function ObstacleSummary({ obstacles, draftObstacle, onRemove, onClear }: { readonly obstacles: readonly RectangularObstacle[]; readonly draftObstacle?: RectangularObstacle | null; readonly onRemove?: (id: string) => void; readonly onClear?: () => void }): ReactNode {
  return (
    <section className="inspector-card" aria-labelledby="obstacle-summary-title">
      <div className="inspector-card__title-row"><h3 id="obstacle-summary-title">Surface obstacles</h3><span className="surface-status"><span aria-hidden="true" />{String(obstacles.length)}</span></div>
      {draftObstacle === null || draftObstacle === undefined ? null : <p className="inspector-note" role="status">Drawing obstacle · {draftObstacle.width.toFixed(2)} × {draftObstacle.height.toFixed(2)} m</p>}
      {obstacles.length === 0 ? <p className="inspector-note">No obstacles on this surface.</p> : <ul className="obstacle-list">{obstacles.map((obstacle) => <li key={obstacle.id} className="obstacle-list__item"><span>{obstacle.width.toFixed(2)} × {obstacle.height.toFixed(2)} m</span><button className="icon-button icon-button--small" type="button" aria-label={`Remove obstacle ${obstacle.id}`} disabled={onRemove === undefined} onClick={() => { onRemove?.(obstacle.id) }}><X size={13} aria-hidden="true" /></button></li>)}</ul>}
      {onClear === undefined ? null : <button className="button button--quiet button--full" type="button" disabled={obstacles.length === 0} onClick={onClear}>Clear all obstacles</button>}
    </section>
  )
}

function InspectorFallback({ selectedSurface, selectedPanel, settings, onSettingsChange, placementSummary, onAutoFill, obstacles, draftObstacle, onObstacleRemove, onObstaclesClear }: { readonly selectedSurface?: ShellSurface | null; readonly selectedPanel?: ShellPanel | null; readonly settings?: PanelGroupSettings; readonly onSettingsChange?: (patch: Partial<PanelGroupSettings>) => void; readonly placementSummary?: PanelPlacementSummary; readonly onAutoFill?: () => void; readonly obstacles?: readonly RectangularObstacle[]; readonly draftObstacle?: RectangularObstacle | null; readonly onObstacleRemove?: (id: string) => void; readonly onObstaclesClear?: () => void }): ReactNode {
  if (selectedSurface === undefined && selectedPanel === undefined && settings === undefined && placementSummary === undefined && obstacles === undefined) return <EmptySlot label="Inspector" />
  return (
    <div className="inspector-content">
      <div className="inspector-heading"><div><p className="eyebrow">Inspector</p><h2>{selectedSurface?.label ?? 'Selection'}</h2></div><span className="surface-status"><span aria-hidden="true" />Active</span></div>
      {selectedSurface === null ? <EmptySlot label="Surface" /> : selectedSurface === undefined ? null : <SurfaceSummary surface={selectedSurface} />}
      {selectedPanel === null ? null : selectedPanel === undefined ? null : <PanelSummary panel={selectedPanel} />}
      {settings === undefined ? null : <SettingsSummary settings={settings} onChange={onSettingsChange} />}
      {placementSummary === undefined ? null : <PlacementSummary summary={placementSummary} />}
      {obstacles === undefined ? null : <ObstacleSummary obstacles={obstacles} draftObstacle={draftObstacle} onRemove={onObstacleRemove} onClear={onObstaclesClear} />}
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
  selectedPanel,
  placements,
  selectedPlacementIds = [],
  placementSummary,
  settings,
  onSettingsChange,
  alignStage: controlledAlignStage,
  initialAlignStage = 'idle',
  alignPreview,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onDelete,
  onFitView,
  onHelp,
  onLayersOpen,
  onAutoFill,
  obstacles,
  draftObstacle,
  onObstacleStart,
  onObstacleCancel,
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
  acceptedImportTypes = '.obj,.mtl,.jpg,.jpeg,.png',
  webglAvailable,
  statusMessage: externalStatusMessage,
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
  const [rightPanelOpen, setRightPanelOpen] = useState(() => !isCompactViewport())
  const [localStatus, setLocalStatus] = useState('Ready')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const panelTabRef = useRef<HTMLButtonElement>(null)
  const inspectorTabRef = useRef<HTMLButtonElement>(null)
  const alignDialogRef = useRef<HTMLDivElement>(null)
  const alignReturnFocusRef = useRef<HTMLElement | null>(null)
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
        setMobileToolsOpen(false)
        if (rightPanelOpen) setRightPanelOpen(false)
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
      if (key === 'escape') { setShortcutsOpen(false); setMobileToolsOpen(false); if (rightPanelOpen) setRightPanelOpen(false); if (activeTool === 'obstacle') cancelObstacle(); if (alignStage !== 'idle') cancelAlign(); return }
      if (key === '?') { event.preventDefault(); setShortcutsOpen((open) => !open); return }
      const nudge: Record<string, Point2> = { arrowup: { x: 0, y: nudgeStepM }, arrowdown: { x: 0, y: -nudgeStepM }, arrowleft: { x: -nudgeStepM, y: 0 }, arrowright: { x: nudgeStepM, y: 0 } }
      const delta = nudge[key]
      if (delta !== undefined && onNudgeSelection !== undefined) { event.preventDefault(); onNudgeSelection(delta); return }
      const shortcut = TOOL_DEFINITIONS.find((tool) => tool.shortcut.toLowerCase() === key)
      if (shortcut !== undefined) { event.preventDefault(); activateTool(shortcut.id) }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => { window.removeEventListener('keydown', handleKeyDown); }
  }, [activateTool, activeTool, alignStage, canRedo, canUndo, cancelAlign, cancelObstacle, deleteSelection, nudgeStepM, onDelete, onNudgeSelection, onRedo, onUndo, rightPanelOpen, selectedPlacementIds.length])

  const handleViewerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateTool('select'); announce('Surface selection active') }
  }, [activateTool, announce])

  const viewerContent = hasWebGL ? (viewer ?? <ViewerPlaceholder onImport={hasImportHandler ? handleImportClick : undefined} onLoadSample={onLoadSample} acceptedTypeHint={formatAcceptedImportTypes(acceptedImportTypes)} />) : <WebGLFallback />
  const summary = placementSummary ?? (placements === undefined ? undefined : { count: placements.length, selectedCount: selectedPlacementIds.length, previewCount: 0, draggingCount: 0 })

  return (
    <div className={`pv-shell pv-shell--${theme} ${className}`.trim()} data-testid="pv-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <button className="mobile-menu-button icon-button" type="button" aria-label="Open design tools" aria-expanded={mobileToolsOpen} onClick={() => { setMobileToolsOpen((open) => !open); }}><Menu size={18} aria-hidden="true" /></button>
          <span className="brand-mark" aria-hidden="true"><Sun size={17} strokeWidth={2.1} /></span><h1>PV Studio</h1><span className="brand-divider" aria-hidden="true" />
          {projectName === undefined ? <span className="brand-context">Design workspace</span> : <span className="brand-context">{projectName}</span>}
        </div>
        <div className="topbar__actions">
          <input ref={fileInputRef} className="sr-only" type="file" accept={acceptedImportTypes} multiple aria-label="Import site model" tabIndex={-1} disabled={!hasImportHandler} onChange={handleFileChange} />
          <button className="topbar-action topbar-action--import" type="button" disabled={!hasImportHandler} onClick={handleImportClick}><Upload size={15} aria-hidden="true" /><span>Import</span></button>
          <button className="topbar-action topbar-action--sample" type="button" disabled={onLoadSample === undefined} onClick={onLoadSample} aria-label="Load sample WebODM house" data-testid="load-sample-model"><Sparkles size={15} aria-hidden="true" /><span>Try sample</span></button>
          <ShellErrorBoundary area="header actions" resetKey={headerSlot ?? 'empty-header'}>{headerSlot}</ShellErrorBoundary>
          <button className="icon-button" type="button" aria-label="Help and documentation" title="Help and documentation" disabled={onHelp === undefined} onClick={onHelp}><CircleHelp size={17} aria-hidden="true" /></button>
          <button className="icon-button" type="button" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={handleThemeChange}>{theme === 'light' ? <Moon size={17} aria-hidden="true" /> : <Sun size={17} aria-hidden="true" />}</button>
        </div>
      </header>

      <div className="workspace-layout">
        <aside className={`tool-rail${mobileToolsOpen ? ' tool-rail--mobile-open' : ''}`} aria-label="Design tools">
          <div className="tool-rail__section"><p className="tool-rail__label">Tools</p><nav className="tool-nav" aria-label="Placement tools">
            {TOOL_DEFINITIONS.map((tool) => { const Icon = tool.icon; const isActive = activeTool === tool.id; const unavailable = (tool.id === 'align' && onAlignStart === undefined) || (tool.id === 'autofill' && onAutoFill === undefined) || (tool.id === 'obstacle' && (onObstacleStart === undefined || selectedSurface === undefined || selectedSurface === null)); return <button className={`tool-button${isActive ? ' tool-button--active' : ''}`} type="button" key={tool.id} aria-pressed={isActive} title={`${tool.label} (${tool.shortcut})`} disabled={unavailable} onClick={() => { activateTool(tool.id); }}><Icon size={18} strokeWidth={isActive ? 2.1 : 1.75} aria-hidden="true" /><span>{tool.label}</span><kbd>{tool.shortcut}</kbd></button> })}
          </nav></div>
          <div className="tool-rail__bottom"><button className="tool-button tool-button--muted" type="button" title="Project layers" aria-label="Project layers" disabled={onLayersOpen === undefined} onClick={onLayersOpen}><Layers3 size={18} strokeWidth={1.75} aria-hidden="true" /><span>Layers</span></button><button className="tool-button tool-button--muted" type="button" title="Design settings" onClick={() => { setSelectedTab('inspector'); setRightPanelOpen(true); }}><SlidersHorizontal size={18} strokeWidth={1.75} aria-hidden="true" /><span>Settings</span></button></div>
        </aside>

        <main className="design-stage" aria-label="Design workspace">
          <div className="stage-toolbar">
            <div className="stage-toolbar__group" role="group" aria-label="Camera mode"><button className={`view-toggle${cameraMode === '3d' ? ' view-toggle--active' : ''}`} type="button" aria-pressed={cameraMode === '3d'} onClick={() => { setCameraMode('3d'); }}><Move3d size={14} aria-hidden="true" />3D</button><button className={`view-toggle${cameraMode === '2d' ? ' view-toggle--active' : ''}`} type="button" aria-pressed={cameraMode === '2d'} onClick={() => { setCameraMode('2d'); }}><PanelTop size={14} aria-hidden="true" />2D plan</button></div>
            <div className="stage-toolbar__group" role="group" aria-label="Render mode"><button className={`view-toggle${renderMode === 'texture' ? ' view-toggle--active' : ''}`} type="button" aria-pressed={renderMode === 'texture'} onClick={() => { setRenderMode('texture'); }}>Texture</button><button className={`view-toggle${renderMode === 'wireframe' ? ' view-toggle--active' : ''}`} type="button" aria-pressed={renderMode === 'wireframe'} onClick={() => { setRenderMode('wireframe'); }}>Wire</button></div>
            <div className="stage-toolbar__group stage-toolbar__group--right"><button className={`stage-icon-button${showGrid ? ' stage-icon-button--active' : ''}`} type="button" aria-pressed={showGrid} aria-label={`${showGrid ? 'Hide' : 'Show'} layout grid`} title={`${showGrid ? 'Hide' : 'Show'} layout grid`} onClick={setGrid}><Grid2X2 size={16} aria-hidden="true" /></button><button className="stage-icon-button" type="button" aria-label="Fit model to view" title="Fit model to view" disabled={onFitView === undefined} onClick={onFitView}><Maximize2 size={16} aria-hidden="true" /></button><span className="toolbar-divider" aria-hidden="true" /><button className="stage-icon-button" type="button" aria-label="Undo" title="Undo" disabled={!canUndo || onUndo === undefined} onClick={onUndo}><Redo2 size={16} className="icon-flip-x" aria-hidden="true" /></button><button className="stage-icon-button" type="button" aria-label="Redo" title="Redo" disabled={!canRedo || onRedo === undefined} onClick={onRedo}><Redo2 size={16} aria-hidden="true" /></button></div>
          </div>

          <div className={`viewer-frame viewer-frame--${cameraMode}${showGrid && cameraMode === '2d' ? ' viewer-frame--grid' : ''}${alignStage !== 'idle' ? ' viewer-frame--align-preview' : ''}`}>
            <div className="viewer-frame__canvas" tabIndex={0} role="application" aria-label={`${cameraMode === '3d' ? '3D' : '2D'} site viewer. Press Enter to select a surface.`} onKeyDown={handleViewerKeyDown}><ShellErrorBoundary area="site viewer" resetKey={viewer ?? (hasWebGL ? `placeholder:${acceptedImportTypes}:${hasImportHandler ? 'ready' : 'disabled'}` : 'webgl-fallback')}>{viewerContent}</ShellErrorBoundary></div>
            <div className="viewer-overlay viewer-overlay--top-left"><span className="view-status"><span className="view-status__dot" aria-hidden="true" />{cameraMode === '3d' ? 'Perspective' : 'Top-down plan'}</span><span className="view-status view-status--secondary">{renderMode === 'texture' ? 'Textured' : 'Wireframe'}</span></div>
            {activeTool === 'obstacle' ? <div className="viewer-overlay viewer-overlay--bottom-right obstacle-drawing-hint" role="status" aria-live="polite">Drag on the active surface to draw an obstacle (minimum 0.05 m). Press <kbd>Esc</kbd> to cancel.</div> : null}
            {selectedSurface === undefined || selectedSurface === null ? null : <div className="viewer-overlay viewer-overlay--bottom-left"><span className="surface-chip"><span className="surface-chip__swatch" aria-hidden="true" />{selectedSurface.label ?? selectedSurface.id}<span className="surface-chip__muted">· {formatArea(selectedSurface.area)}</span></span></div>}
            <AlignmentBanner stage={alignStage} preview={alignPreview} onConfirm={onAlignConfirm === undefined ? undefined : confirmAlign} onCancel={controlledAlignStage !== undefined && onAlignCancel === undefined ? undefined : cancelAlign} dialogRef={alignDialogRef} />
          </div>

          <div className="stage-footer"><div className="stage-footer__hint"><Keyboard size={14} aria-hidden="true" /><span>Press <kbd>?</kbd> for shortcuts</span></div><div className="stage-footer__actions"><button className="stage-footer__action" type="button" aria-label="Undo last action" disabled={!canUndo || onUndo === undefined} onClick={onUndo}><Redo2 className="icon-flip-x" size={14} aria-hidden="true" />Undo</button><button className="stage-footer__action" type="button" aria-label="Redo last action" disabled={!canRedo || onRedo === undefined} onClick={onRedo}><Redo2 size={14} aria-hidden="true" />Redo</button>{onDelete === undefined ? null : <button className="stage-footer__action stage-footer__action--danger" type="button" aria-label="Delete selected panels" disabled={selectedPlacementIds.length === 0} onClick={deleteSelection}><X size={14} aria-hidden="true" />Delete</button>}</div></div>
        </main>

        {rightPanelOpen ? <button className="inspector-backdrop" type="button" aria-label="Dismiss side panel" onClick={() => { setRightPanelOpen(false); }} /> : null}
        <aside className={`inspector-panel${rightPanelOpen ? ' inspector-panel--open' : ''}`} aria-label="Panel library and inspector">
          <div className="inspector-tabs" role="tablist" aria-orientation="horizontal" aria-label="Workspace side panel"><button ref={panelTabRef} className={`inspector-tab${selectedTab === 'panel' ? ' inspector-tab--active' : ''}`} id="panel-tab" type="button" role="tab" aria-selected={selectedTab === 'panel'} aria-controls="panel-panel" tabIndex={selectedTab === 'panel' ? 0 : -1} onKeyDown={handleInspectorTabKeyDown} onClick={() => { setSelectedTab('panel'); }}><PanelsTopLeft size={15} aria-hidden="true" />Panel</button><button ref={inspectorTabRef} className={`inspector-tab${selectedTab === 'inspector' ? ' inspector-tab--active' : ''}`} id="inspector-tab" type="button" role="tab" aria-selected={selectedTab === 'inspector'} aria-controls="inspector-panel" tabIndex={selectedTab === 'inspector' ? 0 : -1} onKeyDown={handleInspectorTabKeyDown} onClick={() => { setSelectedTab('inspector'); }}><Settings2 size={15} aria-hidden="true" />Inspector</button><button className="inspector-close icon-button icon-button--small" type="button" aria-label="Close side panel" onClick={() => { setRightPanelOpen(false); }}><X size={15} aria-hidden="true" /></button></div>
          <div className="inspector-panel__body">{selectedTab === 'panel' ? <div id="panel-panel" role="tabpanel" aria-labelledby="panel-tab"><ShellErrorBoundary area="panel library" resetKey={panelSlot ?? `empty-library:${hasImportHandler ? 'ready' : 'disabled'}`}>{panelSlot ?? <EmptySlot label="Panel library" action={hasImportHandler ? 'Import site model' : undefined} onAction={hasImportHandler ? handleImportClick : undefined} />}</ShellErrorBoundary></div> : <div id="inspector-panel" role="tabpanel" aria-labelledby="inspector-tab"><ShellErrorBoundary area="inspector" resetKey={inspector ?? settings ?? selectedSurface ?? selectedPanel ?? summary ?? obstacles ?? 'fallback-inspector'}>{inspector ?? <InspectorFallback selectedSurface={selectedSurface} selectedPanel={selectedPanel} settings={settings} onSettingsChange={onSettingsChange} placementSummary={summary} onAutoFill={onAutoFill} obstacles={obstacles} draftObstacle={draftObstacle} onObstacleRemove={onObstacleRemove} onObstaclesClear={onObstaclesClear} />}</ShellErrorBoundary>{panelStatus === undefined ? null : <div className="panel-status-slot"><ShellErrorBoundary area="panel status" resetKey={panelStatus}>{panelStatus}</ShellErrorBoundary></div>}{panelStatus === undefined && summary === undefined ? null : panelStatus === undefined ? <div className="panel-status-slot"><PlacementSummary summary={summary as PanelPlacementSummary} /></div> : null}</div>}</div>
        </aside>
        {!rightPanelOpen ? <button className="reopen-inspector" type="button" onClick={() => { setRightPanelOpen(true); }}><PanelTop size={15} aria-hidden="true" />Open panel</button> : null}
      </div>

      <footer className="statusbar" aria-label="Workspace status"><div className="statusbar__left" role="status" aria-live="polite"><span className="connection-indicator"><span aria-hidden="true" />Local workspace</span><span className="statusbar-divider" aria-hidden="true" />{externalStatusMessage ?? localStatus}</div><div className="statusbar__right"><span>Metric units</span><span className="statusbar-divider" aria-hidden="true" /><button type="button" onClick={() => { setShortcutsOpen(true); }}><Keyboard size={13} aria-hidden="true" />Shortcuts</button></div></footer>
      {shortcutsOpen ? <KeyboardShortcuts onClose={() => { setShortcutsOpen(false); }} /> : null}
    </div>
  )
}
