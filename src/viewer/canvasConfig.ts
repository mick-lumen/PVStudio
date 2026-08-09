export interface ViewerCanvasConfig {
  readonly dpr: [number, number]
  readonly frameloop: 'demand'
}

/**
 * Keep software WebGL and high-density displays from monopolising the main
 * thread while a large model is being analysed. Demand rendering still draws
 * whenever the scene or controls explicitly invalidate the R3F root.
 */
export function createViewerCanvasConfig(devicePixelRatio: number | undefined): ViewerCanvasConfig {
  const ratio = devicePixelRatio !== undefined && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1
  return {
    dpr: [1, Math.min(1.5, Math.max(1, ratio))],
    frameloop: 'demand',
  }
}
