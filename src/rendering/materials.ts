import * as THREE from 'three'

export type PanelVisualState = 'placed' | 'selected' | 'ghost' | 'invalid'

/**
 * Panel-specific visual metadata kept outside the canonical core contract.
 * A catalogue adapter can provide this from its cell-count/frame-colour
 * fields without putting Three.js concerns into `PanelDefinition`.
 */
export interface PanelVisualProperties {
  /** Optional catalogue cell count; columns/rows are the resolved render grid. */
  readonly cellCount?: number
  readonly cellColumns: number
  readonly cellRows: number
  readonly cellLineWidthM: number
  readonly frameColor: number
  readonly glassColor: number
  readonly cellColor: number
  readonly outlineColor: number
}

export interface PanelMaterialPalette {
  readonly frame: number
  readonly glass: number
  readonly cell: number
  readonly outline: number
  readonly ghostFrame: number
  readonly ghostGlass: number
  readonly ghostCell: number
}

/** Solar-module colours are intentionally neutral so they remain legible over photogrammetry textures. */
export const PANEL_MATERIAL_PALETTE: PanelMaterialPalette = Object.freeze({
  frame: 0x4f5f68,
  glass: 0x081a2c,
  cell: 0x3c7d9d,
  outline: 0x2e9cff,
  ghostFrame: 0x7bc4ff,
  ghostGlass: 0x58a9df,
  ghostCell: 0x9edcff,
})

export const PANEL_FRAME_WIDTH_M = 0.026
export const PANEL_CELL_LINE_WIDTH_M = 0.003
export const PANEL_CELL_COLUMNS = 6
export const PANEL_CELL_ROWS = 12

export const DEFAULT_PANEL_VISUAL_PROPERTIES: PanelVisualProperties = Object.freeze({
  cellCount: PANEL_CELL_COLUMNS * PANEL_CELL_ROWS,
  cellColumns: PANEL_CELL_COLUMNS,
  cellRows: PANEL_CELL_ROWS,
  cellLineWidthM: PANEL_CELL_LINE_WIDTH_M,
  frameColor: PANEL_MATERIAL_PALETTE.frame,
  glassColor: PANEL_MATERIAL_PALETTE.glass,
  cellColor: PANEL_MATERIAL_PALETTE.cell,
  outlineColor: PANEL_MATERIAL_PALETTE.outline,
})

export interface PanelMaterialSet {
  readonly frame: THREE.MeshStandardMaterial
  readonly glass: THREE.MeshStandardMaterial
  readonly cell: THREE.MeshStandardMaterial
}

const opaqueMaterial = (colour: number, metalness: number, roughness: number): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: colour, metalness, roughness })

/**
 * Build one shared material set per batch. No panel creates its own material,
 * which keeps renderer state bounded for large arrays.
 */
export function createPanelMaterialSet(
  state: PanelVisualState = 'placed',
  visualProperties: PanelVisualProperties = DEFAULT_PANEL_VISUAL_PROPERTIES,
): PanelMaterialSet {
  const ghost = state === 'ghost'
  const invalid = state === 'invalid'
  const selected = state === 'selected'
  const frame = opaqueMaterial(
    invalid ? 0xff3b30 : ghost ? PANEL_MATERIAL_PALETTE.ghostFrame : selected ? visualProperties.outlineColor : visualProperties.frameColor,
    selected ? 0.3 : 0.72,
    selected ? 0.28 : 0.34,
  )
  const glass = opaqueMaterial(
    invalid ? 0x7f1d1d : ghost ? PANEL_MATERIAL_PALETTE.ghostGlass : visualProperties.glassColor,
    selected ? 0.48 : 0.36,
    selected ? 0.2 : 0.24,
  )
  const cell = opaqueMaterial(
    invalid ? 0xef4444 : ghost ? PANEL_MATERIAL_PALETTE.ghostCell : visualProperties.cellColor,
    0.1,
    0.38,
  )
  if (ghost || invalid) {
    frame.transparent = true
    frame.opacity = 0.48
    frame.depthWrite = false
    glass.transparent = true
    glass.opacity = 0.3
    glass.depthWrite = false
    cell.transparent = true
    cell.opacity = 0.38
    cell.depthWrite = false
  }
  if (invalid) {
    frame.opacity = 0.92
    glass.opacity = 0.52
    cell.opacity = 0.68
    glass.emissive.setHex(0x991b1b)
    glass.emissiveIntensity = 0.75
  }
  if (selected) {
    glass.emissive.setHex(0x073a69)
    glass.emissiveIntensity = 0.72
    cell.emissive.setHex(0x0c5e95)
    cell.emissiveIntensity = 0.3
  }
  return { frame, glass, cell }
}

const materialCache = new Map<string, PanelMaterialSet>()

const visualKey = (visualProperties: PanelVisualProperties): string => [
  visualProperties.cellCount ?? '',
  visualProperties.cellColumns,
  visualProperties.cellRows,
  visualProperties.cellLineWidthM,
  visualProperties.frameColor,
  visualProperties.glassColor,
  visualProperties.cellColor,
  visualProperties.outlineColor,
].join(':')

/** Shared sets keep material count bounded when many batches share a model. */
export function getSharedPanelMaterialSet(
  state: PanelVisualState,
  visualProperties: PanelVisualProperties = DEFAULT_PANEL_VISUAL_PROPERTIES,
): PanelMaterialSet {
  const key = `${state}:${visualKey(visualProperties)}`
  const cached = materialCache.get(key)
  if (cached !== undefined) return cached
  const created = createPanelMaterialSet(state, visualProperties)
  materialCache.set(key, created)
  return created
}

/** Explicit teardown hook for tests or application shutdown; components do not dispose shared sets. */
export function disposeSharedPanelMaterialSets(): void {
  for (const materials of materialCache.values()) disposePanelMaterialSet(materials)
  materialCache.clear()
}

export function disposePanelMaterialSet(materials: PanelMaterialSet): void {
  materials.frame.dispose()
  materials.glass.dispose()
  materials.cell.dispose()
}
