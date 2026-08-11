import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CATALOG_PANEL_DEFINITIONS } from '../integration/appIntegration'
import { boundsOfRegion, createPlacementStore, isValidSurfaceDescriptor } from '../placement'
import { applyViewerModelUpAxis, buildViewerObject, resolveViewerModelUpAxis } from './modelLoader'
import { parseObjDocument } from './objParser'
import { buildViewerSurfaceGroupsAsync, createViewerSurfaceIndexAsync } from './surfaceSelection'

const realSampleDirectory = process.env.PVSTUDIO_REAL_SAMPLE_DIR

function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return object instanceof THREE.Mesh
}

describe.skipIf(realSampleDirectory === undefined)('real WebODM surface preparation profile', () => {
  it('groups every material mesh within a bounded preparation window', async () => {
    if (realSampleDirectory === undefined) throw new Error('PVSTUDIO_REAL_SAMPLE_DIR is required')
    const objName = readdirSync(realSampleDirectory).find((name) => name.toLowerCase().endsWith('.obj'))
    if (objName === undefined) throw new Error(`No OBJ found in ${realSampleDirectory}`)
    const source = readFileSync(join(realSampleDirectory, objName), 'utf8')
    const parseStarted = performance.now()
    const parsed = parseObjDocument(source)
    const object = buildViewerObject(parsed, undefined, objName)
    applyViewerModelUpAxis(object, resolveViewerModelUpAxis('auto', parsed.referencedBounds ?? parsed.bounds))
    const meshes: THREE.Mesh[] = []
    object.traverse((child) => {
      if (isMesh(child)) meshes.push(child)
    })
    process.stdout.write(`\nreal-webodm parse/build ${String(Math.round(performance.now() - parseStarted))}ms meshes=${String(meshes.length)}\n`)

    let faceTotal = 0
    let groupTotal = 0
    const areaThresholds = [0.25, 0.5, 1, 2, 5, 10]
    const areaCounts = new Map(areaThresholds.map((threshold) => [threshold, 0]))
    let largestArea = 0
    for (const [meshIndex, mesh] of meshes.entries()) {
      const faceCount = Math.floor((mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3)
      faceTotal += faceCount
      const started = performance.now()
      const groups = await buildViewerSurfaceGroupsAsync(mesh, undefined, { chunkSize: 8_192 })
      groupTotal += groups.length
      const largest = groups.reduce((maximum, group) => Math.max(maximum, group.faceIndices.length), 0)
      for (const group of groups) {
        largestArea = Math.max(largestArea, group.area)
        for (const threshold of areaThresholds) {
          if (group.area >= threshold) areaCounts.set(threshold, (areaCounts.get(threshold) ?? 0) + 1)
        }
      }
      process.stdout.write(`real-webodm mesh=${String(meshIndex + 1)}/${String(meshes.length)} faces=${String(faceCount)} groups=${String(groups.length)} largest=${String(largest)} elapsed=${String(Math.round(performance.now() - started))}ms\n`)
    }

    process.stdout.write(`real-webodm groups=${String(groupTotal)} largestArea=${largestArea.toFixed(2)} areaCounts=${areaThresholds.map((threshold) => `${String(threshold)}:${String(areaCounts.get(threshold) ?? 0)}`).join(',')}\n`)

    const indexStarted = performance.now()
    const index = await createViewerSurfaceIndexAsync(object, 'real-webodm', undefined, {
      chunkSize: 8_192,
      minimumSurfaceAreaM2: 1,
    })
    const selectableGroups = meshes.reduce((total, mesh) => total + index.groupsFor(mesh).length, 0)
    const descriptors = await index.surfaceDescriptorsAsync({ chunkSize: 8_192 })
    process.stdout.write(`real-webodm selectable=${String(selectableGroups)} descriptors=${String(descriptors.length)} indexElapsed=${String(Math.round(performance.now() - indexStarted))}ms\n`)

    // Re-run the runtime placement boundary guard even though the producer is
    // statically typed. Real photogrammetry data is where malformed polygons
    // previously escaped that producer contract.
    const invalidDescriptors = descriptors.filter((descriptor) => !isValidSurfaceDescriptor(descriptor as unknown))
    process.stdout.write(`real-webodm invalidPlacementDescriptors=${String(invalidDescriptors.length)} ids=${invalidDescriptors.slice(0, 5).map((descriptor) => descriptor.id).join(',')}\n`)

    const store = createPlacementStore({ panels: CATALOG_PANEL_DEFINITIONS })
    expect(store.replaceContext({ panels: CATALOG_PANEL_DEFINITIONS, surfaces: descriptors })).toBe(true)
    const firstSurface = descriptors[0]
    if (firstSurface === undefined) {
      throw new Error('Expected the real WebODM fixture to publish a design surface')
    }
    expect(store.setActiveSurface(firstSurface.id)).toBe(true)
    expect(store.getSnapshot().activeSurfaceId).toBe(firstSurface.id)

    const panel = CATALOG_PANEL_DEFINITIONS[0]
    if (panel === undefined) throw new Error('Expected a catalogue panel for the real WebODM placement probe')
    let viableSurfaceCount = 0
    let firstViableSurfaceId: string | undefined
    const viablePoints = new Map<string, { readonly x: number; readonly y: number }>()
    for (const descriptor of descriptors) {
      const bounds = boundsOfRegion(descriptor.region)
      if (bounds === undefined) continue
      const points = [
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
        ...Array.from({ length: 9 }, (_, row) => Array.from({ length: 9 }, (_, column) => ({
          x: bounds.x + bounds.width * ((column + 1) / 10),
          y: bounds.y + bounds.height * ((row + 1) / 10),
        }))).flat(),
      ]
      expect(store.beginManualPlacement({ panelId: panel.id, surfaceId: descriptor.id })).toBe(true)
      let placed = false
      for (const point of points) {
        if (store.commitManualPlacement(point) !== undefined) {
          viablePoints.set(descriptor.id, point)
          placed = true
          break
        }
      }
      if (placed) {
        viableSurfaceCount += 1
        firstViableSurfaceId ??= descriptor.id
      } else {
        store.cancelManualPlacement()
      }
    }
    const descriptorSummary = (descriptor: (typeof descriptors)[number]) => {
      const bounds = boundsOfRegion(descriptor.region)
      const point = viablePoints.get(descriptor.id)
      const world = point === undefined ? undefined : {
        x: descriptor.frame.origin.x + descriptor.frame.tangentX.x * point.x + descriptor.frame.tangentY.x * point.y,
        y: descriptor.frame.origin.y + descriptor.frame.tangentX.y * point.x + descriptor.frame.tangentY.y * point.y,
        z: descriptor.frame.origin.z + descriptor.frame.tangentX.z * point.x + descriptor.frame.tangentY.z * point.y,
      }
      const pointCount = 'points' in descriptor.region ? descriptor.region.points.length : 4
      return `${descriptor.id} area=${descriptor.area.toFixed(2)} tilt=${descriptor.tiltDeg.toFixed(1)} az=${descriptor.azimuthDeg.toFixed(1)} points=${String(pointCount)} bounds=${bounds === undefined ? 'none' : `${bounds.width.toFixed(2)}x${bounds.height.toFixed(2)}`} local=${point === undefined ? 'none' : `${point.x.toFixed(2)},${point.y.toFixed(2)}`} world=${world === undefined ? 'none' : `${world.x.toFixed(2)},${world.y.toFixed(2)},${world.z.toFixed(2)}`}`
    }
    const topByArea = [...descriptors].sort((left, right) => right.area - left.area).slice(0, 20)
    process.stdout.write(`real-webodm viableDetails\n${descriptors.filter((descriptor) => viablePoints.has(descriptor.id)).map(descriptorSummary).join('\n')}\n`)
    process.stdout.write(`real-webodm largestDetails\n${topByArea.map(descriptorSummary).join('\n')}\n`)
    process.stdout.write(`real-webodm panelViableSurfaces=${String(viableSurfaceCount)} first=${firstViableSurfaceId ?? 'none'}\n`)
    const viableLargeSurfaces = topByArea.filter((descriptor) => descriptor.area >= 200 && viablePoints.has(descriptor.id))

    expect(invalidDescriptors).toHaveLength(0)
    expect(viableSurfaceCount).toBeGreaterThanOrEqual(100)
    expect(viableLargeSurfaces).toHaveLength(8)

    expect(faceTotal).toBe(309_226)
    expect(groupTotal).toBeGreaterThan(0)
    expect(selectableGroups).toBe(857)
    expect(selectableGroups).toBe(areaCounts.get(1))
    expect(descriptors).toHaveLength(selectableGroups)
  }, 600_000)
})
