import { describe, expect, it } from 'vitest'
import type { RectangularObstacle, SurfaceDescriptor } from '../core'
import { buildObstacleRenderItems } from './obstacleLayout'

const surface: SurfaceDescriptor = {
  id: 'roof',
  frame: {
    origin: { x: 10, y: 20, z: 2 },
    normal: { x: 0, y: 0, z: 1 },
    tangentX: { x: 1, y: 0, z: 0 },
    tangentY: { x: 0, y: 1, z: 0 },
  },
  region: { x: 0, y: 0, width: 8, height: 4 },
  area: 32,
  azimuthDeg: 180,
  tiltDeg: 0,
  usableArea: 32,
  faceRefs: [],
}

const obstacle = (id: string, x: number, y: number, width: number, height: number): RectangularObstacle => ({ id, x, y, width, height })

describe('obstacle render layout', () => {
  it('maps local lower-left rectangles to surface-aligned scaled matrices', () => {
    const [item] = buildObstacleRenderItems([surface], { roof: [obstacle('shade', 1, 2, 3, 1)] })
    expect(item?.dimensions).toEqual([3, 1, 0.025])
    expect(item?.matrix[0]).toBe(3)
    expect(item?.matrix[5]).toBe(1)
    expect(item?.matrix[10]).toBeCloseTo(0.025)
    expect(item?.matrix[12]).toBe(12.5)
    expect(item?.matrix[13]).toBe(22.5)
    expect(item?.matrix[14]).toBeCloseTo(2.0125)
  })

  it('renders only a draft for the requested surface and skips invalid DTOs', () => {
    const items = buildObstacleRenderItems(
      [surface, { ...surface, id: 'other' }],
      { roof: [obstacle('valid', 0, 0, 1, 1), obstacle('tiny', 0, 0, 0, 2)] },
      obstacle('draft', 2, 1, 0.5, 0.5),
      'roof',
    )
    expect(items.map((item) => `${item.kind}:${item.obstacle.id}`)).toEqual(['persistent:valid', 'draft:draft'])
    expect(buildObstacleRenderItems([surface], {}, obstacle('draft', 0, 0, 1, 1), 'other')).toHaveLength(0)
  })
})
