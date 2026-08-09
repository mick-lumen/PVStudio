export {
  CELL_TYPES,
  FRAME_COLORS,
  PANEL_CATALOG,
  filterPanelCatalog,
  formatWattage,
  getCellTypes,
  getManufacturers,
  normalizePanelSearch,
  parsePanelCatalog,
  parsePanelSpec,
  selectPanelWattage,
} from './panelCatalog'
export type {
  CellType,
  FrameColor,
  PanelDimensions,
  PanelFilters,
  PanelSpec,
  StcRating,
  WattageSelection,
  WattageRange,
} from './panelCatalog'
export { CustomPanelValidationError, createCustomPanel, validateCustomPanel } from './customPanel'
export type {
  CustomPanelInput,
  CustomPanelValidation,
  CustomPanelValidationFailure,
  CustomPanelValidationSuccess,
} from './customPanel'
export { toPanelDefinition } from './panelAdapter'
