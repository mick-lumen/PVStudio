import { describe, expect, it } from 'vitest'
import { normaliseE2eBaseUrl } from './e2eBaseUrl'

describe('normaliseE2eBaseUrl', () => {
  it('preserves root deployments and adds a trailing slash to project deployments', () => {
    expect(normaliseE2eBaseUrl('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173/')
    expect(normaliseE2eBaseUrl('https://example.test/PVStudio')).toBe('https://example.test/PVStudio/')
    expect(normaliseE2eBaseUrl('https://example.test/PVStudio/')).toBe('https://example.test/PVStudio/')
  })

  it('rejects ambiguous query and fragment deployment URLs', () => {
    expect(() => normaliseE2eBaseUrl('https://example.test/PVStudio?preview=1')).toThrow(/query string/u)
    expect(() => normaliseE2eBaseUrl('https://example.test/PVStudio#preview')).toThrow(/fragment/u)
  })
})
