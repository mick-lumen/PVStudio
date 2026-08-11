import { expect, test, type Page } from '@playwright/test'

const READY_TIMEOUT = 90_000
const ACTION_TIMEOUT = 30_000
const LARGE_MODEL_READY_TIMEOUT = Number(process.env.PVSTUDIO_LARGE_MODEL_TIMEOUT_MS ?? '240000')

if (!Number.isFinite(LARGE_MODEL_READY_TIMEOUT) || LARGE_MODEL_READY_TIMEOUT <= 0) {
  throw new Error('PVSTUDIO_LARGE_MODEL_TIMEOUT_MS must be a positive finite number')
}

const status = (page: Page) => page.locator('[data-panel-render-status="true"]')

async function canvasPoint(page: Page, xRatio: number, yRatio: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('Viewer canvas did not expose a layout box')
  return { x: box.x + box.width * xRatio, y: box.y + box.height * yRatio }
}

async function waitForViewer(page: Page): Promise<void> {
  // Keep the configured deployment path (for example /PVStudio/ on Pages)
  // instead of resolving to the hosting origin root.
  await page.goto('./')
  await expect(page.getByTestId('pv-shell')).toBeVisible({ timeout: READY_TIMEOUT })
  await expect.poll(async () => page.locator('canvas').count(), {
    timeout: READY_TIMEOUT,
    intervals: [250, 500, 1_000],
    message: 'Three.js viewer canvas did not mount',
  }).toBeGreaterThan(0)
  await expect(page.getByTestId('pv-viewer')).toBeVisible({ timeout: READY_TIMEOUT })
  await expect.poll(async () => page.locator('.surface-chip').count(), {
    timeout: READY_TIMEOUT,
    intervals: [250, 500, 1_000],
    message: 'Viewer did not publish an active surface',
  }).toBeGreaterThan(0)
}

async function clickCanvas(page: Page, xRatio: number, yRatio: number): Promise<void> {
  const point = await canvasPoint(page, xRatio, yRatio)
  await page.mouse.click(point.x, point.y)
}

async function dragCanvas(
  page: Page,
  start: { xRatio: number; yRatio: number },
  end: { xRatio: number; yRatio: number },
  steps = 8,
): Promise<void> {
  const from = await canvasPoint(page, start.xRatio, start.yRatio)
  const to = await canvasPoint(page, end.xRatio, end.yRatio)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
}

async function chooseInspector(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Inspector', exact: true }).click()
  await expect(page.getByRole('tabpanel', { name: 'Inspector', exact: true })).toBeVisible({ timeout: ACTION_TIMEOUT })
}

async function choosePanelTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Panel', exact: true }).click()
  await expect(page.getByTestId('panel-chooser')).toBeVisible({ timeout: ACTION_TIMEOUT })
}

async function armPanel(page: Page): Promise<void> {
  await choosePanelTab(page)
  await page.getByRole('button', { name: '+ Panel', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Place/ })).toHaveAttribute('aria-pressed', 'true', { timeout: ACTION_TIMEOUT })
}

async function waitForPanelCount(page: Page, count: number): Promise<void> {
  const expression = count === 1
    ? /Panel layout: 1 panel(?: ·|$)/
    : new RegExp(`Panel layout: ${String(count)} panels?(?: ·|$)`)
  await expect(status(page)).toHaveText(expression, { timeout: ACTION_TIMEOUT })
}

async function projectMetric(page: Page, label: string): Promise<string> {
  const card = page.getByRole('heading', { name: 'Array status', exact: true }).locator('..').locator('..')
  return (await card.locator('dt', { hasText: label }).locator('..').locator('dd').textContent())?.trim() ?? ''
}

async function commitNumberSetting(page: Page, label: string, value: string): Promise<void> {
  const input = page.getByLabel(label)
  await input.fill(value)
  await input.blur()
  await expect(input).toHaveValue(value)
}

async function placePanelPair(page: Page): Promise<void> {
  await page.getByRole('group', { name: 'Camera mode' }).getByRole('button', { name: '2D plan', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Camera mode' }).getByRole('button', { name: '2D plan', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await armPanel(page)
  await chooseInspector(page)
  await clickCanvas(page, 0.46, 0.68)
  await waitForPanelCount(page, 1)

  // Arm the same catalogue module again and use a nearby, non-overlapping
  // point on the ground plane.  Keeping both placements on one surface makes
  // selection-box and alignment behavior deterministic.
  await armPanel(page)
  await chooseInspector(page)
  await clickCanvas(page, 0.54, 0.68)
  await waitForPanelCount(page, 2)
}

async function selectGroundPair(page: Page): Promise<void> {
  // The box starts and ends on the visible ground face, enclosing both
  // placements while avoiding the roof ridge and the side-panel overlay.
  await dragCanvas(page, { xRatio: 0.40, yRatio: 0.62 }, { xRatio: 0.60, yRatio: 0.75 }, 10)
  await expect(status(page)).toHaveText(/Panel layout: 2 panels · 2 selected(?: ·|$)/, { timeout: ACTION_TIMEOUT })
}

test.describe('PV Studio production-browser workflow', () => {
  test('loads the sample model, switches viewer modes, and selects a surface', async ({ page }) => {
    // The checked-in acceptance model has more than one million triangles.
    // Keep its allowance explicit and configurable for slower software-WebGL
    // CI runners while retaining the tighter timeout for every other flow.
    test.setTimeout(LARGE_MODEL_READY_TIMEOUT + READY_TIMEOUT)
    await waitForViewer(page)

    await page.getByRole('group', { name: 'Camera mode' }).getByRole('button', { name: '2D plan', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Camera mode' }).getByRole('button', { name: '2D plan', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('group', { name: 'Render mode' }).getByRole('button', { name: 'Wire', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Render mode' }).getByRole('button', { name: 'Wire', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('group', { name: 'Camera mode' }).getByRole('button', { name: '3D', exact: true }).click()
    await page.getByRole('group', { name: 'Render mode' }).getByRole('button', { name: 'Texture', exact: true }).click()

    const compass = page.getByLabel('Compass: north')
    const compassBefore = await compass.getAttribute('style')
    const canvas = page.locator('canvas').first()
    const canvasBox = await canvas.boundingBox()
    if (canvasBox === null) throw new Error('Viewer canvas did not expose a layout box')
    // A left-button drag in Select mode is a genuine OrbitControls gesture.
    // Start over the neutral background away from the viewer's HTML overlays
    // so the model surface picker cannot turn it into a placement selection.
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.15, canvasBox.y + canvasBox.height * 0.25)
    await page.mouse.down()
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.25, canvasBox.y + canvasBox.height * 0.35, { steps: 10 })
    await page.mouse.up()
    await expect.poll(async () => compass.getAttribute('style'), { timeout: ACTION_TIMEOUT }).not.toBe(compassBefore)

    const initialSurface = page.locator('.surface-chip')
    await expect(initialSurface).toBeVisible({ timeout: ACTION_TIMEOUT })
    const initialSurfaceText = await initialSurface.textContent()
    await clickCanvas(page, 0.56, 0.50)
    await expect(page.locator('.surface-chip')).toBeVisible({ timeout: ACTION_TIMEOUT })
    await expect(page.locator('.surface-chip')).not.toHaveText(initialSurfaceText ?? '', { timeout: ACTION_TIMEOUT })

    await page.locator('.topbar [data-testid="load-sample-model"]').click()
    await expect(page.locator('.topbar .brand-context')).toHaveText('Synthetic WebODM house', {
      timeout: LARGE_MODEL_READY_TIMEOUT,
    })
    const sampleViewer = page.getByTestId('pv-viewer')
    const sampleMetadata = sampleViewer.getByTestId('viewer-metadata')
    // Assert the parser-owned numeric contract rather than relying solely on
    // locale-formatted copy. The visible strings remain checked below, while
    // these attributes make a constrained CI failure report the exact model
    // identity/count it reached instead of timing out with ambiguous text.
    await expect(sampleMetadata).toHaveAttribute('data-model-name', 'Synthetic WebODM house', {
      timeout: LARGE_MODEL_READY_TIMEOUT,
    })
    await test.info().attach('sample-metadata.txt', {
      body: await sampleMetadata.evaluate((element) => {
        const attributes = Object.fromEntries(
          Array.from(element.attributes, ({ name, value }) => [name, value]),
        )
        return JSON.stringify({ attributes, text: element.textContent }, null, 2)
      }),
      contentType: 'text/plain',
    })
    await expect(sampleMetadata).toHaveAttribute('data-vertex-count', '545871')
    await expect(sampleMetadata).toHaveAttribute('data-polygon-count', '1086560')
    await expect(sampleViewer.getByText('545,871 vertices', { exact: true })).toBeVisible()
    await expect(sampleViewer.getByText('1,086,560 polygons', { exact: true })).toBeVisible()
    await expect(page.locator('.surface-chip')).toBeVisible({ timeout: LARGE_MODEL_READY_TIMEOUT })
  })

  test('retries an invalid panel placement, commits a valid panel, and drags it without rotating the camera', async ({ page }) => {
    await waitForViewer(page)
    await armPanel(page)
    await chooseInspector(page)

    // The roof edge is intentionally outside the default safe setback. The
    // failed click must leave the cursor draft armed so the user can retry.
    await clickCanvas(page, 0.56, 0.50)
    await expect(status(page)).toHaveText(/Panel layout: 0 panels · 1 dragging/, { timeout: ACTION_TIMEOUT })
    await expect(page.getByRole('button', { name: /^Place/ })).toHaveAttribute('aria-pressed', 'true')

    // The center of the ground plane has enough room for the default module.
    await clickCanvas(page, 0.50, 0.64)
    await waitForPanelCount(page, 1)
    await expect(page.getByRole('button', { name: /^Place/ })).toHaveAttribute('aria-pressed', 'false')

    const camera3d = page.getByRole('group', { name: 'Camera mode' }).getByRole('button', { name: '3D', exact: true })
    await expect(camera3d).toHaveAttribute('aria-pressed', 'true')
    await dragCanvas(page, { xRatio: 0.50, yRatio: 0.64 }, { xRatio: 0.54, yRatio: 0.64 }, 6)
    await waitForPanelCount(page, 1)
    await expect(camera3d).toHaveAttribute('aria-pressed', 'true')
  })

  test('keeps a far-off panel drag alive and commits its center at release', async ({ page }) => {
    await waitForViewer(page)
    await armPanel(page)
    await chooseInspector(page)
    await clickCanvas(page, 0.50, 0.64)
    await waitForPanelCount(page, 1)

    // Release well outside the module's projected bounds.  PanelBatch uses
    // pointer capture so the drag must continue on the canvas after the
    // cursor leaves the original instanced mesh.
    const release = { xRatio: 0.72, yRatio: 0.70 }
    await dragCanvas(page, { xRatio: 0.50, yRatio: 0.64 }, release, 14)
    await waitForPanelCount(page, 1)

    // A click at the release coordinate must now hit the moved panel.  If the
    // drag had stopped at the old center, this lands on the ground surface and
    // clears the selection instead of reporting one selected module.
    await clickCanvas(page, release.xRatio, release.yRatio)
    await expect(status(page)).toHaveText(/Panel layout: 1 panel · 1 selected(?: ·|$)/, { timeout: ACTION_TIMEOUT })
  })

  test('draws a panel array by dragging across the active surface', async ({ page }) => {
    await waitForViewer(page)
    await armPanel(page)
    await chooseInspector(page)

    await dragCanvas(page, { xRatio: 0.45, yRatio: 0.60 }, { xRatio: 0.62, yRatio: 0.62 }, 10)
    await expect(status(page)).toHaveText(/Panel layout: [1-9]\d* panels?/, { timeout: ACTION_TIMEOUT })
    await expect(page.getByRole('button', { name: /^Place/ })).toHaveAttribute('aria-pressed', 'false')
  })

  test('draws an obstacle, previews auto-fill around it, and edits panel-group settings', async ({ page }) => {
    await waitForViewer(page)
    await chooseInspector(page)
    await expect(page.getByRole('button', { name: 'Auto-fill surface', exact: true })).toBeVisible({ timeout: ACTION_TIMEOUT })

    const obstacleTool = page.getByRole('button', { name: /^Obstacle/ })
    await expect(obstacleTool).toBeEnabled({ timeout: ACTION_TIMEOUT })
    await obstacleTool.click()
    await dragCanvas(page, { xRatio: 0.48, yRatio: 0.58 }, { xRatio: 0.53, yRatio: 0.62 }, 6)
    await expect(page.getByRole('heading', { name: 'Surface obstacles', exact: true })).toBeVisible({ timeout: ACTION_TIMEOUT })
    await expect(page.getByRole('button', { name: /Remove obstacle/ })).toBeVisible({ timeout: ACTION_TIMEOUT })

    const obstacleX = page.getByLabel('Obstacle 1 X position')
    const obstacleY = page.getByLabel('Obstacle 1 Y position')
    const obstacleWidth = page.getByLabel('Obstacle 1 width')
    const originalX = Number(await obstacleX.inputValue())
    const originalY = Number(await obstacleY.inputValue())
    const originalWidth = Number(await obstacleWidth.inputValue())

    // Dragging from the obstacle's screen-space centre edits the existing
    // obstacle instead of drawing another one. The change is a single
    // chronological history entry alongside numeric inspector edits.
    await dragCanvas(page, { xRatio: 0.505, yRatio: 0.60 }, { xRatio: 0.55, yRatio: 0.63 }, 8)
    await expect.poll(async () => Number(await obstacleX.inputValue()), { timeout: ACTION_TIMEOUT }).not.toBe(originalX)
    const movedX = Number(await obstacleX.inputValue())
    const movedY = Number(await obstacleY.inputValue())

    const editedWidth = originalWidth + 0.5
    await obstacleWidth.fill(editedWidth.toFixed(2))
    await obstacleWidth.blur()
    await expect(obstacleWidth).toHaveValue(editedWidth.toFixed(2))

    const undoButton = page.getByRole('button', { name: 'Undo last action', exact: true })
    const redoButton = page.getByRole('button', { name: 'Redo last action', exact: true })
    await undoButton.click()
    await expect.poll(async () => Number(await obstacleWidth.inputValue()), { timeout: ACTION_TIMEOUT }).toBe(originalWidth)
    await undoButton.click()
    await expect.poll(async () => Number(await obstacleX.inputValue()), { timeout: ACTION_TIMEOUT }).toBe(originalX)
    await expect.poll(async () => Number(await obstacleY.inputValue()), { timeout: ACTION_TIMEOUT }).toBe(originalY)
    await redoButton.click()
    await expect.poll(async () => Number(await obstacleX.inputValue()), { timeout: ACTION_TIMEOUT }).toBe(movedX)
    await expect.poll(async () => Number(await obstacleY.inputValue()), { timeout: ACTION_TIMEOUT }).toBe(movedY)

    await page.getByLabel('Panel orientation').selectOption('landscape')
    await page.getByLabel('Edge setback in metres').fill('0.35')
    await page.getByLabel('Horizontal module spacing in metres').fill('0.04')
    await page.getByLabel('Vertical module spacing in metres').fill('0.08')
    await page.getByLabel('Panel clearance in metres').fill('0.12')
    await page.getByLabel('Panel tilt in degrees').fill('12')
    await expect(page.getByLabel('Panel orientation')).toHaveValue('landscape')
    await expect(page.getByLabel('Edge setback in metres')).toHaveValue('0.35')

    await page.getByRole('button', { name: 'Auto-fill surface', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Auto-fill preview', exact: true })).toBeVisible({ timeout: ACTION_TIMEOUT })
    await expect(page.getByRole('button', { name: 'Confirm layout', exact: true })).toBeEnabled({ timeout: ACTION_TIMEOUT })
    await page.getByRole('button', { name: 'Confirm layout', exact: true }).click()
    await expect(status(page)).toHaveText(/Panel layout: [1-9]\d* panels?/, { timeout: ACTION_TIMEOUT })
  })

  test('chooses a catalogue model and saves a custom panel', async ({ page }) => {
    await waitForViewer(page)
    await choosePanelTab(page)

    const cards = page.getByRole('list', { name: 'Available panel models' }).getByRole('button')
    await expect.poll(async () => cards.count(), { timeout: ACTION_TIMEOUT }).toBeGreaterThan(1)
    await cards.nth(1).click()
    await expect(cards.nth(1)).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('button', { name: 'Add custom panel', exact: true }).click()
    const form = page.getByTestId('custom-panel-form')
    await expect(form).toBeVisible({ timeout: ACTION_TIMEOUT })
    await form.getByRole('button', { name: 'Save custom panel', exact: true }).click()
    await expect(form.locator('#custom-panel-manufacturer')).toHaveAttribute('aria-invalid', 'true')

    const values: Readonly<Record<string, string>> = {
      manufacturer: 'Acme Solar',
      model: 'AX-450',
      lengthMm: '1722',
      widthMm: '1134',
      thicknessMm: '30',
      weightKg: '20.5',
      wattageW: '450',
      cellCount: '144',
      efficiencyPercent: '22.4',
    }
    for (const [name, value] of Object.entries(values)) await form.locator(`#custom-panel-${name}`).fill(value)
    await form.getByRole('button', { name: 'Save custom panel', exact: true }).click()

    await expect(page.getByTestId('panel-chooser')).toBeVisible({ timeout: ACTION_TIMEOUT })
    const customCard = page.getByRole('list', { name: 'Available panel models' }).getByRole('button', { name: /Acme Solar.*AX-450/ })
    await expect(customCard).toBeVisible({ timeout: ACTION_TIMEOUT })
    await expect(page.getByLabel('Selected panel model')).toHaveValue('acme-solar-ax-450')
  })

  test('deletes a selected panel and restores it with undo', async ({ page }) => {
    await waitForViewer(page)
    await armPanel(page)
    await chooseInspector(page)
    await clickCanvas(page, 0.50, 0.64)
    await waitForPanelCount(page, 1)

    const deleteButton = page.getByRole('button', { name: 'Delete selected panels', exact: true })
    await expect(deleteButton).toBeEnabled({ timeout: ACTION_TIMEOUT })
    await deleteButton.click()
    await expect(status(page)).toHaveText(/Panel layout: 0 panels/, { timeout: ACTION_TIMEOUT })

    const undoButton = page.getByRole('button', { name: 'Undo last action', exact: true })
    await expect(undoButton).toBeEnabled({ timeout: ACTION_TIMEOUT })
    await undoButton.click()
    await waitForPanelCount(page, 1)
  })

  test('selects a panel group with a box and moves the selected group', async ({ page }) => {
    await waitForViewer(page)
    await placePanelPair(page)
    await chooseInspector(page)
    await selectGroundPair(page)

    // Drag from the first module's projected center. PanelBatch should keep
    // the complete selection together while preserving selection state.
    await dragCanvas(page, { xRatio: 0.46, yRatio: 0.68 }, { xRatio: 0.50, yRatio: 0.72 }, 8)
    await expect(status(page)).toHaveText(/Panel layout: 2 panels · 2 selected(?: ·|$)/, { timeout: ACTION_TIMEOUT })
  })

  test('previews and confirms alignment for two selected panels', async ({ page }) => {
    await waitForViewer(page)
    await placePanelPair(page)
    await chooseInspector(page)
    await selectGroundPair(page)

    const alignTool = page.locator('.tool-rail').getByRole('button', { name: 'Align', exact: true })
    await expect(alignTool).toBeEnabled({ timeout: ACTION_TIMEOUT })
    await alignTool.click()
    await expect(page.getByRole('dialog', { name: /Align preview|Confirm alignment/ })).toBeVisible({ timeout: ACTION_TIMEOUT })
    const apply = page.getByRole('button', { name: /Confirm align|Apply alignment/, exact: true })
    await expect(apply).toBeEnabled({ timeout: ACTION_TIMEOUT })
    await apply.click()
    await expect(page.getByRole('dialog', { name: /Align preview|Confirm alignment/ })).toBeHidden({ timeout: ACTION_TIMEOUT })
    await expect(status(page)).toHaveText(/Panel layout: 2 panels · 2 selected(?: ·|$)/, { timeout: ACTION_TIMEOUT })
  })

  test('completes the OpenSolar-style array editing journey without disappearing panels or pointer errors', async ({ page }) => {
    const browserErrors: string[] = []
    page.on('pageerror', (error) => { browserErrors.push(error.message) })
    await waitForViewer(page)
    await expect(page.locator('.surface-chip')).toHaveText(/Ground plane\s*· 520\.0 m²/)

    const arrays = page.locator('.array-list button')
    await armPanel(page)
    await chooseInspector(page)
    await clickCanvas(page, 0.50, 0.64)
    await waitForPanelCount(page, 1)
    await expect(arrays).toHaveCount(1)

    // A compact array on an otherwise empty plane must duplicate, and the
    // selected copy must support the standard Delete key.
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click()
    await waitForPanelCount(page, 2)
    await expect(arrays).toHaveCount(2)
    await page.keyboard.press('Delete')
    await waitForPanelCount(page, 1)
    await expect(arrays).toHaveCount(1)

    await armPanel(page)
    await chooseInspector(page)
    await dragCanvas(page, { xRatio: 0.38, yRatio: 0.56 }, { xRatio: 0.68, yRatio: 0.60 }, 10)
    await waitForPanelCount(page, 57)
    await expect(arrays).toHaveCount(2)
    await expect(arrays.nth(1)).toContainText('56 panels')

    await armPanel(page)
    await chooseInspector(page)
    await clickCanvas(page, 0.45, 0.52)
    await waitForPanelCount(page, 58)
    await expect(arrays).toHaveCount(3)
    await expect.poll(async () => projectMetric(page, 'Project panels')).toBe('58')
    await expect.poll(async () => projectMetric(page, 'Arrays')).toBe('3')
    await expect(arrays.nth(0)).toContainText('1 panels')
    await expect(arrays.nth(1)).toContainText('56 panels')
    await expect(arrays.nth(2)).toContainText('1 panels')

    // Edit the isolated third array so every control can be exercised without
    // altering or colliding with the 56-module reference array.
    await arrays.nth(2).click()
    const model = page.getByLabel('Panel model for selected array')
    const initialModel = await model.inputValue()
    await model.selectOption({ index: 1 })
    await expect(model).not.toHaveValue(initialModel)
    await page.getByLabel('Panel orientation').selectOption('landscape')
    await expect(page.getByLabel('Panel orientation')).toHaveValue('landscape')
    await commitNumberSetting(page, 'Array azimuth in degrees', '12')
    await commitNumberSetting(page, 'Panel tilt in degrees', '8')
    await commitNumberSetting(page, 'Panel clearance in metres', '0.15')

    await page.getByRole('tab', { name: 'Advanced', exact: true }).click()
    await commitNumberSetting(page, 'Horizontal module spacing in metres', '0.04')
    await commitNumberSetting(page, 'Vertical module spacing in metres', '0.08')
    await commitNumberSetting(page, 'Modules per row', '1')
    await commitNumberSetting(page, 'Modules per column', '1')
    await commitNumberSetting(page, 'Horizontal group spacing in metres', '0.20')
    await commitNumberSetting(page, 'Vertical group spacing in metres', '0.25')
    await commitNumberSetting(page, 'Edge setback in metres', '0.30')
    await commitNumberSetting(page, 'Row offset in metres', '0.10')
    await commitNumberSetting(page, 'Obstacle clearance in metres', '0.20')

    await page.getByRole('button', { name: 'Rotate 90°', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Undo last action', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Move array', exact: true }).click()
    await page.keyboard.press('ArrowRight')
    await expect(status(page)).toHaveText(/Panel layout: 58 panels · 1 selected(?: ·|$)/, { timeout: ACTION_TIMEOUT })

    // Context deletion must work on an unobscured visible member of the large
    // array, even while a different array is selected.
    const visibleArrayPanel = await canvasPoint(page, 0.58, 0.62)
    await page.mouse.click(visibleArrayPanel.x, visibleArrayPanel.y, { button: 'right' })
    await expect(page.getByRole('menu', { name: 'Panel actions' })).toBeVisible({ timeout: ACTION_TIMEOUT })
    await page.getByRole('menuitem', { name: 'Delete panel', exact: true }).click()
    await waitForPanelCount(page, 57)
    await expect(arrays).toHaveCount(3)
    await expect(arrays.nth(1)).toContainText('55 panels')

    // Wait through multiple render frames: counts and arrays must remain
    // stable, with no snap-back, disappearance, or raycast exception.
    await page.waitForTimeout(750)
    await expect.poll(async () => projectMetric(page, 'Project panels')).toBe('57')
    await expect.poll(async () => projectMetric(page, 'Arrays')).toBe('3')
    await expect(status(page)).toHaveText(/Panel layout: 57 panels/)
    expect(browserErrors).toEqual([])

    await test.info().attach('opensolar-style-acceptance.png', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    })
  })
})
