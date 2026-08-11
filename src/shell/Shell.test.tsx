import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PanelGroupSettings, RectangularObstacle, SurfaceEdgeMetadata } from '../core'
import {
  Shell,
  ShellErrorBoundary,
  WebGLFallback,
  type AlignPreviewState,
  type PanelPlacementSummary,
  type ShellPanel,
  type ShellSurface,
  type ShellSurfaceEdge,
} from './Shell'

const surface: ShellSurface = {
  id: 'roof-east',
  label: 'East roof',
  area: 32.45,
  usableArea: 27.1,
  azimuthDeg: 112,
  tiltDeg: 28,
}

const panel: ShellPanel = {
  id: 'panel-400',
  manufacturer: 'HelioWorks',
  model: 'HW-400',
  wattageW: 400,
  efficiencyPct: 21.4,
}

const settings: PanelGroupSettings = {
  orientation: 'portrait',
  interPanelSpacingM: 0.02,
  rowSpacingM: 0.03,
  setbackM: 0.2,
  clearanceM: 0.1,
  tiltDeg: 0,
}

const placementSummary: PanelPlacementSummary = {
  count: 12,
  selectedCount: 2,
  previewCount: 3,
  draggingCount: 1,
  totalWattageW: 4800,
}

const alignPreview: AlignPreviewState = {
  candidateCount: 4,
  valid: true,
}

const obstacle: RectangularObstacle = {
  id: 'roof-east:obstacle:1',
  x: 1.25,
  y: 2.5,
  width: 2,
  height: 3,
}

describe('Shell', () => {
  it('uses APG roving focus for the side-panel tabs', () => {
    render(<Shell webglAvailable={true} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    const panelTab = tabs[0]
    const inspectorTab = tabs[1]
    expect(panelTab).toHaveAttribute('tabindex', '0')
    expect(inspectorTab).toHaveAttribute('tabindex', '-1')

    panelTab?.focus()
    fireEvent.keyDown(panelTab as HTMLElement, { key: 'ArrowRight' })
    expect(inspectorTab).toHaveFocus()
    expect(inspectorTab).toHaveAttribute('aria-selected', 'true')
    expect(panelTab).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(inspectorTab as HTMLElement, { key: 'Home' })
    expect(panelTab).toHaveFocus()
    fireEvent.keyDown(panelTab as HTMLElement, { key: 'End' })
    expect(inspectorTab).toHaveFocus()
    fireEvent.keyDown(inspectorTab as HTMLElement, { key: 'ArrowLeft' })
    expect(panelTab).toHaveFocus()
  })

  it('keeps the hidden file control out of the tab order while Import stays actionable', () => {
    render(<Shell onImport={vi.fn()} webglAvailable={true} />)
    const fileInput = screen.getByLabelText('Import site model')
    const importButton = screen.getByRole('button', { name: 'Import' })
    const clickSpy = vi.spyOn(fileInput, 'click')

    expect(fileInput).toHaveAttribute('tabindex', '-1')
    expect(importButton).not.toHaveAttribute('tabindex', '-1')
    fireEvent.click(importButton)
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps the inspector dismissed on compact viewports and supports backdrop/Escape dismissal', () => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    try {
      const { container } = render(<Shell webglAvailable={true} />)
      const inspector = container.querySelector('#workspace-side-panel') as HTMLElement
      expect(inspector).not.toHaveClass('inspector-panel--open')
      expect(inspector).toHaveAttribute('aria-hidden', 'true')
      expect(inspector).toHaveAttribute('inert')
      const openButton = screen.getByRole('button', { name: 'Open panel' })

      fireEvent.click(openButton)
      expect(inspector).toHaveClass('inspector-panel--open')
      expect(inspector).toHaveAttribute('aria-hidden', 'false')
      expect(inspector).not.toHaveAttribute('inert')
      expect(screen.getByRole('button', { name: 'Dismiss side panel' })).toBeInTheDocument()

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(inspector).not.toHaveClass('inspector-panel--open')
      expect(inspector).toHaveAttribute('aria-hidden', 'true')
      expect(inspector).toHaveAttribute('inert')
      expect(screen.getByRole('button', { name: 'Open panel' })).toHaveFocus()
      expect(screen.queryByRole('button', { name: 'Dismiss side panel' })).not.toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    }
  })

  it('keeps compact design tools off-canvas and restores focus after closing them', () => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    try {
      const { container } = render(<Shell webglAvailable={true} />)
      const rail = container.querySelector('#design-tools') as HTMLElement
      const menu = screen.getByRole('button', { name: 'Open design tools' })
      expect(rail).toHaveAttribute('aria-hidden', 'true')
      expect(rail).toHaveAttribute('inert')

      fireEvent.click(menu)
      expect(screen.getByRole('button', { name: /^Select/ })).toHaveFocus()
      expect(rail).toHaveAttribute('aria-hidden', 'false')
      expect(rail).not.toHaveAttribute('inert')
      fireEvent.click(menu)
      expect(menu).toHaveFocus()
      expect(rail).toHaveAttribute('aria-hidden', 'true')
      expect(rail).toHaveAttribute('inert')
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    }
  })

  it('reacts when the viewport crosses the compact breakpoint', () => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    try {
      const { container } = render(<Shell webglAvailable={true} />)
      const rail = container.querySelector('#design-tools') as HTMLElement
      const inspector = container.querySelector('#workspace-side-panel') as HTMLElement
      expect(rail).toHaveAttribute('aria-hidden', 'false')
      expect(inspector).toHaveAttribute('aria-hidden', 'false')

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
      fireEvent(window, new Event('resize'))
      expect(rail).toHaveAttribute('aria-hidden', 'true')
      expect(rail).toHaveAttribute('inert')
      expect(inspector).toHaveAttribute('aria-hidden', 'true')
      expect(inspector).toHaveAttribute('inert')
      expect(screen.getByRole('button', { name: 'Open panel' })).toBeInTheDocument()

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
      fireEvent(window, new Event('resize'))
      expect(rail).toHaveAttribute('aria-hidden', 'false')
      expect(rail).not.toHaveAttribute('inert')
      expect(inspector).toHaveAttribute('aria-hidden', 'false')
      expect(inspector).not.toHaveAttribute('inert')
      expect(screen.queryByRole('button', { name: 'Open panel' })).not.toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    }
  })

  it('does not expose inert orbit or measure tools and keeps viewer navigation discoverable', () => {
    render(<Shell webglAvailable={true} />)
    expect(screen.queryByRole('button', { name: /^Orbit/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Measure/ })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: /Drag to orbit.*pinch to zoom.*pan/i })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'o' })
    fireEvent.keyDown(window, { key: 'm' })
    expect(screen.getByLabelText('Workspace status')).toHaveTextContent('Ready')
    fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }))
    const shortcuts = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(shortcuts).not.toHaveTextContent(/Orbit|Measure/i)
  })

  it('keeps Auto-fill unavailable without a callback for toolbar and shortcut activation', () => {
    const onToolChange = vi.fn()
    render(<Shell activeTool="select" onToolChange={onToolChange} webglAvailable={true} />)
    const autoFill = screen.getByRole('button', { name: /^Auto-fill/ })

    expect(autoFill).toBeDisabled()
    fireEvent.click(autoFill)
    fireEvent.keyDown(window, { key: 'a' })

    expect(onToolChange).not.toHaveBeenCalled()
    expect(autoFill).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Workspace status')).toHaveTextContent('Ready')
  })

  it('keeps Obstacle unavailable without a callback or active surface and guards shortcut activation', () => {
    const onToolChange = vi.fn()
    const onObstacleStart = vi.fn()
    const { rerender } = render(<Shell activeTool="select" onToolChange={onToolChange} webglAvailable={true} />)
    const obstacleButton = screen.getByRole('button', { name: /^Obstacle/ })

    expect(obstacleButton).toBeDisabled()
    fireEvent.click(obstacleButton)
    fireEvent.keyDown(window, { key: 'b' })
    expect(onToolChange).not.toHaveBeenCalled()
    expect(onObstacleStart).not.toHaveBeenCalled()

    rerender(<Shell activeTool="select" onToolChange={onToolChange} onObstacleStart={onObstacleStart} webglAvailable={true} />)
    expect(screen.getByRole('button', { name: /^Obstacle/ })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'b' })
    expect(onToolChange).not.toHaveBeenCalled()
    expect(onObstacleStart).not.toHaveBeenCalled()
  })

  it('activates Obstacle on a surface, announces drawing, and exposes removal controls', () => {
    const onToolChange = vi.fn()
    const onObstacleStart = vi.fn()
    const onObstacleCancel = vi.fn()
    const onObstacleChange = vi.fn()
    const onObstacleRemove = vi.fn()
    const onObstaclesClear = vi.fn()
    const draftObstacle: RectangularObstacle = { id: 'draft', x: 0.5, y: 1, width: 1.5, height: 0.75 }
    render(
      <Shell
        selectedSurface={surface}
        onToolChange={onToolChange}
        onObstacleStart={onObstacleStart}
        onObstacleCancel={onObstacleCancel}
        obstacles={[obstacle]}
        draftObstacle={draftObstacle}
        onObstacleChange={onObstacleChange}
        onObstacleRemove={onObstacleRemove}
        onObstaclesClear={onObstaclesClear}
        webglAvailable={true}
      />,
    )

    const obstacleButton = screen.getByRole('button', { name: /^Obstacle/ })
    expect(obstacleButton).toBeEnabled()
    fireEvent.click(obstacleButton)
    expect(onObstacleStart).toHaveBeenCalledTimes(1)
    expect(onToolChange).toHaveBeenCalledWith('obstacle')
    expect(screen.getByText(/Drag empty surface to draw an obstacle.*minimum 0\.05 m.*drag an existing obstacle to move/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    expect(screen.getByRole('heading', { name: 'Surface obstacles' })).toBeInTheDocument()
    expect(screen.getByText('2.00 × 3.00 m')).toBeInTheDocument()
    expect(screen.getByText('Obstacle preview · 1.50 × 0.75 m')).toBeInTheDocument()
    const width = screen.getByRole('spinbutton', { name: 'Obstacle 1 width in metres' })
    fireEvent.change(width, { target: { value: '2.5' } })
    fireEvent.blur(width)
    expect(onObstacleChange).toHaveBeenCalledWith(obstacle.id, { width: 2.5 })
    fireEvent.change(width, { target: { value: '0.01' } })
    fireEvent.blur(width)
    expect(width).toHaveValue(2)
    fireEvent.click(screen.getByRole('button', { name: `Remove obstacle ${obstacle.id}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear all obstacles' }))
    expect(onObstacleRemove).toHaveBeenCalledWith(obstacle.id)
    expect(onObstaclesClear).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onObstacleCancel).toHaveBeenCalledTimes(1)
  })

  it('cancels obstacle mode from an editable target before shortcut guards run', () => {
    const onObstacleCancel = vi.fn()
    render(
      <Shell
        selectedSurface={surface}
        onObstacleStart={vi.fn()}
        onObstacleCancel={onObstacleCancel}
        viewer={<input aria-label="Obstacle field" />}
        webglAvailable={true}
      />,
    )

    const obstacleButton = screen.getByRole('button', { name: /^Obstacle/ })
    fireEvent.click(obstacleButton)
    expect(obstacleButton).toHaveAttribute('aria-pressed', 'true')

    fireEvent.keyDown(screen.getByLabelText('Obstacle field'), { key: 'Escape' })
    expect(onObstacleCancel).toHaveBeenCalledTimes(1)
    expect(obstacleButton).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders feature slots and typed selection context without inventing values', () => {
    render(
      <Shell
        viewer={<div data-testid="viewer-slot">Viewer slot</div>}
        panelChooser={<div data-testid="panel-slot">Panel chooser slot</div>}
        inspector={<div data-testid="inspector-slot">Inspector slot</div>}
        panelStatus={<div data-testid="status-slot">Panel status slot</div>}
        projectName="Riverside house"
        selectedSurface={surface}
        selectedPanel={panel}
        settings={settings}
        placementSummary={placementSummary}
        webglAvailable={true}
      />,
    )

    expect(screen.getByRole('heading', { name: 'PV Studio' })).toBeInTheDocument()
    expect(screen.getByText('Riverside house')).toBeInTheDocument()
    expect(screen.getByTestId('viewer-slot')).toBeInTheDocument()
    expect(screen.getByTestId('panel-slot')).toBeInTheDocument()
    expect(screen.queryByText('Selected panel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    expect(screen.getByTestId('inspector-slot')).toBeInTheDocument()
    expect(screen.getByTestId('status-slot')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Surface summary' })).not.toBeInTheDocument()
  })

  it('surfaces controlled view, tool, grid, theme and import events', () => {
    const onCameraModeChange = vi.fn()
    const onRenderModeChange = vi.fn()
    const onShowGridChange = vi.fn()
    const onToolChange = vi.fn()
    const onThemeChange = vi.fn()
    const onImport = vi.fn()
    const { container } = render(
      <Shell
        cameraMode="3d"
        renderMode="texture"
        showGrid={true}
        activeTool="select"
        theme="light"
        onCameraModeChange={onCameraModeChange}
        onRenderModeChange={onRenderModeChange}
        onShowGridChange={onShowGridChange}
        onToolChange={onToolChange}
        onThemeChange={onThemeChange}
        onImport={onImport}
        webglAvailable={true}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '2D plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Wire' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide layout grid' }))
    fireEvent.click(screen.getByRole('button', { name: /^Place/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(onCameraModeChange).toHaveBeenCalledWith('2d')
    expect(onRenderModeChange).toHaveBeenCalledWith('wireframe')
    expect(onShowGridChange).toHaveBeenCalledWith(false)
    expect(onToolChange).toHaveBeenCalledWith('place')
    expect(onThemeChange).toHaveBeenCalledWith('dark')

    const fileInput = screen.getByLabelText('Import site model')
    const file = new File(['obj'], 'site.obj', { type: 'model/obj' })
    fireEvent.change(fileInput, { target: { files: [file] } })
    expect(onImport).toHaveBeenCalledWith(file)
    expect(container.querySelector('input[type="file"]')).toBe(fileInput)
  })

  it('imports an OBJ, MTL and texture together and announces the selected set', () => {
    let importedFiles: readonly File[] | undefined
    const onImportFiles = vi.fn((files: readonly File[]): void => {
      importedFiles = files
    })
    render(<Shell onImportFiles={onImportFiles} webglAvailable={true} />)

    const fileInput = screen.getByLabelText('Import site model')
    expect(fileInput).toHaveAttribute('multiple')
    expect(screen.getByRole('button', { name: 'Import' })).not.toBeDisabled()

    const obj = new File(['obj'], 'site.obj', { type: 'model/obj' })
    const mtl = new File(['mtl'], 'site.mtl', { type: 'text/plain' })
    const texture = new File(['jpg'], 'site.jpg', { type: 'image/jpeg' })
    fireEvent.change(fileInput, { target: { files: [obj, mtl, texture] } })

    expect(onImportFiles).toHaveBeenCalledTimes(1)
    expect(importedFiles?.map((file) => file.name)).toEqual(['site.obj', 'site.mtl', 'site.jpg'])
    expect(importedFiles === undefined ? false : Object.isFrozen(importedFiles)).toBe(true)
    expect(screen.getByLabelText('Workspace status')).toHaveTextContent('Selected 3 files: site.obj, site.mtl, site.jpg')
  })

  it('keeps legacy imports single-file while allowing the same selection to be retried', () => {
    const onImport = vi.fn()
    render(<Shell onImport={onImport} webglAvailable={true} />)
    const fileInput = screen.getByLabelText('Import site model')
    const obj = new File(['obj'], 'site.obj', { type: 'model/obj' })
    const mtl = new File(['mtl'], 'site.mtl', { type: 'text/plain' })

    fireEvent.change(fileInput, { target: { files: [obj, mtl] } })
    fireEvent.change(fileInput, { target: { files: [obj, mtl] } })

    expect(onImport).toHaveBeenCalledTimes(2)
    expect(onImport).toHaveBeenNthCalledWith(1, obj)
    expect(onImport).toHaveBeenNthCalledWith(2, obj)
    expect(fileInput).toHaveValue('')
    expect(screen.getByLabelText('Workspace status')).toHaveTextContent('Selected 2 files: site.obj, site.mtl')
  })

  it('exposes keyboard alternatives for undo, nudge, delete, shortcuts and align preview', () => {
    const onUndo = vi.fn()
    const onRedo = vi.fn()
    const onDelete = vi.fn()
    const onNudgeSelection = vi.fn()
    const onAlignStart = vi.fn()
    const onAlignConfirm = vi.fn()
    const onAlignCancel = vi.fn()
    render(
      <Shell
        canUndo={true}
        canRedo={true}
        onUndo={onUndo}
        onRedo={onRedo}
        selectedPlacementIds={['placement-a', 'placement-b']}
        onDelete={onDelete}
        onNudgeSelection={onNudgeSelection}
        nudgeStepM={0.25}
        alignPreview={alignPreview}
        onAlignStart={onAlignStart}
        onAlignConfirm={onAlignConfirm}
        onAlignCancel={onAlignCancel}
        webglAvailable={true}
      />,
    )

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'Delete' })
    fireEvent.keyDown(window, { key: '?' })
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onRedo).toHaveBeenCalledTimes(2)
    expect(onNudgeSelection).toHaveBeenCalledWith({ x: 0.25, y: 0 })
    expect(onDelete).toHaveBeenCalledWith(['placement-a', 'placement-b'])
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Align/ }))
    expect(onAlignStart).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'Align preview' })).toHaveTextContent('4 panels will move.')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm align' }))
    expect(onAlignConfirm).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /^Align/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onAlignCancel).toHaveBeenCalledTimes(1)
  })

  it('allows typed array setting edits in the fallback inspector', () => {
    const onSettingsChange = vi.fn()
    render(<Shell settings={settings} onSettingsChange={onSettingsChange} webglAvailable={true} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Panel orientation' }), { target: { value: 'landscape' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Edge setback in metres' }), { target: { value: '0.3' } })
    expect(onSettingsChange).toHaveBeenNthCalledWith(1, { orientation: 'landscape' })
    expect(onSettingsChange).toHaveBeenNthCalledWith(2, { setbackM: 0.3 })
    expect(screen.getByText('Setback 200 mm · row 30 mm')).toBeInTheDocument()
  })

  it('exposes move and rotate actions for the selected panel group', () => {
    const onMoveSelection = vi.fn()
    const onRotateSelection = vi.fn()
    render(
      <Shell
        settings={settings}
        selectedPlacementIds={['placement-a', 'placement-b']}
        onMoveSelection={onMoveSelection}
        onRotateSelection={onRotateSelection}
        webglAvailable={true}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    expect(screen.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Panel group' })).toBeInTheDocument()
    expect(screen.getByText('2 panels', { selector: '.surface-status' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Horizontal module spacing in metres' })).toHaveValue(settings.interPanelSpacingM)
    expect(screen.getByRole('spinbutton', { name: 'Vertical module spacing in metres' })).toHaveValue(settings.rowSpacingM)

    fireEvent.click(screen.getByRole('button', { name: 'Move array' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rotate 90°' }))
    expect(onMoveSelection).toHaveBeenCalledTimes(1)
    expect(onRotateSelection).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Workspace status')).toHaveTextContent('Array rotated 90 degrees')
  })

  it('keeps optional auto-fill controls unset for legacy settings and validates edits', () => {
    const onSettingsChange = vi.fn()
    const { rerender } = render(<Shell settings={settings} settingsScopeLabel="Group array-1" onSettingsChange={onSettingsChange} webglAvailable={true} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))

    const modulesPerRow = screen.getByRole('spinbutton', { name: 'Modules per row' })
    const rowOffset = screen.getByRole('spinbutton', { name: 'Row offset in metres' })
    const obstacleClearance = screen.getByRole('spinbutton', { name: 'Obstacle clearance in metres' })
    expect(modulesPerRow).toHaveValue(null)
    expect(rowOffset).toHaveValue(null)
    expect(obstacleClearance).toHaveValue(null)
    expect(modulesPerRow).toHaveAttribute('placeholder', 'Auto')

    fireEvent.change(modulesPerRow, { target: { value: '0' } })
    fireEvent.change(modulesPerRow, { target: { value: '1.5' } })
    fireEvent.change(rowOffset, { target: { value: '-0.01' } })
    fireEvent.change(obstacleClearance, { target: { value: 'NaN' } })
    expect(onSettingsChange).not.toHaveBeenCalled()

    fireEvent.change(modulesPerRow, { target: { value: '8' } })
    fireEvent.change(rowOffset, { target: { value: '0.35' } })
    fireEvent.change(obstacleClearance, { target: { value: '0.2' } })
    expect(onSettingsChange).toHaveBeenNthCalledWith(1, { modulesPerRow: 8 })
    expect(onSettingsChange).toHaveBeenNthCalledWith(2, { rowOffsetM: 0.35 })
    expect(onSettingsChange).toHaveBeenNthCalledWith(3, { obstacleClearanceM: 0.2 })

    rerender(<Shell settings={{ ...settings, modulesPerRow: 6, rowOffsetM: 0.25, obstacleClearanceM: 0.1 }} onSettingsChange={onSettingsChange} webglAvailable={true} />)
    expect(screen.getByRole('spinbutton', { name: 'Modules per row' })).toHaveValue(6)
    expect(screen.getByRole('spinbutton', { name: 'Row offset in metres' })).toHaveValue(0.25)
    expect(screen.getByRole('spinbutton', { name: 'Obstacle clearance in metres' })).toHaveValue(0.1)

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Modules per row' }), { target: { value: '' } })
    expect(onSettingsChange).toHaveBeenNthCalledWith(4, { modulesPerRow: undefined })
  })

  it('shows the selected edge path and edits its type and direction', () => {
    const onSurfaceEdgeChange = vi.fn<(edge: SurfaceEdgeMetadata | undefined) => void>()
    const edge: ShellSurfaceEdge = {
      surfaceId: surface.id,
      type: 'gutter',
      direction: { x: 1, y: 0 },
      label: 'Gutter',
      path: `Surface ${surface.id} › Gutter`,
    }
    render(<Shell selectedSurface={surface} selectedSurfaceEdge={edge} onSurfaceEdgeChange={onSurfaceEdgeChange} webglAvailable={true} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    expect(screen.getByTestId('surface-edge-path')).toHaveTextContent(`Surface ${surface.id} › Gutter`)
    expect(screen.getByRole('combobox', { name: 'Surface edge type' })).toHaveValue('gutter')
    expect(screen.getByTestId('surface-edge-direction')).toHaveTextContent('1.00, 0.00')

    fireEvent.change(screen.getByRole('combobox', { name: 'Surface edge type' }), { target: { value: 'ridge' } })
    expect(onSurfaceEdgeChange).toHaveBeenNthCalledWith(1, { type: 'ridge', direction: { x: 1, y: 0 } })
    fireEvent.click(screen.getByRole('button', { name: 'Reverse surface edge direction' }))
    expect(onSurfaceEdgeChange).toHaveBeenNthCalledWith(2, { type: 'gutter', direction: { x: -1, y: 0 } })
  })

  it('round-trips authored edge direction, line and interior side fields', () => {
    const onSurfaceEdgeChange = vi.fn<(edge: SurfaceEdgeMetadata | undefined) => void>()
    const edge: ShellSurfaceEdge = {
      surfaceId: surface.id,
      type: 'gutter',
      direction: { x: 1, y: 0 },
      line: { origin: { x: 0, y: 2 }, direction: { x: 1, y: 0 } },
      label: 'Gutter',
      path: `Surface ${surface.id} › Gutter`,
    }
    render(<Shell selectedSurface={surface} selectedSurfaceEdge={edge} onSurfaceEdgeChange={onSurfaceEdgeChange} webglAvailable={true} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))

    fireEvent.change(screen.getByTestId('surface-edge-direction-x'), { target: { value: '2' } })
    expect(onSurfaceEdgeChange).toHaveBeenNthCalledWith(1, {
      type: 'gutter',
      direction: { x: 2, y: 0 },
      line: { origin: { x: 0, y: 2 }, direction: { x: 1, y: 0 } },
    })
    fireEvent.change(screen.getByTestId('surface-edge-line-origin-y'), { target: { value: '3' } })
    expect(onSurfaceEdgeChange).toHaveBeenNthCalledWith(2, {
      type: 'gutter',
      direction: { x: 1, y: 0 },
      line: { origin: { x: 0, y: 3 }, direction: { x: 1, y: 0 } },
    })
    fireEvent.change(screen.getByTestId('surface-edge-line-direction-y'), { target: { value: '1' } })
    expect(onSurfaceEdgeChange).toHaveBeenNthCalledWith(3, {
      type: 'gutter',
      direction: { x: 1, y: 0 },
      line: { origin: { x: 0, y: 2 }, direction: { x: 1, y: 1 } },
    })
    fireEvent.change(screen.getByTestId('surface-edge-side'), { target: { value: 'right' } })
    expect(onSurfaceEdgeChange).toHaveBeenNthCalledWith(4, {
      type: 'gutter',
      direction: { x: 1, y: 0 },
      line: { origin: { x: 0, y: 2 }, direction: { x: 1, y: 0 } },
      side: 'right',
    })
  })

  it('makes the global or group settings scope explicit in the inspector', () => {
    const onSettingsChange = vi.fn()
    const { rerender } = render(<Shell settings={settings} onSettingsChange={onSettingsChange} webglAvailable={true} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    expect(screen.getByTestId('settings-scope')).toHaveTextContent('Editing Global defaults')

    rerender(<Shell settings={settings} settingsScopeLabel="Group group-7" onSettingsChange={onSettingsChange} webglAvailable={true} />)
    expect(screen.getByTestId('settings-scope')).toHaveTextContent('Editing Group group-7')
  })

  it('keeps the shell usable when browser storage is unavailable', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked') })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
    try {
      expect(() => render(<Shell webglAvailable={true} />)).not.toThrow()
      expect(screen.getByTestId('pv-shell')).toBeInTheDocument()
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })

  it('shows the accepted import hint and keeps import inert without a callback', () => {
    render(<Shell acceptedImportTypes=".foo,image/png,model/obj,.foo" webglAvailable={true} />)
    expect(screen.getByText('FOO · PNG · OBJ')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
    expect(screen.getByLabelText('Import site model')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Import site model' })).not.toBeInTheDocument()

    const file = new File(['obj'], 'ignored.obj', { type: 'model/obj' })
    fireEvent.change(screen.getByLabelText('Import site model'), { target: { files: [file] } })
    expect(screen.queryByText('Loaded ignored.obj')).not.toBeInTheDocument()
  })

  it('ignores an empty selection without changing the live status', () => {
    const onImportFiles = vi.fn()
    render(<Shell onImportFiles={onImportFiles} webglAvailable={true} />)
    const fileInput = screen.getByLabelText('Import site model')

    fireEvent.change(fileInput, { target: { files: [] } })

    expect(onImportFiles).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Workspace status')).toHaveTextContent('Ready')
    expect(fileInput).toHaveValue('')
  })

  it('shows import work and failures prominently instead of only in the footer', () => {
    const { rerender } = render(<Shell statusMessage="Opening survey.zip…" statusKind="progress" webglAvailable={true} />)

    expect(screen.getByRole('status', { name: 'Preparing site model' })).toHaveTextContent('Opening survey.zip…')
    expect(screen.getByText('Large WebODM archives can take a few minutes to unpack.')).toBeInTheDocument()

    rerender(<Shell statusMessage="Import requires one OBJ model file." statusKind="error" webglAvailable={true} />)

    expect(screen.getByRole('alert', { name: 'Import failed' })).toHaveTextContent('Import requires one OBJ model file.')
    expect(screen.getByText('Choose Import to try another file.')).toBeInTheDocument()
  })

  it('validates finite clearance and tilt settings and only exposes top-down grid', () => {
    const onSettingsChange = vi.fn()
    const { container, rerender } = render(<Shell settings={settings} onSettingsChange={onSettingsChange} showGrid={true} cameraMode="3d" webglAvailable={true} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Panel clearance in metres' }), { target: { value: '0.25' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Panel tilt in degrees' }), { target: { value: '18' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Panel clearance in metres' }), { target: { value: 'NaN' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Panel clearance in metres' }), { target: { value: '-0.01' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Panel tilt in degrees' }), { target: { value: '-1' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Panel tilt in degrees' }), { target: { value: '91' } })
    expect(onSettingsChange).toHaveBeenNthCalledWith(1, { clearanceM: 0.25 })
    expect(onSettingsChange).toHaveBeenNthCalledWith(2, { tiltDeg: 18 })
    expect(onSettingsChange).toHaveBeenCalledTimes(2)

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Panel clearance in metres' }), { target: { value: '0' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Panel tilt in degrees' }), { target: { value: '90' } })
    expect(onSettingsChange).toHaveBeenNthCalledWith(3, { clearanceM: 0 })
    expect(onSettingsChange).toHaveBeenNthCalledWith(4, { tiltDeg: 90 })
    expect(container.querySelector('.viewer-frame')).not.toHaveClass('viewer-frame--grid')

    rerender(<Shell settings={settings} onSettingsChange={onSettingsChange} showGrid={true} cameraMode="2d" webglAvailable={true} />)
    expect(container.querySelector('.viewer-frame')).toHaveClass('viewer-frame--grid')
  })

  it('disables utility controls and keyboard actions until the host supplies them', () => {
    const onUndo = vi.fn()
    const onRedo = vi.fn()
    const { rerender } = render(<Shell canUndo={false} canRedo={false} onUndo={onUndo} onRedo={onRedo} selectedPlacementIds={['placement-a']} webglAvailable={true} />)
    expect(screen.queryByRole('button', { name: 'Fit model to view' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Help and documentation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Project layers' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Align/ })).toBeDisabled()

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(onUndo).not.toHaveBeenCalled()
    expect(onRedo).not.toHaveBeenCalled()

    const onFitView = vi.fn()
    const onHelp = vi.fn()
    const onLayersOpen = vi.fn()
    rerender(<Shell webglAvailable={true} onFitView={onFitView} onHelp={onHelp} onLayersOpen={onLayersOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fit model to view' }))
    fireEvent.click(screen.getByRole('button', { name: 'Help and documentation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Project layers' }))
    expect(onFitView).toHaveBeenCalledTimes(1)
    expect(onHelp).toHaveBeenCalledTimes(1)
    expect(onLayersOpen).toHaveBeenCalledTimes(1)
    rerender(<Shell webglAvailable={true} />)
    expect(screen.queryByRole('button', { name: 'Fit model to view' })).not.toBeInTheDocument()
  })

  it('traps focus in the blocking align dialog and returns focus on cancel', () => {
    const onAlignStart = vi.fn()
    const onAlignConfirm = vi.fn()
    const onAlignCancel = vi.fn()
    render(<Shell alignPreview={alignPreview} onAlignStart={onAlignStart} onAlignConfirm={onAlignConfirm} onAlignCancel={onAlignCancel} webglAvailable={true} />)
    const alignTrigger = screen.getByRole('button', { name: /^Align/ })
    alignTrigger.focus()
    fireEvent.click(alignTrigger)
    const dialog = screen.getByRole('dialog', { name: 'Align preview' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveFocus()

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'Confirm align' })
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(cancel).toHaveFocus()

    const outside = screen.getByRole('button', { name: /Switch to .* theme/ })
    outside.focus()
    expect(cancel).toHaveFocus()

    dialog.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onAlignStart).toHaveBeenCalledTimes(1)
    expect(onAlignCancel).toHaveBeenCalledTimes(1)
    expect(alignTrigger).toHaveFocus()
  })

  it('keeps alignment confirmation unavailable without the host action', () => {
    const onAlignStart = vi.fn()
    render(<Shell alignPreview={alignPreview} onAlignStart={onAlignStart} webglAvailable={true} />)
    fireEvent.click(screen.getByRole('button', { name: /^Align/ }))
    const confirm = screen.getByRole('button', { name: 'Confirm align' })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(screen.getByRole('dialog', { name: 'Align preview' })).toBeInTheDocument()
  })

  it('distinguishes confirm alignment stage and resets a failed header slot when replaced', () => {
    const onAlignConfirm = vi.fn()
    const { unmount } = render(<Shell alignStage="confirm" alignPreview={alignPreview} onAlignConfirm={onAlignConfirm} onAlignCancel={vi.fn()} webglAvailable={true} />)
    expect(screen.getByRole('dialog', { name: 'Confirm alignment' })).toHaveTextContent('4 panels are ready to move.')
    expect(screen.getByRole('button', { name: 'Apply alignment' })).toBeEnabled()
    unmount()

    function BrokenHeader(): never {
      throw new Error('broken header')
    }

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { rerender } = render(<Shell headerSlot={<BrokenHeader />} webglAvailable={true} />)
      expect(screen.getByRole('alert', { name: 'header actions error' })).toBeInTheDocument()
      rerender(<Shell headerSlot={<div data-testid="healthy-header">Healthy header</div>} webglAvailable={true} />)
      expect(screen.getByTestId('healthy-header')).toBeInTheDocument()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('shows the WebGL fallback and recovers errored feature slots', () => {
    const { rerender } = render(<Shell webglAvailable={false} />)
    expect(screen.getByRole('alert', { name: 'WebGL unavailable' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Check WebGL support/ })).toHaveAttribute('target', '_blank')

    function BrokenSlot(): never {
      throw new Error('broken slot')
    }

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    rerender(<Shell viewer={<BrokenSlot />} webglAvailable={true} />)
    expect(screen.getByRole('alert', { name: 'site viewer error' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    errorSpy.mockRestore()
  })

  it('exports standalone fallback components for hosts that need their own boundary', () => {
    render(
      <ShellErrorBoundary area="panel chooser">
        <div>Healthy slot</div>
      </ShellErrorBoundary>,
    )
    expect(screen.getByText('Healthy slot')).toBeInTheDocument()

    render(<WebGLFallback />)
    expect(screen.getByRole('alert', { name: 'WebGL unavailable' })).toBeInTheDocument()
    expect(within(screen.getByRole('alert', { name: 'WebGL unavailable' })).getByRole('link')).toBeInTheDocument()
  })
})
