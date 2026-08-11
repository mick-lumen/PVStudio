import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { ViewerSurfaceIndex } from './surfaceSelection'
import { runViewerSurfaceAnalysis, selectViewerSurface } from './viewerLifecycle'

function fakeIndex(): ViewerSurfaceIndex {
  return {
    modelId: 'fixture',
    meshes: [],
    groupsFor: () => [],
    surfaceDescriptors: () => [],
    surfaceDescriptorsAsync: () => Promise.resolve([]),
    prepareRaycastGridsAsync: () => Promise.resolve(),
    selectionForIntersection: () => null,
    raycastRawRay: () => null,
  }
}

describe('viewer surface lifecycle', () => {
  it('publishes the model phase before descriptors and only once', async () => {
    const events: string[] = []
    const index = fakeIndex()
    await runViewerSurfaceAnalysis({
      isActive: () => true,
      buildIndex: () => { events.push('index'); return Promise.resolve(index) },
      buildDescriptors: () => { events.push('descriptors'); return Promise.resolve([]) },
      onReady: () => { events.push('surfaces') },
      onProgress: (phase) => { events.push(`progress:${phase}`) },
    })
    expect(events).toEqual(['progress:started', 'index', 'progress:indexed', 'descriptors', 'surfaces', 'progress:complete'])
  })

  it('does not publish stale descriptors after replacement or abort', async () => {
    let active = true
    const onReady = vi.fn()
    let resolveIndex: ((index: ViewerSurfaceIndex) => void) | undefined
    const pending = new Promise<ViewerSurfaceIndex>((resolve) => { resolveIndex = resolve })
    const run = runViewerSurfaceAnalysis({
      isActive: () => active,
      buildIndex: () => pending,
      buildDescriptors: () => Promise.resolve([]),
      onReady,
      onProgress: () => undefined,
    })
    active = false
    resolveIndex?.(fakeIndex())
    await run
    expect(onReady).not.toHaveBeenCalled()
  })

  it('keeps selection unavailable until an index is ready', () => {
    const intersection = { object: new THREE.Object3D(), point: new THREE.Vector3() }
    expect(selectViewerSurface(null, intersection)).toBeNull()
    expect(selectViewerSurface(fakeIndex(), intersection)).toBeNull()
  })
})
