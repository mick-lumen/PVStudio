import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { isValidElement, useCallback, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { PanelDefinition, PanelGroupSettings, PanelPlacement, SurfaceDescriptor } from './core'
import { createPlacementStore, editableGroupIdFor } from './placement'
import type { PanelPointerInfo } from './rendering'
import { Shell, type AlignPreviewState } from './shell/Shell'
import type { ViewerProps, ViewerResource, ViewerSurfacePointerEvent } from './viewer'

vi.mock('./viewer', () => {
  const surface: SurfaceDescriptor = {
    id: 'roof-east',
    frame: {
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      tangentX: { x: 1, y: 0, z: 0 },
      tangentY: { x: 0, y: 1, z: 0 },
    },
    region: { x: 0, y: 0, width: 8, height: 4 },
    area: 32,
    azimuthDeg: 90,
    tiltDeg: 25,
    usableArea: 27,
    faceRefs: [{ meshId: 'roof', faceIndices: [0] }],
  }
  type MockViewerProps = Pick<ViewerProps, 'source' | 'cameraMode' | 'onCameraModeChange' | 'renderMode' | 'onRenderModeChange' | 'onSurfacesChange' | 'onSurfaceSelect' | 'onSurfacePointer' | 'sceneContent' | 'surfaceGestureActive'>
  type LayerProps = {
    readonly placements?: readonly PanelPlacement[]
    readonly interactionsEnabled?: boolean
    readonly onPanelSelect?: (placement: PanelPlacement, info: PanelPointerInfo) => void
    readonly onPanelDragStart?: (placement: PanelPlacement, info: PanelPointerInfo) => void
    readonly onPanelDrag?: (placement: PanelPlacement, info: PanelPointerInfo) => void
    readonly onPanelDragEnd?: (placement: PanelPlacement, info: PanelPointerInfo) => void
  }
  const selection = (x: number, y: number) => ({ surface, hitLocal: { x, y }, worldPoint: { x, y, z: 0 } })
  const resourceLabel = (resource: ViewerResource): string => typeof resource === 'string' ? resource : resource.name
  const pointer = (
    phase: ViewerSurfacePointerEvent['phase'],
    x: number,
    y: number,
    shiftKey = false,
    buttons = phase === 'up' || phase === 'cancel' ? 0 : 1,
  ): ViewerSurfacePointerEvent => ({
    phase,
    pointerId: 1,
    button: 0,
    buttons,
    shiftKey,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    selection: selection(x, y),
  })
  const emitSurface = (props: MockViewerProps): void => { props.onSurfacesChange?.([surface]) }
  const emitPointer = (props: MockViewerProps, event: ViewerSurfacePointerEvent): void => {
    emitSurface(props)
    props.onSurfacePointer?.(event)
  }
  const MockViewer = (props: MockViewerProps): ReactNode => {
    const layer = isValidElement(props.sceneContent)
      ? props.sceneContent as ReactElement<LayerProps>
      : null
    const dragInfo = (x: number, y: number): PanelPointerInfo => ({
      worldPoint: { x, y, z: 0 },
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      button: 0,
      instanceId: 0,
    })
    return (
    <div data-testid="mock-viewer">
      <div role="toolbar" aria-label="Viewer display controls">
        <button type="button" aria-pressed={props.cameraMode === 'perspective'} onClick={() => { props.onCameraModeChange?.('perspective') }}>3D</button>
        <button type="button" aria-pressed={props.cameraMode === 'orthographic'} onClick={() => { props.onCameraModeChange?.('orthographic') }}>Top</button>
        <button type="button" aria-pressed={props.renderMode === 'texture'} onClick={() => { props.onRenderModeChange?.('texture') }}>Texture</button>
        <button type="button" aria-pressed={props.renderMode === 'wireframe'} onClick={() => { props.onRenderModeChange?.('wireframe') }}>Wire</button>
      </div>
      <output data-testid="mock-source">{props.source?.name ?? ''}{props.source?.mtl === undefined ? '' : `|${resourceLabel(props.source.mtl)}`}{props.source?.textures === undefined ? '' : `|${props.source.textures.map(resourceLabel).join(',')}`}</output>
      <output data-testid="mock-placement-ids">{layer?.props.placements?.map((placement) => placement.id).join(',') ?? ''}</output>
      <output data-testid="mock-placement-centers">{layer?.props.placements?.map((placement) => `${placement.id}:${placement.localCenter.x.toFixed(2)},${placement.localCenter.y.toFixed(2)}`).join('|') ?? ''}</output>
      <output data-testid="mock-placement-groups">{layer?.props.placements?.map((placement) => placement.groupId ?? 'none').join(',') ?? ''}</output>
      <output data-testid="mock-panel-interactions">{layer?.props.interactionsEnabled === false ? 'disabled' : 'enabled'}</output>
      <output data-testid="mock-surface-gesture">{props.surfaceGestureActive ? 'active' : 'idle'}</output>
      <button
        type="button"
        onClick={() => {
          emitSurface(props)
          emitPointer(props, pointer('down', 4, 2))
          emitPointer(props, pointer('up', 4, 2))
          props.onSurfaceSelect?.(
            { surface, hitLocal: { x: 4, y: 2 }, worldPoint: { x: 4, y: 2, z: 0 } },
            { shiftKey: false, selectedSurfaceIds: [surface.id] },
          )
        }}
      >
        Select roof surface
      </button>
      <button type="button" onClick={() => {
        emitSurface(props)
        props.onSurfaceSelect?.(
          { surface, hitLocal: { x: 4, y: 2 }, worldPoint: { x: 4, y: 2, z: 0 } },
          { shiftKey: false, selectedSurfaceIds: [surface.id] },
        )
      }}>Activate roof surface</button>
      <button type="button" onClick={() => {
        emitSurface(props)
        emitSurface(props)
      }}>Repeat roof surfaces</button>
      <button type="button" onClick={() => {
        props.onSurfacesChange?.([{ ...surface, area: 33, usableArea: 28 }])
      }}>Refresh roof surface</button>
      <button type="button" onClick={() => { emitPointer(props, pointer('move', 4, 2, false, 0)) }}>Hover surface pointer</button>
      <button type="button" onClick={() => { emitPointer(props, pointer('down', 4, 2)) }}>Start surface pointer</button>
      <button type="button" onClick={() => { emitPointer(props, pointer('down', 0, 0)) }}>Start invalid surface pointer</button>
      <button type="button" onClick={() => { emitPointer(props, pointer('move', 3, 2)) }}>Move surface pointer</button>
      <button type="button" onClick={() => { emitPointer(props, pointer('up', 4, 2)) }}>Finish surface pointer</button>
      <button type="button" onClick={() => { emitPointer(props, pointer('up', 0, 0)) }}>Finish invalid surface pointer</button>
      <button type="button" onClick={() => {
        emitPointer(props, pointer('down', 6, 2))
        emitPointer(props, pointer('up', 6, 2))
      }}>Place second panel</button>
      <button type="button" onClick={() => {
        emitPointer(props, pointer('down', 1, 1))
        emitPointer(props, pointer('move', 8, 4))
        emitPointer(props, pointer('up', 8, 4))
      }}>Draw surface array</button>
      <button type="button" onClick={() => {
        emitPointer(props, pointer('down', 4, 2))
        emitPointer(props, pointer('move', 4.02, 2.02))
        emitPointer(props, pointer('up', 4.02, 2.02))
      }}>Tiny surface jitter</button>
      <button type="button" onClick={() => {
        emitPointer(props, pointer('down', 1, 1))
        emitPointer(props, pointer('move', 8, 4))
        emitPointer(props, pointer('cancel', 8, 4))
      }}>Cancel surface array</button>
      <button type="button" onClick={() => {
        emitPointer(props, pointer('down', 0, 0))
        emitPointer(props, pointer('move', 8, 4))
        emitPointer(props, pointer('up', 8, 4))
      }}>Draw obstacle</button>
      <button type="button" onClick={() => {
        emitPointer(props, pointer('down', 1, 1))
        emitPointer(props, pointer('move', 3, 2))
        emitPointer(props, pointer('up', 3, 2))
      }}>Move obstacle</button>
      <button type="button" onClick={() => {
        emitPointer(props, pointer('down', 2, 2))
        emitPointer(props, pointer('move', 2.02, 2.02))
        emitPointer(props, pointer('up', 2.02, 2.02))
      }}>Tiny obstacle</button>
      <button type="button" onClick={() => {
        emitPointer(props, pointer('down', 1, 1))
        emitPointer(props, pointer('move', 5, 3))
        emitPointer(props, pointer('cancel', 5, 3))
      }}>Cancel obstacle</button>
      <button type="button" onClick={() => {
        emitPointer(props, pointer('down', 1, 1))
        emitPointer(props, pointer('move', 5, 3))
      }}>Draft obstacle</button>
      <button type="button" onClick={() => {
        emitPointer(props, pointer('down', 0, 0))
        emitPointer(props, pointer('move', 8, 4))
        emitPointer(props, pointer('up', 8, 4))
      }}>Select surface box</button>
      <button type="button" onClick={() => { emitPointer(props, pointer('down', 1, 1)) }}>Start selection box gesture</button>
      <button type="button" onClick={() => { emitPointer(props, pointer('up', 1, 1)) }}>Finish selection box gesture</button>
      <button type="button" onClick={() => { emitPointer(props, pointer('cancel', 1, 1)) }}>Cancel selection box gesture</button>
      <button type="button" onClick={() => {
        const placement = layer?.props.placements?.[0]
        if (placement === undefined || layer === null) return
        layer.props.onPanelSelect?.(placement, dragInfo(4, 2))
        layer.props.onPanelDragStart?.(placement, dragInfo(4, 2))
        layer.props.onPanelDrag?.(placement, dragInfo(4.5, 2.2))
        layer.props.onPanelDragEnd?.(placement, dragInfo(4.5, 2.2))
      }}>Drag existing panel</button>
    </div>
    )
  }
  return { Viewer: MockViewer }
})

const ALIGN_SETTINGS: PanelGroupSettings = {
  orientation: 'portrait',
  interPanelSpacingM: 0.02,
  rowSpacingM: 0.03,
  setbackM: 0.2,
  clearanceM: 0.1,
  tiltDeg: 0,
}

/**
 * A small controlled shell fixture keeps this UI contract test independent of
 * the full App/Three.js scene setup. App-level placement and store behaviour
 * remain covered by the neighbouring integration tests and placement tests.
 */
const AlignInspectorHarness = (): ReactNode => {
  const [settings, setSettings] = useState<PanelGroupSettings>(ALIGN_SETTINGS)
  const [alignStage, setAlignStage] = useState<'idle' | 'confirm'>('idle')
  const [alignPreview, setAlignPreview] = useState<AlignPreviewState>({ candidateCount: 3, valid: true })
  return (
    <Shell
      settings={settings}
      settingsScopeLabel="Group array-1"
      onSettingsChange={(patch) => { setSettings((current) => ({ ...current, ...patch })) }}
      selectedPlacementIds={['panel-1', 'panel-2', 'panel-3']}
      placementSummary={{ count: 3, selectedCount: 3, previewCount: 0, draggingCount: 0, totalWattageW: 1620 }}
      alignStage={alignStage}
      alignPreview={alignPreview}
      onAlignStart={() => { setAlignStage('confirm') }}
      onAlignConfirm={() => {
        setAlignPreview({ candidateCount: 3, valid: false, reason: 'Panels overlap after alignment.' })
        setAlignStage('idle')
      }}
      onAlignCancel={() => { setAlignStage('idle') }}
      webglAvailable
    />
  )
}

const BRIDGE_PANEL: PanelDefinition = {
  id: 'bridge-panel',
  manufacturer: 'PV Studio',
  model: 'Bridge panel',
  widthM: 1,
  heightM: 2,
  thicknessM: 0.035,
  wattageW: 400,
  weightKg: 20,
}

const BRIDGE_SURFACE: SurfaceDescriptor = {
  id: 'bridge-roof',
  frame: {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    tangentX: { x: 1, y: 0, z: 0 },
    tangentY: { x: 0, y: 1, z: 0 },
  },
  region: { x: 0, y: 0, width: 8, height: 4 },
  area: 32,
  azimuthDeg: 90,
  tiltDeg: 25,
  usableArea: 27,
  faceRefs: [{ meshId: 'bridge-roof', faceIndices: [0] }],
}

const BRIDGE_PLACEMENT: PanelPlacement = {
  id: 'bridge-placement',
  panelId: BRIDGE_PANEL.id,
  surfaceId: BRIDGE_SURFACE.id,
  localCenter: { x: 2, y: 2 },
  orientation: 'portrait',
  clearanceM: 0.1,
  tiltDeg: 0,
  groupId: 'array-bridge',
}

/**
 * Exercises the same settings callback contract as App with a tiny store.
 * Full App placement and source integration remain covered by neighbouring
 * tests; this keeps the scope-routing regression independent of the viewer.
 */
const SettingsBridgeHarness = (): ReactNode => {
  const [store] = useState(() => createPlacementStore({
    panels: [BRIDGE_PANEL],
    surfaces: [BRIDGE_SURFACE],
    initial: {
      placements: { [BRIDGE_PLACEMENT.id]: BRIDGE_PLACEMENT },
      selectedIds: [BRIDGE_PLACEMENT.id],
    },
  }))
  const subscribe = useCallback((listener: () => void): (() => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => store.getSnapshot(), [store])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const groupId = editableGroupIdFor(state)
  const settings = groupId === undefined ? state.settings : store.getGroupSettings(groupId)
  const settingsScopeLabel = groupId === undefined ? 'Global defaults' : `Group ${groupId}`
  const onSettingsChange = useCallback((patch: Partial<PanelGroupSettings>): void => {
    if (groupId === undefined) store.setSettings(patch)
    else store.setGroupSettings(groupId, patch)
  }, [groupId, store])
  return (
    <>
      <button type="button" onClick={() => { store.selectPanels([]) }}>Clear selected group</button>
      <button type="button" onClick={() => { store.selectPanels([BRIDGE_PLACEMENT.id]) }}>Select bridge group</button>
      <output data-testid="bridge-settings">{JSON.stringify(settings)}</output>
      <Shell
        settings={settings}
        settingsScopeLabel={settingsScopeLabel}
        onSettingsChange={onSettingsChange}
        selectedPlacementIds={state.selectedIds}
        placementSummary={{ count: Object.keys(state.placements).length, selectedCount: state.selectedIds.length, previewCount: 0, draggingCount: 0, totalWattageW: 400 }}
        webglAvailable
      />
    </>
  )
}

import { App } from './App'

describe('App', () => {
  it('mounts the workspace and exposes the WebGL fallback', () => {
    render(<App webglAvailable={false} />)
    expect(screen.getByRole('heading', { name: 'PV Studio' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/WebGL/i)
  })

  it('keeps in-canvas display controls synchronized with the shell controls', () => {
    render(<App webglAvailable />)
    const viewerControls = within(screen.getByRole('toolbar', { name: 'Viewer display controls' }))
    const shellCameraControls = within(screen.getByRole('group', { name: 'Camera mode' }))
    const shellRenderControls = within(screen.getByRole('group', { name: 'Render mode' }))

    expect(viewerControls.getByRole('button', { name: '3D' })).toHaveAttribute('aria-pressed', 'true')
    expect(viewerControls.getByRole('button', { name: 'Texture' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(viewerControls.getByRole('button', { name: 'Top' }))
    fireEvent.click(viewerControls.getByRole('button', { name: 'Wire' }))

    expect(viewerControls.getByRole('button', { name: 'Top' })).toHaveAttribute('aria-pressed', 'true')
    expect(viewerControls.getByRole('button', { name: 'Wire' })).toHaveAttribute('aria-pressed', 'true')
    expect(shellCameraControls.getByRole('button', { name: '2D plan' })).toHaveAttribute('aria-pressed', 'true')
    expect(shellRenderControls.getByRole('button', { name: 'Wire' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Top-down plan')).toBeInTheDocument()
    expect(screen.getByText('Wireframe')).toBeInTheDocument()

    fireEvent.click(shellCameraControls.getByRole('button', { name: '3D' }))
    fireEvent.click(shellRenderControls.getByRole('button', { name: 'Texture' }))

    expect(viewerControls.getByRole('button', { name: '3D' })).toHaveAttribute('aria-pressed', 'true')
    expect(viewerControls.getByRole('button', { name: 'Texture' })).toHaveAttribute('aria-pressed', 'true')
    expect(shellCameraControls.getByRole('button', { name: '3D' })).toHaveAttribute('aria-pressed', 'true')
    expect(shellRenderControls.getByRole('button', { name: 'Texture' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('announces a selected import source through the controlled shell boundary', async () => {
    render(<App webglAvailable={false} />)
    const input = screen.getByLabelText('Import site model')
    const file = new File(['v 0 0 0'], 'site.obj', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => { expect(screen.getByText('Loaded site.obj')).toBeInTheDocument() })
  })

  it('passes an OBJ, MTL, and texture bundle to the viewer source boundary', async () => {
    render(<App webglAvailable />)
    const input = screen.getByLabelText('Import site model')
    const obj = new File(['v 0 0 0'], 'site.obj', { type: 'text/plain' })
    const mtl = new File(['newmtl roof'], 'site.mtl', { type: 'text/plain' })
    const texture = new File(['png'], 'roof.PNG', { type: 'image/png' })

    fireEvent.change(input, { target: { files: [obj, mtl, texture] } })

    await waitFor(() => {
      expect(screen.getByTestId('mock-source')).toHaveTextContent('site.obj|site.mtl|roof.PNG')
      expect(screen.getByText('Loaded site.obj')).toBeInTheDocument()
    })
  })

  it('loads the checked-in WebODM fixture through the real URL source without opening the picker', () => {
    render(<App webglAvailable />)
    const filePickerClick = vi.spyOn(HTMLInputElement.prototype, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Try WebODM sample' }))

    expect(filePickerClick).not.toHaveBeenCalled()
    expect(screen.getByTestId('mock-source')).toHaveTextContent(
      'Synthetic WebODM house|/test-data/synthetic-webodm-house/synthetic-webodm-house.mtl|/test-data/synthetic-webodm-house/ground-texture.jpg,/test-data/synthetic-webodm-house/roof-texture.jpg,/test-data/synthetic-webodm-house/wall-texture.jpg',
    )
    expect(screen.getByText('Loaded Synthetic WebODM house')).toBeInTheDocument()
    filePickerClick.mockRestore()
  })

  it('resets the placement context when a controlled model source changes', { timeout: 10_000 }, async () => {
    const firstSource = {
      obj: new File(['v 0 0 0'], 'first.obj', { type: 'text/plain' }),
      name: 'first.obj',
    }
    const secondSource = {
      obj: new File(['v 0 0 0'], 'second.obj', { type: 'text/plain' }),
      name: 'second.obj',
    }
    const view = render(<App source={firstSource} webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select roof surface' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toBeInTheDocument()
    })

    view.rerender(<App source={secondSource} webglAvailable />)
    await waitFor(() => {
      expect(screen.getByTestId('mock-source')).toHaveTextContent('second.obj')
      expect(screen.getByText(/Panel layout: 0 panels/)).toBeInTheDocument()
    })
  })

  it('does not wipe placements when the viewer repeats an identical surface callback', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: 'Repeat roof surfaces' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))

    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toBeInTheDocument()
    })
  })

  it('preserves an authored surface edge when the viewer refreshes the same surface descriptor', () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: 'Activate roof surface' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))

    const edgeType = screen.getByRole('combobox', { name: 'Surface edge type' })
    fireEvent.change(edgeType, { target: { value: 'gutter' } })
    expect(edgeType).toHaveValue('gutter')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh roof surface' }))

    expect(screen.getByRole('combobox', { name: 'Surface edge type' })).toHaveValue('gutter')
    expect(screen.getByTestId('surface-edge-path')).toHaveTextContent('Surface roof-east › Gutter')
  })

  it('places a selected catalogue panel on a viewer surface and reports kWp', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select roof surface' }))

    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toBeInTheDocument()
    })
    expect(screen.getByText(/Panel layout: 1 panel/)).toHaveTextContent(/0\.56 kWp|0\.55 kWp|0\.54 kWp/)
  })

  it('starts a new explicit array for every primary + Panel placement', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Place second panel' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))

    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 2 panels/)).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Panel arrays' }).parentElement).toHaveTextContent('2')
    })

    const groupIds = screen.getByTestId('mock-placement-groups').textContent.split(',')
    expect(groupIds).toHaveLength(2)
    expect(new Set(groupIds).size).toBe(2)
    const arraySection = screen.getByRole('heading', { name: 'Panel arrays' }).closest('section')
    expect(arraySection).not.toBeNull()
    expect(within(arraySection as HTMLElement).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Array 11 panels',
      'Array 21 panels',
    ])
  })

  it('keeps a saved custom panel unique while registering and placing its wattage', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: 'Add custom panel' }))

    const values: Readonly<Record<string, string>> = {
      Manufacturer: 'Acme Solar',
      Model: 'AX-450',
      'Length (mm)': '1722',
      'Width (mm)': '1134',
      'Thickness (mm)': '30',
      'Weight (kg)': '20.5',
      'Wattage (W)': '450',
      'Cell count': '144',
      'Efficiency (%)': '22.4',
    }
    for (const [label, value] of Object.entries(values)) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save custom panel' }))

    const cards = screen.getByRole('list', { name: 'Available panel models' })
    expect(within(cards).getAllByRole('button', { name: /Acme Solar.*AX-450/ })).toHaveLength(1)
    expect(screen.getAllByRole('option', { name: /Acme Solar.*AX-450/ })).toHaveLength(1)
    expect(screen.getByRole('combobox', { name: 'Selected panel model' })).toHaveValue('acme-solar-ax-450')
    expect(screen.getByRole('button', { name: '+ Panel' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hover surface pointer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start surface pointer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finish surface pointer' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))

    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toHaveTextContent('0.45 kWp')
    })
  }, 15_000)

  it('wires delete and undo to the placement store', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected panels' }))

    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 0 panels/)).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Undo last action' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toBeInTheDocument()
    })
  })

  it('moves an existing panel once without changing its placement identity', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select roof surface' }))
    const idsBefore = screen.getByTestId('mock-placement-ids').textContent
    expect(idsBefore).toMatch(/^panel-/)

    fireEvent.click(screen.getByRole('button', { name: 'Drag existing panel' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toBeInTheDocument()
    })
    expect(screen.getByTestId('mock-placement-ids')).toHaveTextContent(idsBefore)

    fireEvent.click(screen.getByRole('button', { name: 'Undo last action' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toBeInTheDocument()
    })
    expect(screen.getByTestId('mock-placement-ids')).toHaveTextContent(idsBefore)
    fireEvent.click(screen.getByRole('button', { name: 'Redo last action' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toBeInTheDocument()
    })
    expect(screen.getByTestId('mock-placement-ids')).toHaveTextContent(idsBefore)
  })

  it('keeps a hover pointer placement as a ghost until click release, then commits one panel', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hover surface pointer' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    expect(screen.getByText(/Panel layout: 0 panels/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start surface pointer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finish surface pointer' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toBeInTheDocument()
    })
  })

  it('creates an array from a bare-surface down/move/up drag', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Draw surface array' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    await waitFor(() => {
      const layout = screen.getByText(/Panel layout: \d+ panels/)
      expect(layout.textContent).not.toMatch(/Panel layout: 0 panels/)
    })
  })

  it('shows and edits the generated array group scope in the inspector', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Draw surface array' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))

    await waitFor(() => {
      expect(screen.getByTestId('settings-scope')).toHaveTextContent('Editing Group group-1')
    })
    const tilt = screen.getByLabelText('Panel tilt in degrees')
    fireEvent.change(tilt, { target: { value: '25' } })
    expect(screen.getByTestId('settings-scope')).toHaveTextContent('Editing Group group-1')
    expect(tilt).toHaveValue(25)
    const modulesPerRow = screen.getByRole('spinbutton', { name: 'Modules per row' })
    const rowOffset = screen.getByRole('spinbutton', { name: 'Row offset in metres' })
    const obstacleClearance = screen.getByRole('spinbutton', { name: 'Obstacle clearance in metres' })
    fireEvent.change(modulesPerRow, { target: { value: '6' } })
    fireEvent.change(rowOffset, { target: { value: '0.35' } })
    fireEvent.change(obstacleClearance, { target: { value: '0.2' } })
    expect(modulesPerRow).toHaveValue(6)
    expect(rowOffset).toHaveValue(0.35)
    expect(obstacleClearance).toHaveValue(0.2)
  })

  it('keeps tiny pointer jitter as one manual placement and cancels array previews without history', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tiny surface jitter' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Panel' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel surface array' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toBeInTheDocument()
    })
  })

  it('draws one normalised obstacle, exposes a live draft, and cancels or ignores tiny drags', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: 'Activate roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: /^Obstacle/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Draft obstacle' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    expect(screen.getByText('Obstacle preview · 4.00 × 2.00 m')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText(/Obstacle preview/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Obstacle/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Draw obstacle' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Remove obstacle/ })).toBeInTheDocument()
    })
    expect(screen.getByText('8.00 × 4.00 m')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Obstacle/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Tiny obstacle' }))
    expect(screen.getAllByRole('button', { name: /Remove obstacle/ })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: /^Obstacle/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel obstacle' }))
    expect(screen.getAllByRole('button', { name: /Remove obstacle/ })).toHaveLength(1)
  })

  it('moves and numerically edits an obstacle with chronological undo and redo', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: 'Activate roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: /^Obstacle/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Draw obstacle' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move obstacle' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))

    const x = screen.getByRole('spinbutton', { name: 'Obstacle 1 X position in metres' })
    const y = screen.getByRole('spinbutton', { name: 'Obstacle 1 Y position in metres' })
    const width = screen.getByRole('spinbutton', { name: 'Obstacle 1 width in metres' })
    expect(x).toHaveValue(2)
    expect(y).toHaveValue(1)
    expect(width).toHaveValue(8)

    fireEvent.change(width, { target: { value: '5' } })
    fireEvent.blur(width)
    await waitFor(() => { expect(width).toHaveValue(5) })

    fireEvent.click(screen.getByRole('button', { name: 'Undo last action' }))
    await waitFor(() => { expect(width).toHaveValue(8) })
    fireEvent.click(screen.getByRole('button', { name: 'Undo last action' }))
    await waitFor(() => {
      expect(x).toHaveValue(0)
      expect(y).toHaveValue(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Redo last action' }))
    await waitFor(() => {
      expect(x).toHaveValue(2)
      expect(y).toHaveValue(1)
    })
  })

  it('disables panel interception while the obstacle tool owns surface pointer input', () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: 'Activate roof surface' }))
    expect(screen.getByTestId('mock-panel-interactions')).toHaveTextContent('enabled')

    fireEvent.click(screen.getByRole('button', { name: /^Obstacle/ }))
    expect(screen.getByTestId('mock-panel-interactions')).toHaveTextContent('disabled')
  })

  it('disables panel interception while the place tool owns surface pointer input', () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: 'Activate roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))

    expect(screen.getByTestId('mock-panel-interactions')).toHaveTextContent('disabled')
  })

  it('keeps Place armed after a rejected manual commit and only returns to Select after commit', async () => {
    render(<App webglAvailable />)
    // Match the production order: select a surface first, then arm a panel.
    // The invalid point deliberately falls outside the panel-safe setback.
    fireEvent.click(screen.getByRole('button', { name: 'Activate roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    expect(screen.getByTitle('Place (P)')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Start invalid surface pointer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finish invalid surface pointer' }))
    expect(screen.getByTitle('Place (P)')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTitle('Select (V)')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    expect(screen.getByText(/Panel layout: 0 panels.*1 dragging/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Start surface pointer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finish surface pointer' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: 1 panel/)).toBeInTheDocument()
      expect(screen.getByTitle('Select (V)')).toHaveAttribute('aria-pressed', 'true')
    })
    expect(screen.getByText(/Panel layout: 1 panel/)).not.toHaveTextContent('dragging')
  })

  it('passes the active surface obstacle to auto-fill so a covered roof has no candidates', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: 'Activate roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: /^Obstacle/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Draw obstacle' }))
    fireEvent.click(screen.getByRole('button', { name: /^Auto-fill/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Auto-fill preview' })).toBeInTheDocument()
    })
    expect(screen.getByText('0 candidate panels · 0.00 kWp')).toBeInTheDocument()
  })

  it('removes and clears obstacles, and a controlled source reset clears their surface state', async () => {
    const firstSource = { obj: new File(['v 0 0 0'], 'first.obj', { type: 'text/plain' }), name: 'first.obj' }
    const secondSource = { obj: new File(['v 0 0 0'], 'second.obj', { type: 'text/plain' }), name: 'second.obj' }
    const view = render(<App source={firstSource} webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: 'Activate roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: /^Obstacle/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Draw obstacle' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Remove obstacle/ })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Clear all obstacles' }))
    expect(screen.queryByRole('button', { name: /Remove obstacle/ })).not.toBeInTheDocument()
    expect(screen.getByText('No obstacles on this surface.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Obstacle/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Draw obstacle' }))
    expect(screen.getByRole('button', { name: /Remove obstacle/ })).toBeInTheDocument()
    view.rerender(<App source={secondSource} webglAvailable />)
    await waitFor(() => {
      expect(screen.getByTestId('mock-source')).toHaveTextContent('second.obj')
      expect(screen.queryByRole('button', { name: /Remove obstacle/ })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Obstacle/ })).toBeDisabled()
      expect(screen.getByTestId('mock-panel-interactions')).toHaveTextContent('enabled')
    })
  })

  it('previews, cancels, and confirms an auto-fill layout from the inspector', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: 'Activate roof surface' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    fireEvent.click(screen.getByRole('button', { name: 'Auto-fill surface' }))

    expect(screen.getByRole('heading', { name: 'Auto-fill preview' })).toBeInTheDocument()
    expect(screen.getAllByText(/kWp/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel preview' }))
    expect(screen.queryByRole('heading', { name: 'Auto-fill preview' })).not.toBeInTheDocument()
    expect(screen.getByText(/Panel layout: 0 panels/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Auto-fill surface' }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Auto-fill preview' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm layout' }))
    await waitFor(() => {
      expect(screen.getByText(/Panel layout: \d+ panels?/)).not.toHaveTextContent(/0 panels/)
    })
  })

  it('applies inspector settings and keeps align behind an explicit confirmation dialog', () => {
    render(<AlignInspectorHarness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))

    const clearance = screen.getByLabelText('Panel clearance in metres')
    const tilt = screen.getByLabelText('Panel tilt in degrees')
    fireEvent.change(clearance, { target: { value: '0.25' } })
    fireEvent.change(tilt, { target: { value: '35' } })
    expect(clearance).toHaveValue(0.25)
    expect(tilt).toHaveValue(35)
    expect(screen.getByTestId('settings-scope')).toHaveTextContent('Editing Group array-1')

    fireEvent.click(screen.getByRole('button', { name: /^Align/ }))
    expect(screen.getByRole('dialog', { name: 'Confirm alignment' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply alignment' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply alignment' }))
    expect(screen.queryByRole('dialog', { name: /alignment/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Align/ }))
    expect(screen.getByRole('dialog', { name: 'Confirm alignment' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply alignment' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('dialog', { name: /alignment/i })).not.toBeInTheDocument()
  })

  it('routes advanced inspector edits to one group and clears optional fields without coercion', () => {
    render(<SettingsBridgeHarness />)
    const inspectorTab = screen.getByRole('tab', { name: 'Inspector' })

    const settingsOutput = screen.getByTestId('bridge-settings')
    act(() => { fireEvent.click(inspectorTab) })
    const scope = screen.getByTestId('settings-scope')
    expect(scope).toHaveTextContent('Editing Group array-bridge')

    const groupModules = screen.getByRole('spinbutton', { name: 'Modules per row' })
    expect(groupModules).toHaveValue(null)

    act(() => { fireEvent.change(groupModules, { target: { value: '6' } }) })
    expect(settingsOutput).toHaveTextContent('"modulesPerRow":6')

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear selected group' }))
    })
    expect(scope).toHaveTextContent('Editing Global defaults')
    const globalModules = screen.getByRole('spinbutton', { name: 'Modules per row' })
    expect(globalModules).toHaveValue(null)
    expect(settingsOutput).not.toHaveTextContent('modulesPerRow')
    act(() => { fireEvent.change(globalModules, { target: { value: '7' } }) })
    expect(settingsOutput).toHaveTextContent('"modulesPerRow":7')

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Select bridge group' }))
    })
    expect(scope).toHaveTextContent('Editing Group array-bridge')
    expect(screen.getByRole('spinbutton', { name: 'Modules per row' })).toHaveValue(6)

    act(() => {
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Modules per row' }), { target: { value: '' } })
    })
    expect(screen.getByRole('spinbutton', { name: 'Modules per row' })).toHaveValue(null)
    expect(settingsOutput).not.toHaveTextContent('modulesPerRow')
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear selected group' }))
    })
    expect(scope).toHaveTextContent('Editing Global defaults')
    expect(screen.getByRole('spinbutton', { name: 'Modules per row' })).toHaveValue(7)
  })

  it('selects multiple placements with a local surface box', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Place second panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select surface box' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))
    await waitFor(() => {
      expect(screen.getByText(/selected/)).toHaveTextContent(/2 selected/)
    })
  })

  it('holds the surface-box camera lock until pointerup or pointercancel', async () => {
    render(<App webglAvailable />)

    fireEvent.click(screen.getByRole('button', { name: 'Start selection box gesture' }))
    expect(screen.getByTestId('mock-surface-gesture')).toHaveTextContent('active')

    fireEvent.click(screen.getByRole('button', { name: 'Finish selection box gesture' }))
    await waitFor(() => {
      expect(screen.getByTestId('mock-surface-gesture')).toHaveTextContent('idle')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Start selection box gesture' }))
    expect(screen.getByTestId('mock-surface-gesture')).toHaveTextContent('active')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel selection box gesture' }))
    await waitFor(() => {
      expect(screen.getByTestId('mock-surface-gesture')).toHaveTextContent('idle')
    })
  })

  it('drags the existing multi-selection as one move when the grabbed panel is already selected', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Place second panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select surface box' }))

    const idsBefore = screen.getByTestId('mock-placement-ids').textContent
    const centersBefore = screen.getByTestId('mock-placement-centers').textContent
    expect(idsBefore.split(',')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Drag existing panel' }))
    await waitFor(() => {
      expect(screen.getByTestId('mock-placement-ids')).toHaveTextContent(idsBefore)
      expect(screen.getByTestId('mock-placement-centers').textContent).not.toBe(centersBefore)
    })

    const centersAfter = screen.getByTestId('mock-placement-centers').textContent
    const beforeById = new Map(centersBefore.split('|').map((entry) => {
      const [id, coordinates = ''] = entry.split(':')
      const [x = '', y = ''] = coordinates.split(',')
      return [id, { x: Number(x), y: Number(y) }] as const
    }))
    const afterById = new Map(centersAfter.split('|').map((entry) => {
      const [id, coordinates = ''] = entry.split(':')
      const [x = '', y = ''] = coordinates.split(',')
      return [id, { x: Number(x), y: Number(y) }] as const
    }))
    for (const id of idsBefore.split(',')) {
      const before = beforeById.get(id)
      const after = afterById.get(id)
      expect(before).toBeDefined()
      expect(after).toBeDefined()
      expect(after?.x).toBeCloseTo((before?.x ?? 0) + 0.5)
      expect(after?.y).toBeCloseTo((before?.y ?? 0) + 0.2)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Undo last action' }))
    await waitFor(() => {
      expect(screen.getByTestId('mock-placement-ids')).toHaveTextContent(idsBefore)
      expect(screen.getByTestId('mock-placement-centers')).toHaveTextContent(centersBefore)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Redo last action' }))
    await waitFor(() => {
      expect(screen.getByTestId('mock-placement-ids')).toHaveTextContent(idsBefore)
      expect(screen.getByTestId('mock-placement-centers')).toHaveTextContent(centersAfter)
    })
  }, 15_000)
})
