import { type ThreeEvent } from '@react-three/fiber'
import { useMemo, type ReactNode } from 'react'
import * as THREE from 'three'
import type { PanelDefinition, PanelPlacement, SurfaceDescriptor, SurfaceEdgeMetadata } from '../core'
import { computePanelPose } from './math'

export interface PanelSlotOutline {
  readonly placement: PanelPlacement
  readonly panel: PanelDefinition
  readonly surface: SurfaceDescriptor
  readonly edge?: SurfaceEdgeMetadata | null
  readonly valid?: boolean
  readonly reason?: string
}

export interface PanelSlotOutlinesProps {
  readonly slots: readonly PanelSlotOutline[]
  readonly onAdd?: (placement: PanelPlacement) => void
  readonly onRejected?: (reason: string) => void
}

function PanelSlot({ slot, onAdd, onRejected }: { readonly slot: PanelSlotOutline; readonly onAdd?: (placement: PanelPlacement) => void; readonly onRejected?: (reason: string) => void }): ReactNode {
  const pose = useMemo(
    () => computePanelPose(slot.panel, slot.surface, slot.placement, slot.edge),
    [slot],
  )
  const matrix = useMemo(() => new THREE.Matrix4().fromArray(pose.matrix), [pose.matrix])
  const width = pose.footprint.widthM
  const height = pose.footprint.heightM
  const stroke = Math.min(0.035, Math.max(0.018, Math.min(width, height) * 0.025))
  const lift = Math.max(0.025, pose.thicknessM / 2 + 0.012)
  const valid = slot.valid !== false
  const colour = valid ? '#ffffff' : '#ef4444'
  const handlePointerDown = (event: ThreeEvent<PointerEvent>): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    if (valid) onAdd?.(slot.placement)
    else onRejected?.(slot.reason ?? 'This panel position is invalid.')
  }
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <mesh position={[0, height / 2, lift]} renderOrder={20}><boxGeometry args={[width + stroke, stroke, stroke]} /><meshBasicMaterial color={colour} transparent opacity={0.92} depthWrite={false} /></mesh>
      <mesh position={[0, -height / 2, lift]} renderOrder={20}><boxGeometry args={[width + stroke, stroke, stroke]} /><meshBasicMaterial color={colour} transparent opacity={0.92} depthWrite={false} /></mesh>
      <mesh position={[width / 2, 0, lift]} renderOrder={20}><boxGeometry args={[stroke, height + stroke, stroke]} /><meshBasicMaterial color={colour} transparent opacity={0.92} depthWrite={false} /></mesh>
      <mesh position={[-width / 2, 0, lift]} renderOrder={20}><boxGeometry args={[stroke, height + stroke, stroke]} /><meshBasicMaterial color={colour} transparent opacity={0.92} depthWrite={false} /></mesh>
      <mesh name="pv-panel-slot-hit-target" position={[0, 0, lift]} renderOrder={19} onPointerDown={handlePointerDown}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial color={colour} transparent opacity={0.001} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

/** White, clickable outlines showing valid places where a selected array can grow. */
export function PanelSlotOutlines({ slots, onAdd, onRejected }: PanelSlotOutlinesProps): ReactNode {
  return (
    <group name="pv-panel-slot-outlines">
      {slots.map((slot) => <PanelSlot key={slot.placement.id} slot={slot} onAdd={onAdd} onRejected={onRejected} />)}
    </group>
  )
}
