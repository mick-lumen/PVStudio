import { describe, expect, it } from 'vitest'
import { createProtectedShell, protectedShellFilename } from './sites-vite-plugin'

describe('Sites build protection', () => {
  it('moves application startup behind the server authentication probe', () => {
    const indexHtml = '<html lang="en"><head></head><body><script type="module" crossorigin src="/assets/app-123.js"></script></body></html>'

    const shell = createProtectedShell(indexHtml)

    expect(protectedShellFilename).toBe('pvstudio-shell.html')
    expect(shell).toContain('<html lang="en" data-auth-pending>')
    expect(shell).toContain("fetch('/__pvstudio_auth'")
    expect(shell).toContain('await import("/assets/app-123.js")')
    expect(shell).not.toContain('crossorigin src="/assets/app-123.js"')
    expect(createProtectedShell(shell)).toBe(shell)
  })

  it('rejects an unexpected Vite index shape instead of publishing an unprotected shell', () => {
    expect(() => createProtectedShell('<html><head></head><body></body></html>')).toThrow(
      'Unable to find the production application module',
    )
  })
})
