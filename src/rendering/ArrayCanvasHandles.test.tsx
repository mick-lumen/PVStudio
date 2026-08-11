import { describe, expect, it } from 'vitest'
import type { PanelDefinition, PanelPlacement, SurfaceDescriptor } from '../core'
import { selectedArrayHandleAnchor } from './arrayHandleMath'

const panel: PanelDefinition = { id: 'panel', manufacturer: 'Test', model: 'One', widthM: 1, heightM: 2, thicknessM: 0.04, wattageW: 400, weightKg: 22 }
const surface: SurfaceDescriptor = {
  id: 'roof',
  frame: {
    origin: { x: 10, y: 3, z: 20 },
    normal: { x: 0, y: 1, z: 0 },
    tangentX: { x: 1, y: 0, z: 0 },
    tangentY: { x: 0, y: 0, z: 1 },
  },
  region: { points: [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }] },
  area: 400,
  usableArea: 400,
  faceRefs: [],
  tiltDeg: 0,
  azimuthDeg: 0,
}
const placement = (id: string, x: number): PanelPlacement => ({ id, panelId: 'panel', surfaceId: 'roof', groupId: 'array', localCenter: { x, y: 0 }, orientation: 'portrait', clearanceM: 0.1, tiltDeg: 0 })

describe('selectedArrayHandleAnchor', () => {
  it('anchors one toolbar to the centre of the complete selected array and above the roof', () => {
    const anchor = selectedArrayHandleAnchor([placement('a', -1), placement('b', 1)], { panel }, [surface])
    expect(anchor?.panelCount).toBe(2)
    expect(anchor?.position.x).toBeCloseTo(10)
    expect(anchor?.position.y).toBeGreaterThan(3.1)
    expect(Math.abs((anchor?.position.z ?? 20) - 20)).toBeGreaterThan(1)
  })

  it('omits handles when the panel or logical roof is unavailable', () => {
    expect(selectedArrayHandleAnchor([placement('a', 0)], {}, [surface])).toBeUndefined()
    expect(selectedArrayHandleAnchor([], { panel }, [surface])).toBeUndefined()
  })
})
