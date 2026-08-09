import { expect, test, type Page } from '@playwright/test'

const READY_TIMEOUT = 90_000

async function canvasPoint(page: Page, xRatio: number, yRatio: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('Viewer canvas did not expose a layout box')
  return { x: box.x + box.width * xRatio, y: box.y + box.height * yRatio }
}

test.describe('PV Studio mobile touch workflow', () => {
  test('opens the compact workspace, selects a surface by touch, and switches view modes', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('pv-shell')).toBeVisible({ timeout: READY_TIMEOUT })
    await expect.poll(async () => page.locator('canvas').count(), {
      timeout: READY_TIMEOUT,
      intervals: [250, 500, 1_000],
      message: 'Three.js viewer canvas did not mount on mobile',
    }).toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: 'Open panel', exact: true })).toBeVisible({ timeout: READY_TIMEOUT })

    const center = await canvasPoint(page, 0.50, 0.55)
    await page.touchscreen.tap(center.x, center.y)
    await expect(page.locator('.surface-chip')).toBeVisible({ timeout: READY_TIMEOUT })

    const camera = page.getByRole('group', { name: 'Camera mode' })
    const render = page.getByRole('group', { name: 'Render mode' })
    await camera.getByRole('button', { name: '2D plan', exact: true }).click()
    await render.getByRole('button', { name: 'Wire', exact: true }).click()
    await expect(camera.getByRole('button', { name: '2D plan', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(render.getByRole('button', { name: 'Wire', exact: true })).toHaveAttribute('aria-pressed', 'true')

    // Return to the perspective/textured placement view before arming a
    // module.  The phone workflow exercises both view modes, but placement is
    // verified against the same perspective surface geometry as desktop.
    await camera.getByRole('button', { name: '3D', exact: true }).click()
    await render.getByRole('button', { name: 'Texture', exact: true }).click()

    await page.getByRole('button', { name: 'Open panel', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Panel', exact: true })).toBeVisible()
    await expect(page.getByTestId('panel-chooser')).toBeVisible()
    await page.getByRole('tab', { name: 'Panel', exact: true }).click()
    await page.getByRole('button', { name: '+ Panel', exact: true }).click()

    // Close the sheet before sending a second touch to the canvas. This is
    // the same gesture a phone user makes after choosing a module.
    await page.getByRole('button', { name: 'Close side panel', exact: true }).click()
    // The compact sheet animates off-canvas.  Wait until its close control is
    // actually hidden so the following touchscreen tap lands on WebGL rather
    // than the still-transitioning backdrop.
    await expect(page.getByRole('button', { name: 'Close side panel', exact: true })).toBeHidden({ timeout: 10_000 })
    const ground = await canvasPoint(page, 0.50, 0.64)
    await page.touchscreen.tap(ground.x, ground.y)

    // The status summary only exists while the inspector sheet is open.  Reopen
    // it and assert a committed module (not merely a draft attached to the
    // cursor), proving the complete touch placement path.
    await page.getByRole('button', { name: 'Open panel', exact: true }).click()
    await page.getByRole('tab', { name: 'Inspector', exact: true }).click()
    await expect(page.locator('[data-panel-render-status="true"]')).toHaveText(/Panel layout: 1 panel(?: ·|$)/, { timeout: READY_TIMEOUT })
  })
})
