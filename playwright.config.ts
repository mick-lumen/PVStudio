import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PVSTUDIO_BASE_URL ?? 'http://127.0.0.1:4173/'
const localServer = process.env.PVSTUDIO_BASE_URL === undefined
const webServerTimeoutMs = Number(process.env.PVSTUDIO_WEB_SERVER_TIMEOUT_MS ?? '480000')

if (!Number.isFinite(webServerTimeoutMs) || webServerTimeoutMs <= 0) {
  throw new Error('PVSTUDIO_WEB_SERVER_TIMEOUT_MS must be a positive finite number')
}

/**
 * Production-browser checks run against the same Vite build surface a user
 * opens. The default executable is the system Chrome image so CI does not
 * download a second browser; PVSTUDIO_CHROME_PATH can select another binary.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'dot',
  outputDir: '/tmp/pvstudio-playwright-results',
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      executablePath: process.env.PVSTUDIO_CHROME_PATH ?? '/usr/bin/google-chrome',
      args: [
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: localServer
    ? {
        command:
          'PVSTUDIO_E2E_STATIC_PREVIEW=true npm run build && PVSTUDIO_E2E_STATIC_PREVIEW=true npm run preview -- --host 127.0.0.1 --port 4173',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: webServerTimeoutMs,
      }
    : undefined,
  projects: [
    {
      name: 'chromium',
      use: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile-chrome',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
})
