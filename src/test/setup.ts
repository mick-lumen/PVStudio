import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()

  if (typeof document !== 'undefined') {
    document.documentElement.removeAttribute('data-theme')
  }

  if (typeof window !== 'undefined') {
    window.localStorage.clear()
    window.sessionStorage.clear()
  }
})

/**
 * jsdom intentionally leaves media-query and animation APIs unimplemented.
 * The app only needs their browser-shaped contracts while component tests run;
 * these fallbacks keep tests deterministic without pretending WebGL exists.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
}

if (typeof window !== 'undefined' && typeof window.requestAnimationFrame !== 'function') {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback): number =>
      window.setTimeout(() => {
        callback(window.performance.now())
      }, 16),
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: (handle: number): void => {
      window.clearTimeout(handle)
    },
  })
}
