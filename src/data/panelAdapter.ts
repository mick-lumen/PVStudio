import { createPanelDefinition, type PanelDefinition } from '../core'
import { selectPanelWattage, type PanelSpec } from './panelCatalog'

/**
 * Convert a catalogue record's millimetre source values into the canonical
 * metre-based panel contract shared by placement and viewer code.
 *
 * Catalogue families may publish a wattage range.  The midpoint is selected
 * by default so conversion is deterministic; callers can provide a specific
 * value when a family variant has already been resolved.
 */
export const toPanelDefinition = (spec: PanelSpec, wattageW?: number): PanelDefinition =>
  createPanelDefinition({
    id: spec.id,
    manufacturer: spec.manufacturer,
    model: spec.model,
    widthM: spec.width / 1000,
    heightM: spec.length / 1000,
    thicknessM: spec.thickness / 1000,
    wattageW: wattageW ?? selectPanelWattage(spec.wattage),
    weightKg: spec.weight,
  })
