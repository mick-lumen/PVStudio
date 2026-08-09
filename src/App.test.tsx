import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { PanelPlacement, SurfaceDescriptor } from './core'
import type { PanelPointerInfo } from './rendering'
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
  type MockViewerProps = Pick<ViewerProps, 'source' | 'onSurfacesChange' | 'onSurfaceSelect' | 'onSurfacePointer' | 'sceneContent'>
  type LayerProps = {
    readonly placements?: readonly PanelPlacement[]
    readonly interactionsEnabled?: boolean
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
      <output data-testid="mock-source">{props.source?.name ?? ''}{props.source?.mtl === undefined ? '' : `|${resourceLabel(props.source.mtl)}`}{props.source?.textures === undefined ? '' : `|${props.source.textures.map(resourceLabel).join(',')}`}</output>
      <output data-testid="mock-placement-ids">{layer?.props.placements?.map((placement) => placement.id).join(',') ?? ''}</output>
      <output data-testid="mock-placement-centers">{layer?.props.placements?.map((placement) => `${placement.id}:${placement.localCenter.x.toFixed(2)},${placement.localCenter.y.toFixed(2)}`).join('|') ?? ''}</output>
      <output data-testid="mock-panel-interactions">{layer?.props.interactionsEnabled === false ? 'disabled' : 'enabled'}</output>
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
      <button type="button" onClick={() => {
        const placement = layer?.props.placements?.[0]
        if (placement === undefined || layer === null) return
        layer.props.onPanelDragStart?.(placement, dragInfo(4, 2))
        layer.props.onPanelDrag?.(placement, dragInfo(4.5, 2.2))
        layer.props.onPanelDragEnd?.(placement, dragInfo(4.5, 2.2))
      }}>Drag existing panel</button>
    </div>
    )
  }
  return { Viewer: MockViewer }
})

import { App } from './App'

describe('App', () => {
  it('mounts the workspace and exposes the WebGL fallback', () => {
    render(<App webglAvailable={false} />)
    expect(screen.getByRole('heading', { name: 'PV Studio' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/WebGL/i)
  })

  it('announces a selected import source through the controlled shell boundary', () => {
    render(<App webglAvailable={false} />)
    const input = screen.getByLabelText('Import site model')
    const file = new File(['v 0 0 0'], 'site.obj', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(screen.getByText('Loaded site.obj')).toBeInTheDocument()
  })

  it('passes an OBJ, MTL, and texture bundle to the viewer source boundary', () => {
    render(<App webglAvailable />)
    const input = screen.getByLabelText('Import site model')
    const obj = new File(['v 0 0 0'], 'site.obj', { type: 'text/plain' })
    const mtl = new File(['newmtl roof'], 'site.mtl', { type: 'text/plain' })
    const texture = new File(['png'], 'roof.PNG', { type: 'image/png' })

    fireEvent.change(input, { target: { files: [obj, mtl, texture] } })

    expect(screen.getByTestId('mock-source')).toHaveTextContent('site.obj|site.mtl|roof.PNG')
    expect(screen.getByText('Loaded site.obj')).toBeInTheDocument()
  })

  it('loads the checked-in WebODM fixture through the real URL source without opening the picker', () => {
    render(<App webglAvailable />)
    const filePickerClick = vi.spyOn(HTMLInputElement.prototype, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Load sample WebODM house' }))

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
    expect(screen.getByText('Drawing obstacle · 4.00 × 2.00 m')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText(/Drawing obstacle/)).not.toBeInTheDocument()

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

  it('applies inspector settings and keeps align behind an explicit confirmation dialog', async () => {
    render(<App webglAvailable />)
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select roof surface' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Place second panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select surface box' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }))

    const clearance = screen.getByLabelText('Panel clearance in metres')
    const tilt = screen.getByLabelText('Panel tilt in degrees')
    fireEvent.change(clearance, { target: { value: '0.25' } })
    fireEvent.change(tilt, { target: { value: '35' } })
    expect(clearance).toHaveValue(0.25)
    expect(tilt).toHaveValue(35)

    const centersBeforeAlign = screen.getByTestId('mock-placement-centers').textContent

    fireEvent.click(screen.getByRole('button', { name: /^Align/ }))
    expect(screen.getByRole('dialog', { name: /align/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply alignment' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /align/i })).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('mock-placement-centers').textContent).not.toBe(centersBeforeAlign)

    const spacing = screen.getByLabelText('Panel spacing in metres')
    fireEvent.change(spacing, { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /^Align/ }))
    expect(screen.getByRole('dialog', { name: /align/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply alignment' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /align/i })).not.toBeInTheDocument()
    })
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
