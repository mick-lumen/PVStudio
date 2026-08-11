import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { isSurfaceSelection } from '../core'
import {
  buildViewerSurfaceGroups,
  createViewerSurfaceIndexAsync,
  createViewerHighlightGeometry,
  createViewerSurfaceIndex,
  estimateViewerSurfaceIndexBytes,
  isSimpleSurfaceBoundary,
  largestSimpleSurfaceBoundary,
  raycastViewerSurface,
  selectionFromViewerIntersection,
  tracePlanarSurfaceBoundaryLoops,
} from './surfaceSelection'
import { applyViewerModelUpAxis } from './modelLoader'
import { toViewerSurfaceModelPoint } from './surfacePointer'

function makePlanarMesh(): THREE.Mesh {
  // Two adjacent triangles followed by two disconnected coplanar triangles.
  const positions = [
    0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1,
    3, 0, 0, 4, 0, 0, 4, 0, 1,
  ]
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6])
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
}

function makeUnindexedPlanarMesh(): THREE.Mesh {
  // Same two connected triangles and one disconnected patch as
  // makePlanarMesh, but with duplicated corner vertices. This exercises the
  // coordinate-based fallback against the indexed source-id fast path.
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 1, 0, 1,
    0, 0, 0, 1, 0, 1, 0, 0, 1,
    3, 0, 0, 4, 0, 0, 4, 0, 1,
  ], 3))
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
}

function makeTupleSeamedPlanarMesh(): THREE.Mesh {
  // Adjacent faces share physical endpoints but use different render vertices,
  // as an OBJ does when UV or normal indices split across the diagonal.
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 1, 1, 0, 0,
    0, 0, 0, 0, 0, 1, 1, 0, 1,
  ], 3))
  geometry.setIndex([0, 1, 2, 3, 4, 5])
  geometry.userData.surfaceVertexIdentity = 'coordinate'
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
}

function makeTranslatedShallowHingeMesh(translationX: number): THREE.Mesh {
  // The faces share an edge and differ by a hundredth of a degree. Their local geometry
  // is identical regardless of translation, so surface grouping must be too.
  const rise = Math.tan(THREE.MathUtils.degToRad(0.01))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    translationX, 0, 0,
    translationX + 1, 0, 0,
    translationX + 1, 0, 1,
    translationX, rise, 1,
  ], 3))
  geometry.setIndex([0, 2, 1, 0, 3, 2])
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
}

function makeConcaveMesh(): THREE.Mesh {
  const positions = [
    0, 0, 0, 2, 0, 0, 2, 0, 1, 1, 0, 1, 1, 0, 2, 0, 0, 2,
  ]
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex([0, 1, 3, 1, 2, 3, 0, 3, 5, 3, 4, 5])
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
}

function makeIndexedGridMesh(
  widthCells: number,
  depthCells: number,
  cellSize = 1,
  winding: 'up' | 'down' = 'up',
): THREE.Mesh {
  const verticesAcross = widthCells + 1
  const vertexCount = verticesAcross * (depthCells + 1)
  const positions = new Float32Array(vertexCount * 3)
  for (let z = 0; z <= depthCells; z += 1) {
    for (let x = 0; x <= widthCells; x += 1) {
      const vertex = z * verticesAcross + x
      const offset = vertex * 3
      positions[offset] = x * cellSize
      positions[offset + 1] = 0
      positions[offset + 2] = z * cellSize
    }
  }
  const indices = new Uint32Array(widthCells * depthCells * 6)
  let cursor = 0
  for (let z = 0; z < depthCells; z += 1) {
    for (let x = 0; x < widthCells; x += 1) {
      const topLeft = z * verticesAcross + x
      const topRight = topLeft + 1
      const bottomLeft = topLeft + verticesAcross
      const bottomRight = bottomLeft + 1
      // Both triangles share the diagonal exactly; reverse their order to
      // exercise the descriptor's exterior-normal canonicalisation.
      if (winding === 'up') {
        indices[cursor] = topLeft
        indices[cursor + 1] = bottomRight
        indices[cursor + 2] = topRight
        indices[cursor + 3] = topLeft
        indices[cursor + 4] = bottomLeft
        indices[cursor + 5] = bottomRight
      } else {
        indices[cursor] = topLeft
        indices[cursor + 1] = topRight
        indices[cursor + 2] = bottomRight
        indices[cursor + 3] = topLeft
        indices[cursor + 4] = bottomRight
        indices[cursor + 5] = bottomLeft
      }
      cursor += 6
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
}

function polygonArea(points: readonly { readonly x: number; readonly y: number }[]): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (current !== undefined && next !== undefined) sum += current.x * next.y - next.x * current.y
  }
  return Math.abs(sum) / 2
}

describe('viewer surface indexing', () => {
  it('indexes Z-up WebODM roof geometry in the same canonical frame that is rendered', async () => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      4, 0, 0,
      4, 3, 0,
      0, 3, 0,
    ], 3))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    const root = new THREE.Group()
    root.add(mesh)

    try {
      applyViewerModelUpAxis(root, 'z')
      const index = await createViewerSurfaceIndexAsync(root, 'z-up-roof', undefined, {
        chunkSize: 1,
        minimumSurfaceAreaM2: 1,
      })
      const descriptors = await index.surfaceDescriptorsAsync({ chunkSize: 1 })
      const descriptor = descriptors[0]

      expect(root.rotation.x).toBeCloseTo(0)
      expect(mesh.rotation.x).toBeCloseTo(-Math.PI / 2)
      expect(descriptor).toBeDefined()
      expect(descriptor?.area).toBeCloseTo(12)
      expect(descriptor?.tiltDeg).toBeCloseTo(0)
      expect(descriptor?.frame.normal.y).toBeCloseTo(1)
      if (descriptor !== undefined && 'points' in descriptor.region) {
        expect(polygonArea(descriptor.region.points)).toBeCloseTo(12)
      }

      const hit = index.raycastRawRay(new THREE.Ray(
        new THREE.Vector3(2, 5, -1.5),
        new THREE.Vector3(0, -1, 0),
      ))
      expect(hit).not.toBeNull()
      const selection = hit === null ? null : index.selectionForIntersection({
        object: hit.mesh,
        faceIndex: hit.faceIndex,
        point: hit.point,
      })
      expect(selection?.selection.surface.id).toBe(descriptor?.id)
      expect(selection?.selection.worldPoint.y).toBeCloseTo(0)
    } finally {
      geometry.dispose()
      material.dispose()
    }
  })

  it('rejects self-intersecting photogrammetry boundaries and selects the largest simple loop', () => {
    const bowTie = [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 2, y: 0 },
    ]
    const small = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]
    const large = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 2 },
      { x: 0, y: 2 },
    ]

    expect(isSimpleSurfaceBoundary(bowTie)).toBe(false)
    expect(isSimpleSurfaceBoundary(large)).toBe(true)
    expect(largestSimpleSurfaceBoundary([bowTie, small, large])).toEqual(large)
    expect(largestSimpleSurfaceBoundary([bowTie])).toBeUndefined()
  })

  it('recovers the largest truthful loop at a branching photogrammetry boundary vertex', () => {
    const vertices = new Map([
      [0, { x: 0, y: 0 }],
      [1, { x: 2, y: 0 }],
      [2, { x: 2, y: 2 }],
      [3, { x: 0, y: 2 }],
      [4, { x: -3, y: 0 }],
      [5, { x: -3, y: -3 }],
      [6, { x: 0, y: -3 }],
    ])
    const adjacency = new Map<number, Set<number>>()
    const addEdge = (first: number, second: number): void => {
      const firstNeighbours = adjacency.get(first) ?? new Set<number>()
      const secondNeighbours = adjacency.get(second) ?? new Set<number>()
      firstNeighbours.add(second)
      secondNeighbours.add(first)
      adjacency.set(first, firstNeighbours)
      adjacency.set(second, secondNeighbours)
    }
    for (const [first, second] of [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [0, 4], [4, 5], [5, 6], [6, 0],
    ] as const) addEdge(first, second)

    const loops = tracePlanarSurfaceBoundaryLoops(adjacency, vertices)
    const simpleAreas = loops.filter(isSimpleSurfaceBoundary).map(polygonArea).sort((first, second) => first - second)

    expect(simpleAreas).toEqual([4, 9])
    expect(largestSimpleSurfaceBoundary(loops)).toSatisfy((loop: readonly { x: number; y: number }[]) => polygonArea(loop) === 9)
  })

  it('groups connected coplanar triangles but keeps disconnected patches separate', () => {
    const mesh = makePlanarMesh()
    const groups = buildViewerSurfaceGroups(mesh)

    expect(groups).toHaveLength(2)
    expect(groups[0]?.faceIndices).toEqual([0, 1])
    expect(groups[1]?.faceIndices).toEqual([2])
    expect(groups[0]?.area).toBeCloseTo(1)
    expect(groups[1]?.area).toBeCloseTo(0.5)
  })

  it('keeps microscopic photogrammetry fragments out of the interactive design index', async () => {
    const mesh = makePlanarMesh()
    try {
      const index = await createViewerSurfaceIndexAsync(mesh, 'design-sized-surfaces', undefined, {
        chunkSize: 1,
        minimumSurfaceAreaM2: 0.75,
      })

      expect(index.groupsFor(mesh).map((group) => group.area)).toEqual([1])
      await expect(index.surfaceDescriptorsAsync({ chunkSize: 1 })).resolves.toHaveLength(1)
      expect(index.selectionForIntersection({
        object: mesh,
        faceIndex: 2,
        point: new THREE.Vector3(3.25, 0, 0.25),
      })).toBeNull()
      expect(index.raycastRawRay(new THREE.Ray(
        new THREE.Vector3(3.25, 2, 0.25),
        new THREE.Vector3(0, -1, 0),
      ))).toBeNull()
    } finally {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('publishes a correct index before optional raycast grids finish', async () => {
    const mesh = makeIndexedGridMesh(20, 20)
    try {
      const index = await createViewerSurfaceIndexAsync(mesh, 'deferred-grid', undefined, {
        chunkSize: 64,
        deferRaycastGrids: true,
      })

      await expect(index.surfaceDescriptorsAsync({ chunkSize: 64 })).resolves.toHaveLength(1)
      expect(index.raycastRawRay(new THREE.Ray(
        new THREE.Vector3(1, 2, 1),
        new THREE.Vector3(0, -1, 0),
      ))).not.toBeNull()

      const channelSpy = vi.spyOn(globalThis, 'MessageChannel')
      await index.prepareRaycastGridsAsync({ chunkSize: 64 })
      expect(channelSpy).toHaveBeenCalled()
      channelSpy.mockClear()
      await index.prepareRaycastGridsAsync({ chunkSize: 64 })
      expect(channelSpy).not.toHaveBeenCalled()
      channelSpy.mockRestore()
    } finally {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('rejects an invalid minimum design-surface area', async () => {
    const mesh = makePlanarMesh()
    try {
      await expect(createViewerSurfaceIndexAsync(mesh, 'invalid-area', undefined, {
        minimumSurfaceAreaM2: Number.NaN,
      })).rejects.toThrow('minimumSurfaceAreaM2')
    } finally {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('keeps indexed source vertices equivalent to the unindexed coordinate fallback', async () => {
    const indexed = makePlanarMesh()
    const unindexed = makeUnindexedPlanarMesh()
    try {
      const indexedGroups = buildViewerSurfaceGroups(indexed)
      const unindexedGroups = buildViewerSurfaceGroups(unindexed)
      expect(indexedGroups.map((group) => group.faceIndices.length)).toEqual([2, 1])
      expect(unindexedGroups.map((group) => group.faceIndices.length)).toEqual([2, 1])

      const asyncIndex = await createViewerSurfaceIndexAsync(indexed, 'indexed-fast-path', undefined, { chunkSize: 1 })
      expect(asyncIndex.groupsFor(indexed).map((group) => group.faceIndices.length)).toEqual([2, 1])
    } finally {
      indexed.geometry.dispose()
      unindexed.geometry.dispose()
      ;(indexed.material as THREE.Material).dispose()
      ;(unindexed.material as THREE.Material).dispose()
    }
  })

  it('joins indexed OBJ faces across UV and normal tuple seams', async () => {
    const mesh = makeTupleSeamedPlanarMesh()
    try {
      expect(buildViewerSurfaceGroups(mesh)).toHaveLength(1)
      const index = await createViewerSurfaceIndexAsync(mesh, 'tuple-seam', undefined, { chunkSize: 1 })
      expect(index.groupsFor(mesh)).toHaveLength(1)
      expect(index.groupsFor(mesh)[0]?.faceIndices).toEqual([0, 1])
    } finally {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('groups shallow adjacent faces independently of their world-origin distance', () => {
    const local = makeTranslatedShallowHingeMesh(0)
    const georeferenced = makeTranslatedShallowHingeMesh(100_000)
    try {
      expect(buildViewerSurfaceGroups(local)).toHaveLength(1)
      expect(buildViewerSurfaceGroups(georeferenced)).toHaveLength(1)
      expect(buildViewerSurfaceGroups(georeferenced)[0]?.faceIndices).toEqual([0, 1])
    } finally {
      local.geometry.dispose()
      georeferenced.geometry.dispose()
      ;(local.material as THREE.Material).dispose()
      ;(georeferenced.material as THREE.Material).dispose()
    }
  })

  it('builds one model-scoped index and returns a frozen canonical selection', () => {
    const root = new THREE.Group()
    const mesh = makePlanarMesh()
    root.add(mesh)
    const excluded = makePlanarMesh()
    excluded.userData.selectable = false
    root.add(excluded)

    const index = createViewerSurfaceIndex(root, 'model-1')
    expect(index.modelId).toBe('model-1')
    expect(index.meshes).toHaveLength(1)
    expect(index.groupsFor(mesh)).toHaveLength(2)

    const hit = selectionFromViewerIntersection({
      object: mesh,
      faceIndex: 1,
      point: new THREE.Vector3(0.25, 0, 0.25),
    }, undefined, index)
    expect(hit).not.toBeNull()
    expect(hit && isSurfaceSelection(hit)).toBe(true)
    expect(hit?.surface.faceRefs).toEqual([{ meshId: mesh.uuid, faceIndices: [0, 1] }])
    expect(hit && Object.isFrozen(hit)).toBe(true)
    expect(hit?.worldPoint).toEqual({ x: 0.25, y: 0, z: 0.25 })

    expect(selectionFromViewerIntersection({
      object: mesh,
      faceIndex: null,
      point: new THREE.Vector3(),
    }, undefined, index)).toBeNull()
  })

  it('creates highlight geometry for every face in the selected region', () => {
    const mesh = makePlanarMesh()
    const index = createViewerSurfaceIndex(mesh)
    const hit = index.selectionForIntersection({ object: mesh, faceIndex: 0, point: new THREE.Vector3() })
    expect(hit).not.toBeNull()
    if (hit === null) return

    const highlight = createViewerHighlightGeometry(mesh, hit.selection)
    expect(highlight.getAttribute('position').count).toBe(6)
    expect(highlight.index?.count).toBe(6)
    highlight.dispose()
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  })

  it('keeps a 500k-face highlight bounded by using the cached surface region', () => {
    const mesh = makePlanarMesh()
    const index = createViewerSurfaceIndex(mesh, 'large-highlight')
    const hit = index.selectionForIntersection({ object: mesh, faceIndex: 0, point: new THREE.Vector3() })
    expect(hit).not.toBeNull()
    if (hit === null) return

    // The DTO deliberately retains plain face ids, but the renderer must not
    // expand every id into three sibling vertices when a large surface is
    // selected. Keep allocation outside the timed section to measure only
    // pointer-to-highlight work.
    const faceIndices = new Array<number>(500_000).fill(0)
    const largeSelection = {
      surface: {
        ...hit.selection.surface,
        region: { x: -0.5, y: -0.5, width: 1, height: 1 },
        faceRefs: [{ meshId: mesh.uuid, faceIndices }],
      },
    }
    const started = performance.now()
    const highlight = createViewerHighlightGeometry(mesh, largeSelection)
    const elapsed = performance.now() - started
    const position = highlight.getAttribute('position')
    expect(elapsed).toBeLessThan(100)
    expect(position.count).toBeLessThanOrEqual(512)
    expect(highlight.index?.count).toBeGreaterThan(0)
    highlight.dispose()
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  })

  it('keeps analysis in model-root coordinates when an external normalisation parent is attached', async () => {
    const root = new THREE.Group()
    const mesh = makeIndexedGridMesh(8, 4)
    mesh.position.set(3, 1, -5)
    root.add(mesh)
    root.updateMatrixWorld(true)

    const detached = await createViewerSurfaceIndexAsync(root, 'raw-detached', undefined, { chunkSize: 32 })
    const detachedDescriptor = (await detached.surfaceDescriptorsAsync({ chunkSize: 32 }))[0]
    expect(detachedDescriptor).toBeDefined()
    if (detachedDescriptor === undefined) return

    const external = new THREE.Group()
    external.position.set(40, -12, 8)
    external.scale.set(3, 0.5, 2)
    external.add(root)
    external.updateMatrixWorld(true)
    const attached = await createViewerSurfaceIndexAsync(root, 'raw-attached', undefined, { chunkSize: 32 })
    const attachedDescriptor = (await attached.surfaceDescriptorsAsync({ chunkSize: 32 }))[0]
    expect(attachedDescriptor).toBeDefined()
    if (attachedDescriptor === undefined) return

    expect(attachedDescriptor.area).toBeCloseTo(detachedDescriptor.area, 6)
    expect(attachedDescriptor.usableArea).toBeCloseTo(detachedDescriptor.usableArea, 6)
    expect(attachedDescriptor.frame).toEqual(detachedDescriptor.frame)
    expect(attachedDescriptor.region).toEqual(detachedDescriptor.region)
    expect(attachedDescriptor.faceRefs).toEqual(detachedDescriptor.faceRefs)

    const faceIndex = 8 * 2 + 0
    const rawPoint = new THREE.Vector3(3 + 2.25, 1, -5 + 1.25)
    const detachedHit = detached.selectionForIntersection({ object: mesh, faceIndex, point: rawPoint })
    const attachedHit = attached.selectionForIntersection({ object: mesh, faceIndex, point: rawPoint })
    expect(detachedHit?.selection.worldPoint).toEqual(attachedHit?.selection.worldPoint)
    expect(detachedHit?.selection.hitLocal).toEqual(attachedHit?.selection.hitLocal)
    expect(attachedHit?.selection.surface.area).toBeCloseTo(32, 6)

    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  })

  it('uses a downhill tangent on sloped surfaces and preserves a right-handed frame', () => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      2, 0, 0,
      2, 1, 1,
      0, 1, 1,
    ], 3))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    try {
      const descriptor = createViewerSurfaceIndex(mesh).surfaceDescriptors()[0]
      expect(descriptor).toBeDefined()
      if (descriptor === undefined) return
      const { frame } = descriptor
      const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z)
      const tangentX = new THREE.Vector3(frame.tangentX.x, frame.tangentX.y, frame.tangentX.z)
      const tangentY = new THREE.Vector3(frame.tangentY.x, frame.tangentY.y, frame.tangentY.z)
      const gravityProjection = new THREE.Vector3(0, -1, 0).addScaledVector(normal, -new THREE.Vector3(0, -1, 0).dot(normal)).normalize()
      expect(tangentY.dot(gravityProjection)).toBeGreaterThan(1 - 1e-5)
      expect(new THREE.Vector3().crossVectors(tangentX, tangentY).distanceTo(normal)).toBeLessThan(1e-5)
      const downhill = tangentY.dot(new THREE.Vector3(0, -1, 0))
      expect(downhill).toBeGreaterThan(0)
    } finally {
      geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('aligns highlight vertices with translated and rotated source meshes', () => {
    const root = new THREE.Group()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      0, 0, 1,
    ], 3))
    geometry.setIndex([0, 1, 2])
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    mesh.position.set(4, 2, -3)
    mesh.rotation.set(0.25, -0.4, 0.15)
    root.add(mesh)
    root.updateMatrixWorld(true)
    try {
      const index = createViewerSurfaceIndex(root)
      const hit = index.selectionForIntersection({ object: mesh, faceIndex: 0, point: new THREE.Vector3(4, 2, -3) })
      expect(hit).not.toBeNull()
      if (hit === null) return
      const highlight = createViewerHighlightGeometry(mesh, hit.selection, root)
      const highlightPosition = highlight.getAttribute('position')
      const expected = new THREE.Vector3(0, 0, 0).applyMatrix4(mesh.matrixWorld)
      expect(highlightPosition.getX(0)).toBeCloseTo(expected.x, 5)
      expect(highlightPosition.getY(0)).toBeCloseTo(expected.y, 5)
      expect(highlightPosition.getZ(0)).toBeCloseTo(expected.z, 5)
      highlight.dispose()
    } finally {
      geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('joins adjacent triangles with opposite winding and retains a polygon footprint', () => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1,
    ], 3))
    geometry.setIndex([0, 1, 2, 0, 3, 2])
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    const groups = buildViewerSurfaceGroups(mesh)
    expect(groups).toHaveLength(1)
    const index = createViewerSurfaceIndex(mesh)
    const hit = index.selectionForIntersection({ object: mesh, faceIndex: 0, point: new THREE.Vector3(0.2, 0, 0.2) })
    expect(hit).not.toBeNull()
    if (hit === null || !('points' in hit.selection.surface.region)) return
    expect(hit.selection.surface.region.points).toHaveLength(4)
  })

  it('reconstructs a roof boundary where a perimeter edge is shared with a wall', async () => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 2, 0,
      4, 2, 0,
      4, 2, 3,
      0, 2, 3,
      4, 0, 0,
      0, 0, 0,
    ], 3))
    // The roof's 0-1 edge is also part of the wall. It is not an exterior
    // mesh edge, but it is an exterior edge of the roof placement surface.
    geometry.setIndex([
      0, 2, 1,
      0, 3, 2,
      0, 1, 4,
      0, 4, 5,
    ])
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(geometry, material)

    try {
      const index = createViewerSurfaceIndex(mesh)
      const descriptors = await index.surfaceDescriptorsAsync({ chunkSize: 1 })
      const roof = descriptors.find((descriptor) => Math.abs(descriptor.area - 12) < 1e-6)

      expect(roof).toBeDefined()
      expect(roof?.frame.normal.y).toBeCloseTo(1)
      expect(roof !== undefined && 'points' in roof.region).toBe(true)
      if (roof !== undefined && 'points' in roof.region) {
        expect(roof.region.points).toHaveLength(4)
        expect(polygonArea(roof.region.points)).toBeCloseTo(12)
      }
    } finally {
      geometry.dispose()
      material.dispose()
    }
  })

  it('returns a concave polygon rather than an enclosing AABB', () => {
    const mesh = makeConcaveMesh()
    const index = createViewerSurfaceIndex(mesh)
    const hit = index.selectionForIntersection({ object: mesh, faceIndex: 0, point: new THREE.Vector3(0.5, 0, 0.25) })
    expect(hit).not.toBeNull()
    if (hit === null || !('points' in hit.selection.surface.region)) return
    expect(hit.selection.surface.region.points).toHaveLength(6)
  })

  it('keeps indexed-grid area, boundary projection, and center-face selection exact', async () => {
    // This is deliberately smaller than the 500k-face browser fixture but
    // follows the same indexed topology and scales linearly by cell count.
    const widthCells = 128
    const depthCells = 64
    const expectedFaceCount = widthCells * depthCells * 2
    const expectedArea = widthCells * depthCells
    const mesh = makeIndexedGridMesh(widthCells, depthCells)
    try {
      const index = await createViewerSurfaceIndexAsync(mesh, 'indexed-grid', undefined, { chunkSize: 1_024 })
      const groups = index.groupsFor(mesh)
      expect(groups).toHaveLength(1)
      const group = groups[0]
      expect(group).toBeDefined()
      expect(group?.faceIndices).toHaveLength(expectedFaceCount)
      expect(group?.area).toBeCloseTo(expectedArea, 5)

      const surfaces = await index.surfaceDescriptorsAsync({ chunkSize: 1_024 })
      expect(surfaces).toHaveLength(1)
      const descriptor = surfaces[0]
      expect(descriptor).toBeDefined()
      if (descriptor === undefined) return
      expect(descriptor.area).toBeCloseTo(expectedArea, 5)
      expect(descriptor.usableArea).toBeCloseTo(expectedArea, 5)
      expect(descriptor.faceRefs).toHaveLength(1)
      expect(descriptor.faceRefs[0]?.faceIndices).toHaveLength(expectedFaceCount)

      expect('points' in descriptor.region).toBe(true)
      if (!('points' in descriptor.region)) return
      // The boundary retains each unit grid edge, so its exact vertex count
      // is the perimeter (rather than an enclosing four-corner rectangle).
      expect(descriptor.region.points).toHaveLength(2 * (widthCells + depthCells))
      expect(polygonArea(descriptor.region.points)).toBeCloseTo(expectedArea, 5)
      const projectedX = descriptor.region.points.map((point) => point.x)
      const projectedY = descriptor.region.points.map((point) => point.y)
      const extentX = Math.max(...projectedX) - Math.min(...projectedX)
      const extentY = Math.max(...projectedY) - Math.min(...projectedY)
      expect([extentX, extentY].sort((first, second) => first - second)).toEqual([
        Math.min(widthCells, depthCells),
        Math.max(widthCells, depthCells),
      ])

      const { frame } = descriptor
      expect(frame.normal.y).toBeCloseTo(1, 5)
      expect(frame.normal.x).toBeCloseTo(0, 5)
      expect(frame.normal.z).toBeCloseTo(0, 5)
      const dot = (first: typeof frame.normal, second: typeof frame.normal): number =>
        first.x * second.x + first.y * second.y + first.z * second.z
      expect(dot(frame.normal, frame.tangentX)).toBeCloseTo(0, 5)
      expect(dot(frame.normal, frame.tangentY)).toBeCloseTo(0, 5)
      expect(dot(frame.tangentX, frame.tangentY)).toBeCloseTo(0, 5)

      const centerCellX = Math.floor(widthCells / 2)
      const centerCellZ = Math.floor(depthCells / 2)
      const centerFace = (centerCellZ * widthCells + centerCellX) * 2
      const centerPoint = new THREE.Vector3(centerCellX + 2 / 3, 0, centerCellZ + 1 / 3)
      const hit = index.selectionForIntersection({ object: mesh, faceIndex: centerFace, point: centerPoint })
      expect(hit).not.toBeNull()
      expect(hit?.selection.surface.area).toBeCloseTo(expectedArea, 5)
      expect(hit?.selection.surface.faceRefs[0]?.faceIndices).toHaveLength(expectedFaceCount)
      expect(hit?.selection.worldPoint).toEqual({ x: centerPoint.x, y: centerPoint.y, z: centerPoint.z })
      expect(hit?.selection.hitLocal.x).toBeCloseTo(centerPoint.z - depthCells / 2, 5)
      expect(hit?.selection.hitLocal.y).toBeCloseTo(centerPoint.x - widthCells / 2, 5)
    } finally {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('canonicalises a downward indexed roof to +Y and keeps placement coordinates right-handed', async () => {
    // Keep the face count CI-friendly while retaining the production fixture's
    // exact 250,000 m² footprint (100 × 50 cells at √50 m per cell).
    const widthCells = 100
    const depthCells = 50
    const cellSize = Math.sqrt(50)
    const expectedArea = widthCells * depthCells * cellSize * cellSize
    const mesh = makeIndexedGridMesh(widthCells, depthCells, cellSize, 'down')
    try {
      const index = await createViewerSurfaceIndexAsync(mesh, 'downward-grid', undefined, { chunkSize: 512 })
      const descriptor = (await index.surfaceDescriptorsAsync({ chunkSize: 512 }))[0]
      expect(descriptor).toBeDefined()
      if (descriptor === undefined) return
      expect(descriptor.area).toBeCloseTo(250_000, 1)
      expect(descriptor.usableArea).toBeCloseTo(expectedArea, 1)
      expect(descriptor.frame.normal).toEqual({ x: 0, y: 1, z: 0 })
      expect('points' in descriptor.region).toBe(true)
      if ('points' in descriptor.region) {
        const projectedX = descriptor.region.points.map((point) => point.x)
        const projectedY = descriptor.region.points.map((point) => point.y)
        // The frame convention maps +Z onto tangentX and +X onto tangentY
        // for a +Y roof, so the projected extents are depth then width.
        expect(Math.max(...projectedX) - Math.min(...projectedX)).toBeCloseTo(depthCells * cellSize, 4)
        expect(Math.max(...projectedY) - Math.min(...projectedY)).toBeCloseTo(widthCells * cellSize, 4)
        expect(polygonArea(descriptor.region.points)).toBeCloseTo(expectedArea, 1)
      }
      const centerCellX = Math.floor(widthCells / 2)
      const centerCellZ = Math.floor(depthCells / 2)
      const centerFace = (centerCellZ * widthCells + centerCellX) * 2
      const centerPoint = new THREE.Vector3(
        (centerCellX + 2 / 3) * cellSize,
        0,
        (centerCellZ + 1 / 3) * cellSize,
      )
      const hit = index.selectionForIntersection({ object: mesh, faceIndex: centerFace, point: centerPoint })
      expect(hit).not.toBeNull()
      expect(hit?.selection.hitLocal.x).toBeCloseTo(centerPoint.z - (depthCells * cellSize) / 2, 4)
      expect(hit?.selection.hitLocal.y).toBeCloseTo(centerPoint.x - (widthCells * cellSize) / 2, 4)
      const crossX = descriptor.frame.tangentX.y * descriptor.frame.tangentY.z - descriptor.frame.tangentX.z * descriptor.frame.tangentY.y
      const crossY = descriptor.frame.tangentX.z * descriptor.frame.tangentY.x - descriptor.frame.tangentX.x * descriptor.frame.tangentY.z
      const crossZ = descriptor.frame.tangentX.x * descriptor.frame.tangentY.y - descriptor.frame.tangentX.y * descriptor.frame.tangentY.x
      expect(crossX).toBeCloseTo(descriptor.frame.normal.x, 5)
      expect(crossY).toBeCloseTo(descriptor.frame.normal.y, 5)
      expect(crossZ).toBeCloseTo(descriptor.frame.normal.z, 5)
      // A panel anchor with positive frame clearance must be above the raw
      // downward-wound plane, even though the source winding points below.
      const clearance = 0.25
      const anchorY = descriptor.frame.origin.y + descriptor.frame.normal.y * clearance
      expect(anchorY).toBeGreaterThan(0)
    } finally {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('orients vertical surfaces away from the model centroid with a stable tie-break', () => {
    const makeVertical = (x: number, positiveWinding: boolean): THREE.Mesh => {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        x, 0, 0,
        x, 0, 2,
        x, 2, 0,
      ], 3))
      geometry.setIndex(positiveWinding ? [0, 2, 1] : [0, 1, 2])
      return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    }
    const root = new THREE.Group()
    const outwardWall = makeVertical(10, false) // raw normal -X, outside is +X
    const modelMarker = makeVertical(0, true)
    root.add(outwardWall, modelMarker)
    const index = createViewerSurfaceIndex(root, 'vertical-outward')
    const wallDescriptor = index.surfaceDescriptors().find((descriptor) => descriptor.faceRefs[0]?.meshId === outwardWall.uuid)
    expect(wallDescriptor?.frame.normal.x).toBeCloseTo(1, 5)
    expect(wallDescriptor?.frame.normal.y).toBeCloseTo(0, 5)

    const tieWall = makeVertical(0, false)
    const tieIndex = createViewerSurfaceIndex(tieWall, 'vertical-tie')
    const tieDescriptor = tieIndex.surfaceDescriptors()[0]
    expect(tieDescriptor?.frame.normal).toEqual({ x: 1, y: 0, z: 0 })

    outwardWall.geometry.dispose(); (outwardWall.material as THREE.Material).dispose()
    modelMarker.geometry.dispose(); (modelMarker.material as THREE.Material).dispose()
    tieWall.geometry.dispose(); (tieWall.material as THREE.Material).dispose()
  })

  it('maps a normalised display hit back to raw surface coordinates for placement', () => {
    const geometry = new THREE.BufferGeometry()
    // Upward-wound triangle in a deliberately translated raw model frame.
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      10, 0, 20,
      10, 0, 24,
      14, 0, 20,
    ], 3))
    geometry.setIndex([0, 1, 2])
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    const index = createViewerSurfaceIndex(mesh, 'normalised-hit')
    const center = new THREE.Vector3(5, 0, 10)
    const scale = 0.5
    const normalisedPosition = center.clone().multiplyScalar(-scale)
    const rawCenter = new THREE.Vector3(34 / 3, 0, 64 / 3)
    const displayPoint = rawCenter.clone().multiplyScalar(scale).add(normalisedPosition)
    const rawPoint = toViewerSurfaceModelPoint(displayPoint, normalisedPosition, scale)
    try {
      const hit = index.selectionForIntersection({ object: mesh, faceIndex: 0, point: rawPoint })
      expect(hit).not.toBeNull()
      expect(hit?.selection.worldPoint).toEqual({ x: rawCenter.x, y: rawCenter.y, z: rawCenter.z })
      // hitLocal is the placement coordinate in the selected roof frame; the
      // triangle centroid is the frame origin, so both coordinates are exact.
      expect(hit?.selection.hitLocal.x).toBeCloseTo(0, 5)
      expect(hit?.selection.hitLocal.y).toBeCloseTo(0, 5)
    } finally {
      geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('materialises boundary descriptors cooperatively and caches the result', async () => {
    const mesh = makeConcaveMesh()
    const index = createViewerSurfaceIndex(mesh)
    const channelSpy = vi.spyOn(globalThis, 'MessageChannel')
    try {
      const first = await index.surfaceDescriptorsAsync({ chunkSize: 1 })
      const second = await index.surfaceDescriptorsAsync({ chunkSize: 1 })
      expect(first).toBe(second)
      expect(first).toHaveLength(1)
      const region = first[0]?.region
      expect(region && 'points' in region ? region.points : []).toHaveLength(6)
      expect(channelSpy).toHaveBeenCalled()
    } finally {
      channelSpy.mockRestore()
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('skips nearest non-selectable raycast hits', () => {
    const root = new THREE.Group()
    const excluded = makePlanarMesh()
    excluded.userData.selectable = false
    const selectable = makePlanarMesh()
    root.add(excluded, selectable)
    const raycaster = new THREE.Raycaster()
    const firstPoint = new THREE.Vector3(0.2, 0, 0.2)
    vi.spyOn(raycaster, 'intersectObject').mockReturnValue([
      { distance: 1, point: firstPoint, object: excluded, faceIndex: 0 },
      { distance: 2, point: firstPoint, object: selectable, faceIndex: 0 },
    ])
    // This fixture intentionally stubs Three's intersection list to verify
    // nearest-hit filtering; the accelerated indexed path is covered below
    // with a real camera ray and should not consult this stub.
    const hit = raycastViewerSurface(root, raycaster, new THREE.Vector2(), new THREE.PerspectiveCamera())
    expect(hit?.surface.faceRefs[0]?.meshId).toBe(selectable.uuid)
    const fallbackHit = raycastViewerSurface(root, raycaster, new THREE.Vector2(), new THREE.PerspectiveCamera())
    expect(fallbackHit?.surface.faceRefs[0]?.meshId).toBe(selectable.uuid)
  })

  it('uses the packed raw-ray picker in model coordinates without a Three face scan', () => {
    const root = new THREE.Group()
    const mesh = makeIndexedGridMesh(32, 32)
    root.position.set(14, 2, -9)
    root.scale.setScalar(2)
    root.add(mesh)
    const index = createViewerSurfaceIndex(root, 'packed-ray')
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(46, 18, 23)
    camera.lookAt(new THREE.Vector3(46, 2, 23))
    camera.updateMatrixWorld(true)
    root.updateMatrixWorld(true)
    const raycaster = new THREE.Raycaster()
    const threeFaceScan = vi.spyOn(raycaster, 'intersectObject')
    const selection = raycastViewerSurface(root, raycaster, new THREE.Vector2(0, 0), camera, index)
    expect(selection).not.toBeNull()
    expect(threeFaceScan).not.toHaveBeenCalled()
    expect(selection?.surface.area).toBeCloseTo(32 * 32, 4)
    // The public DTO remains in raw model space even though the camera and
    // root are translated/scaled display coordinates.
    expect(selection?.worldPoint.x).toBeCloseTo(16, 1)
    expect(selection?.worldPoint.y).toBeCloseTo(0, 1)
    expect(selection?.worldPoint.z).toBeCloseTo(16, 1)
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  })

  it('keeps raw picks lightweight and reuses the immutable descriptor for repeated hits', () => {
    const mesh = makeIndexedGridMesh(32, 32)
    try {
      const index = createViewerSurfaceIndex(mesh, 'cached-selection')
      const raw = index.raycastRawRay(new THREE.Ray(
        new THREE.Vector3(16, 100, 16),
        new THREE.Vector3(0, -1, 0),
      ))
      expect(raw).not.toBeNull()
      if (raw === null) return

      // The R3F-facing path must not materialise a public DTO (and therefore
      // must not copy the group's faceRefs) merely to decide which triangle
      // was under the pointer.
      expect('selection' in raw).toBe(false)

      const first = index.selectionForIntersection({
        object: raw.mesh,
        faceIndex: raw.faceIndex,
        point: raw.point,
      })
      const second = index.selectionForIntersection({
        object: raw.mesh,
        faceIndex: raw.faceIndex,
        point: raw.point,
      })
      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(second?.selection.surface).toBe(first?.selection.surface)
      expect(second?.selection.surface.faceRefs[0]?.faceIndices).toBe(first?.selection.surface.faceRefs[0]?.faceIndices)
    } finally {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('does not clone a 500k-face descriptor for each physical pick', { timeout: 20_000 }, () => {
    const mesh = makeIndexedGridMesh(500, 500)
    try {
      const index = createViewerSurfaceIndex(mesh, 'cached-500k-selection')
      const first = index.selectionForIntersection({
        object: mesh,
        faceIndex: 0,
        point: new THREE.Vector3(0.5, 0, 0.5),
      })
      const last = index.selectionForIntersection({
        object: mesh,
        faceIndex: 499_999,
        point: new THREE.Vector3(499.5, 0, 499.5),
      })
      expect(first).not.toBeNull()
      expect(last).not.toBeNull()
      expect(last?.selection.surface).toBe(first?.selection.surface)
      expect(last?.selection.surface.faceRefs[0]?.faceIndices).toBe(first?.selection.surface.faceRefs[0]?.faceIndices)
      expect(first?.selection.surface.faceRefs[0]?.faceIndices).toHaveLength(500_000)
    } finally {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('keeps packed picking bounded for a larger indexed surface', async () => {
    const mesh = makeIndexedGridMesh(128, 64)
    try {
      const index = await createViewerSurfaceIndexAsync(mesh, 'packed-pick-perf', undefined, { chunkSize: 1_024 })
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500)
      camera.position.set(64, 100, 32)
      camera.lookAt(new THREE.Vector3(64, 0, 32))
      camera.updateMatrixWorld(true)
      const raycaster = new THREE.Raycaster()
      const threeFaceScan = vi.spyOn(raycaster, 'intersectObject')
      // Design interaction is enabled only after descriptor publication. Keep
      // one-time boundary/descriptor construction outside the pointer budget,
      // matching the Viewer lifecycle used in production.
      await index.surfaceDescriptorsAsync({ chunkSize: 1_024 })
      const started = performance.now()
      const hit = raycastViewerSurface(mesh, raycaster, new THREE.Vector2(0, 0), camera, index)
      const elapsed = performance.now() - started

      expect(hit).not.toBeNull()
      expect(threeFaceScan).not.toHaveBeenCalled()
      // The grid candidate path should remain interactive even as face count
      // grows; this threshold is intentionally measured around the pick only,
      // excluding one-time index construction.
      expect(elapsed).toBeLessThan(100)
    } finally {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })

  it('time-slices a large synthetic surface index', async () => {
    const triangleCount = 4096
    const positions = new Float32Array(triangleCount * 9)
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const offset = triangle * 9
      const base = triangle * 3
      positions[offset] = base
      positions[offset + 1] = 0
      positions[offset + 2] = 0
      positions[offset + 3] = base + 1
      positions[offset + 4] = 0
      positions[offset + 5] = 0
      positions[offset + 6] = base
      positions[offset + 7] = 0
      positions[offset + 8] = 1
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    const channelSpy = vi.spyOn(globalThis, 'MessageChannel')
    const started = performance.now()
    try {
      const index = await createViewerSurfaceIndexAsync(mesh, 'large-synthetic', undefined, { chunkSize: 256 })
      expect(index.modelId).toBe('large-synthetic')
      expect(index.groupsFor(mesh)).toHaveLength(triangleCount)
      expect(channelSpy).toHaveBeenCalled()
      expect(performance.now() - started).toBeLessThan(5_000)
    } finally {
      channelSpy.mockRestore()
      geometry.dispose()
      material.dispose()
    }
  })

  it('keeps packed retained storage bounded for a 500k-face model', () => {
    const bytes = estimateViewerSurfaceIndexBytes(500_000, 1)
    // 52 bytes per face plus one compact group record/offset table.
    expect(bytes).toBe(26_000_052)
    expect(bytes).toBeLessThan(30 * 1024 * 1024)
  })

  it('keeps hash-collision-prone disjoint edges in separate groups', () => {
    // This stride intentionally exercises the old dual-32-bit edge hash's
    // collision pattern.  Keep the fixture large enough to prove that exact
    // endpoint verification does not silently merge a handful of distant
    // triangles while remaining CI-manageable.
    const triangleCount = 100_000
    const positions = new Float32Array(triangleCount * 9)
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const offset = triangle * 9
      const base = triangle * 4
      positions[offset] = base
      positions[offset + 3] = base + 1
      positions[offset + 6] = base
      positions[offset + 8] = 1
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    try {
      expect(buildViewerSurfaceGroups(mesh)).toHaveLength(triangleCount)
    } finally {
      geometry.dispose()
      material.dispose()
    }
  })
})
