import { describe, expect, it } from 'vitest'
import { DEFAULT_PANEL_GROUP_SETTINGS, type PanelPlacement } from '../core'
import { derivePanelArrays } from './arrays'

const placement = (id: string, groupId?: string): PanelPlacement => ({
  id,
  panelId: 'module-a',
  surfaceId: 'roof-a',
  localCenter: { x: id.length, y: 2 },
  orientation: 'portrait',
  clearanceM: 0.1,
  tiltDeg: 5,
  ...(groupId === undefined ? {} : { groupId }),
})

describe('derivePanelArrays', () => {
  it('exposes grouped placements as one stable array and legacy panels as stable single arrays', () => {
    const arrays = derivePanelArrays({ a: placement('a', 'array-a'), b: placement('b', 'array-a'), c: placement('c') }, {
      'array-a': { ...DEFAULT_PANEL_GROUP_SETTINGS, azimuthDeg: 25 },
    }, DEFAULT_PANEL_GROUP_SETTINGS)
    expect(arrays).toHaveLength(2)
    expect(arrays.find((array) => array.id === 'array-a')).toMatchObject({ placementIds: ['a', 'b'], panelId: 'module-a', surfaceId: 'roof-a' })
    expect(arrays.find((array) => array.id === 'array-a')?.settings.azimuthDeg).toBe(25)
    expect(arrays.find((array) => array.id === 'single:c')?.placementIds).toEqual(['c'])
  })
})
