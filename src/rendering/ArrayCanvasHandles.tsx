import { Html } from '@react-three/drei'
import type { ReactNode } from 'react'
import type { PanelDefinition, PanelPlacement, SurfaceDescriptor } from '../core'
import { selectedArrayHandleAnchor } from './arrayHandleMath'

export interface ArrayCanvasHandlesProps {
  readonly placements: readonly PanelPlacement[]
  readonly panelDefinitions: Readonly<Record<string, PanelDefinition>>
  readonly surfaces: readonly SurfaceDescriptor[]
  readonly onMove: () => void
  readonly onRotate: () => void
}

/** OpenSolar-style controls that stay attached to the selected array in the 3D scene. */
export function ArrayCanvasHandles({
  placements,
  panelDefinitions,
  surfaces,
  onMove,
  onRotate,
}: ArrayCanvasHandlesProps): ReactNode {
  const anchor = selectedArrayHandleAnchor(placements, panelDefinitions, surfaces)
  if (anchor === undefined) return null
  const stopPointer = (event: { stopPropagation: () => void }): void => { event.stopPropagation() }
  return (
    <Html center position={[anchor.position.x, anchor.position.y, anchor.position.z]} zIndexRange={[40, 0]}>
      <div className="array-canvas-handles" role="toolbar" aria-label={`Selected array, ${String(anchor.panelCount)} panels`} onPointerDown={stopPointer} onClick={stopPointer}>
        <button type="button" className="array-canvas-handle" aria-label="Move selected array" title="Move array: drag any panel" onClick={onMove}>↔<span>Move</span></button>
        <button type="button" className="array-canvas-handle" aria-label="Rotate selected array 90 degrees" title="Rotate array 90°" onClick={onRotate}>↻<span>Rotate</span></button>
      </div>
    </Html>
  )
}
