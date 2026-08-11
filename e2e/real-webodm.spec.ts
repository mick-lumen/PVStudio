import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const realSampleDirectory = process.env.PVSTUDIO_REAL_SAMPLE_DIR
const realSampleZip = process.env.PVSTUDIO_REAL_SAMPLE_ZIP
const REAL_MODEL_TIMEOUT = 360_000
const ACTION_TIMEOUT = 30_000

const panelStatus = (page: Page) => page.locator('[data-panel-render-status="true"]')

function realSampleFiles(directory: string): readonly string[] {
  const files = readdirSync(directory)
    .filter((name) => /\.(?:obj|mtl|png|jpe?g)$/iu.test(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => join(directory, name))

  if (!files.some((file) => file.toLowerCase().endsWith('.obj'))) {
    throw new Error(`No OBJ file found in ${directory}`)
  }
  return files
}

function realSampleObj(directory: string): string {
  const obj = realSampleFiles(directory).find((file) => file.toLowerCase().endsWith('.obj'))
  if (obj === undefined) throw new Error(`No OBJ file found in ${directory}`)
  return obj
}

async function waitForSurface(page: Page, minimumSurfaceCount = 100): Promise<void> {
  await expect.poll(async () => Number(await page.getByTestId('pv-viewer').getAttribute('data-surface-count') ?? '0'), {
    timeout: REAL_MODEL_TIMEOUT,
    intervals: [500, 1_000, 2_000],
    message: 'The real WebODM model rendered but never became design-ready',
  }).toBeGreaterThanOrEqual(minimumSurfaceCount)
}

async function canvasPoint(page: Page, xRatio: number, yRatio: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('Viewer canvas did not expose a layout box')
  return { x: box.x + box.width * xRatio, y: box.y + box.height * yRatio }
}

async function armPanel(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Panel', exact: true }).click()
  await expect(page.getByTestId('panel-chooser')).toBeVisible({ timeout: ACTION_TIMEOUT })
  await page.getByRole('button', { name: '+ Panel', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Place/u })).toHaveAttribute('aria-pressed', 'true', {
    timeout: ACTION_TIMEOUT,
  })
  await page.getByRole('tab', { name: 'Inspector', exact: true }).click()
}

async function selectFirstVisibleRealSurface(page: Page): Promise<void> {
  const candidates = [
    [0.50, 0.50], [0.46, 0.46], [0.54, 0.46], [0.46, 0.56], [0.54, 0.56],
    [0.42, 0.40], [0.58, 0.40], [0.42, 0.64], [0.58, 0.64],
  ] as const

  await page.getByRole('tab', { name: 'Inspector', exact: true }).click()
  if ((await page.locator('.surface-chip').count()) > 0) return

  for (const [xRatio, yRatio] of candidates) {
    const point = await canvasPoint(page, xRatio, yRatio)
    await page.mouse.click(point.x, point.y)
    if (await page.locator('.surface-chip').count() > 0) return
  }

  throw new Error('The visible real WebODM model did not yield a selectable design surface')
}

async function placePanelOnFirstUsableRealSurface(page: Page): Promise<{ xRatio: number; yRatio: number }> {
  const candidates = [
    [0.50, 0.50], [0.50, 0.58], [0.50, 0.66],
    [0.42, 0.50], [0.58, 0.50], [0.42, 0.58], [0.58, 0.58],
    [0.34, 0.50], [0.66, 0.50], [0.34, 0.60], [0.66, 0.60],
    [0.42, 0.68], [0.58, 0.68],
  ] as const

  await armPanel(page)
  for (const [xRatio, yRatio] of candidates) {
    const point = await canvasPoint(page, xRatio, yRatio)
    await page.mouse.move(point.x, point.y)
    await page.mouse.click(point.x, point.y)
    const text = await panelStatus(page).textContent()
    if (/Panel layout: 1 panel(?: ·|$)/u.test(text ?? '')) return { xRatio, yRatio }

    const placeButton = page.getByRole('button', { name: /^Place/u })
    if (await placeButton.getAttribute('aria-pressed') !== 'true') await armPanel(page)
  }

  throw new Error('No usable panel location was found on the visible real WebODM surfaces')
}

test.describe('real WebODM acceptance', () => {
  test.skip(realSampleDirectory === undefined && realSampleZip === undefined,
    'Set PVSTUDIO_REAL_SAMPLE_ZIP or PVSTUDIO_REAL_SAMPLE_DIR to a WebODM survey')

  test('imports and designs on the supplied WebODM ZIP directly', async ({ page }) => {
    test.skip(realSampleZip === undefined, 'Set PVSTUDIO_REAL_SAMPLE_ZIP to the WebODM ZIP')
    test.setTimeout(REAL_MODEL_TIMEOUT + 60_000)
    if (realSampleZip === undefined) throw new Error('PVSTUDIO_REAL_SAMPLE_ZIP is required')

    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.goto('/')
    await expect(page.getByTestId('pv-shell')).toBeVisible({ timeout: 90_000 })
    await page.getByLabel('Import site model').setInputFiles(realSampleZip)

    await expect(page.locator('.topbar .brand-context')).toHaveText('odm_textured_model_geo.obj', {
      timeout: REAL_MODEL_TIMEOUT,
    })
    await expect(page.getByTestId('pv-viewer').getByText('309,226 polygons')).toBeVisible({
      timeout: REAL_MODEL_TIMEOUT,
    })
    await waitForSurface(page)
    await expect(page.getByTestId('pv-viewer').getByText('857 design surfaces')).toBeVisible()

    await selectFirstVisibleRealSurface(page)
    await placePanelOnFirstUsableRealSurface(page)
    await expect(panelStatus(page)).toHaveText(/Panel layout: 1 panel(?: ·|$)/u, { timeout: ACTION_TIMEOUT })
    await expect(page.getByTestId('settings-scope')).toHaveText(/Editing Group/u)

    const modulesPerRow = page.getByRole('spinbutton', { name: 'Modules per row' })
    const rowOffset = page.getByRole('spinbutton', { name: 'Row offset in metres' })
    const obstacleClearance = page.getByRole('spinbutton', { name: 'Obstacle clearance in metres' })
    await modulesPerRow.fill('5')
    await rowOffset.fill('0.2')
    await expect(modulesPerRow).toHaveValue('5')
    await expect(rowOffset).toHaveValue('0.2')

    const deleteButton = page.getByRole('button', { name: 'Delete selected panels', exact: true })
    await deleteButton.click()
    await expect(panelStatus(page)).toHaveText(/Panel layout: 0 panels/u, { timeout: ACTION_TIMEOUT })
    await expect(page.getByTestId('settings-scope')).toHaveText('Editing Global defaults')
    await expect(modulesPerRow).toHaveValue('')
    await expect(rowOffset).toHaveValue('')

    await modulesPerRow.fill('6')
    await rowOffset.fill('0.25')
    await obstacleClearance.fill('0.4')
    await page.getByRole('button', { name: 'Auto-fill surface', exact: true }).click()

    const previewHeading = page.getByRole('heading', { name: 'Auto-fill preview', exact: true })
    await expect(previewHeading).toBeVisible({ timeout: ACTION_TIMEOUT })
    const previewCard = previewHeading.locator('xpath=ancestor::section[1]')
    const previewCopy = await previewCard.locator('p').textContent()
    const candidateCount = Number(/(\d+) candidate panels?/u.exec(previewCopy ?? '')?.[1] ?? '0')
    expect(candidateCount).toBeGreaterThan(0)

    await page.getByRole('button', { name: 'Confirm layout', exact: true }).click()
    await expect(panelStatus(page)).toHaveText(/Panel layout: [1-9]\d* panels?/u, { timeout: ACTION_TIMEOUT })
    await expect(page.getByTestId('settings-scope')).toHaveText(/Editing Group/u)
    await expect(modulesPerRow).toHaveValue('6')
    await expect(rowOffset).toHaveValue('0.25')
    await expect(obstacleClearance).toHaveValue('0.4')

    await modulesPerRow.fill('4')
    await expect(modulesPerRow).toHaveValue('4')
    const undoButton = page.getByRole('button', { name: 'Undo last action', exact: true })
    await undoButton.click()
    await expect(modulesPerRow).toHaveValue('6')
    const redoButton = page.getByRole('button', { name: 'Redo last action', exact: true })
    await redoButton.click()
    await expect(modulesPerRow).toHaveValue('4')
    expect(pageErrors).toEqual([])
  })

  test('imports the complete textured site and publishes selectable surfaces', async ({ page }) => {
    test.skip(realSampleDirectory === undefined, 'Set PVSTUDIO_REAL_SAMPLE_DIR to the extracted WebODM directory')
    test.setTimeout(REAL_MODEL_TIMEOUT + 60_000)
    if (realSampleDirectory === undefined) throw new Error('PVSTUDIO_REAL_SAMPLE_DIR is required')

    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.goto('/')
    await expect(page.getByTestId('pv-shell')).toBeVisible({ timeout: 90_000 })
    await page.getByLabel('Import site model').setInputFiles(realSampleFiles(realSampleDirectory))

    await expect(page.locator('.topbar .brand-context')).toHaveText('odm_textured_model_geo.obj', {
      timeout: REAL_MODEL_TIMEOUT,
    })
    await expect(page.getByTestId('pv-viewer').getByText('309,226 polygons')).toBeVisible({
      timeout: REAL_MODEL_TIMEOUT,
    })
    await waitForSurface(page)

    await expect(page.getByTestId('pv-viewer').getByText('857 design surfaces')).toBeVisible()
    expect(pageErrors).toEqual([])
  })

  test('places, deletes, and restores a panel on the real site geometry', async ({ page }) => {
    test.skip(realSampleDirectory === undefined, 'Set PVSTUDIO_REAL_SAMPLE_DIR to the extracted WebODM directory')
    test.setTimeout(REAL_MODEL_TIMEOUT + 60_000)
    if (realSampleDirectory === undefined) throw new Error('PVSTUDIO_REAL_SAMPLE_DIR is required')

    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await expect(page.getByTestId('pv-shell')).toBeVisible({ timeout: 90_000 })
    await page.getByLabel('Import site model').setInputFiles(realSampleObj(realSampleDirectory))

    await expect(page.locator('.topbar .brand-context')).toHaveText('odm_textured_model_geo.obj', {
      timeout: REAL_MODEL_TIMEOUT,
    })
    await expect(page.getByTestId('pv-viewer').getByText('309,226 polygons')).toBeVisible({
      timeout: REAL_MODEL_TIMEOUT,
    })
    await waitForSurface(page)

    await selectFirstVisibleRealSurface(page)
    await expect(page.locator('.surface-chip')).toBeVisible({ timeout: ACTION_TIMEOUT })
    await expect(page.locator('.surface-chip')).not.toHaveText(/[0-9a-f]{8}-[0-9a-f-]+:surface-/iu)
    await placePanelOnFirstUsableRealSurface(page)
    await expect(panelStatus(page)).toHaveText(/Panel layout: 1 panel(?: ·|$)/u, { timeout: ACTION_TIMEOUT })

    const deleteButton = page.getByRole('button', { name: 'Delete selected panels', exact: true })
    await expect(deleteButton).toBeEnabled({ timeout: ACTION_TIMEOUT })
    await deleteButton.click()
    await expect(panelStatus(page)).toHaveText(/Panel layout: 0 panels/u, { timeout: ACTION_TIMEOUT })

    const undoButton = page.getByRole('button', { name: 'Undo last action', exact: true })
    await expect(undoButton).toBeEnabled({ timeout: ACTION_TIMEOUT })
    await undoButton.click()
    await expect(panelStatus(page)).toHaveText(/Panel layout: 1 panel(?: ·|$)/u, { timeout: ACTION_TIMEOUT })
    expect(pageErrors).toEqual([])
  })
})
