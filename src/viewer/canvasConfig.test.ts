import { describe, expect, it } from 'vitest'
import { createViewerCanvasConfig } from './canvasConfig'

describe('viewer canvas scheduling', () => {
  it('uses demand rendering and caps high-density DPR at 1.5', () => {
    expect(createViewerCanvasConfig(3)).toEqual({ dpr: [1, 1.5], frameloop: 'demand' })
    expect(createViewerCanvasConfig(1.25)).toEqual({ dpr: [1, 1.25], frameloop: 'demand' })
  })

  it('normalises unavailable or invalid display ratios', () => {
    expect(createViewerCanvasConfig(undefined)).toEqual({ dpr: [1, 1], frameloop: 'demand' })
    expect(createViewerCanvasConfig(Number.NaN)).toEqual({ dpr: [1, 1], frameloop: 'demand' })
    expect(createViewerCanvasConfig(0)).toEqual({ dpr: [1, 1], frameloop: 'demand' })
  })
})
