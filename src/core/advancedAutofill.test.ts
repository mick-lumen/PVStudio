import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANEL_GROUP_SETTINGS,
  createPanelGroupSettings,
  isPanelGroupSettings,
} from './index'
import type { PanelGroupSettings } from './index'

const legacySettings: PanelGroupSettings = {
  orientation: 'portrait',
  interPanelSpacingM: 0.02,
  rowSpacingM: 0.03,
  setbackM: 0.2,
  clearanceM: 0.1,
  tiltDeg: 0,
}

describe('commercial auto-fill settings', () => {
  it('keeps legacy defaults and serialised shape unchanged when options are omitted', () => {
    expect(DEFAULT_PANEL_GROUP_SETTINGS).toEqual(legacySettings)
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_PANEL_GROUP_SETTINGS, 'modulesPerRow')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_PANEL_GROUP_SETTINGS, 'rowOffsetM')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_PANEL_GROUP_SETTINGS, 'obstacleClearanceM')).toBe(false)
    expect(createPanelGroupSettings(legacySettings)).toEqual(legacySettings)
  })

  it('accepts and freezes positive row caps, physical stagger and obstacle margin', () => {
    const settings: PanelGroupSettings = {
      ...legacySettings,
      modulesPerRow: 12,
      rowOffsetM: 0.35,
      obstacleClearanceM: 0.2,
    }
    expect(isPanelGroupSettings(settings)).toBe(true)
    const frozen = createPanelGroupSettings(settings)
    expect(frozen).toEqual(settings)
    expect(Object.isFrozen(frozen)).toBe(true)
  })

  it('rejects non-positive/non-integer row caps and non-finite or negative distances', () => {
    expect(isPanelGroupSettings({ ...legacySettings, modulesPerRow: 0 })).toBe(false)
    expect(isPanelGroupSettings({ ...legacySettings, modulesPerRow: -1 })).toBe(false)
    expect(isPanelGroupSettings({ ...legacySettings, modulesPerRow: 1.5 })).toBe(false)
    expect(isPanelGroupSettings({ ...legacySettings, modulesPerRow: Number.NaN })).toBe(false)
    expect(isPanelGroupSettings({ ...legacySettings, rowOffsetM: -0.01 })).toBe(false)
    expect(isPanelGroupSettings({ ...legacySettings, rowOffsetM: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isPanelGroupSettings({ ...legacySettings, obstacleClearanceM: -0.01 })).toBe(false)
    expect(isPanelGroupSettings({ ...legacySettings, obstacleClearanceM: Number.NaN })).toBe(false)
  })
})
