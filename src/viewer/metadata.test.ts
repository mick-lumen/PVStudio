import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { computeViewerMetadata, computeViewerMetadataAsync, formatViewerCount, formatViewerDimension } from './metadata'

describe('viewer metadata', () => {
  it('counts indexed triangles, meshes, materials and textures in world bounds', () => {
    const texture = new THREE.Texture()
    const material = new THREE.MeshBasicMaterial({ map: texture })
    const root = new THREE.Group()
    const first = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 3), material)
    const second = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
    second.position.x = 4
    root.add(first, second)

    const metadata = computeViewerMetadata(root, 'Survey', false)
    expect(metadata.name).toBe('Survey')
    expect(metadata.vertexCount).toBe(24 + 4)
    expect(metadata.polygonCount).toBe(12 + 2)
    expect(metadata.meshCount).toBe(2)
    expect(metadata.materialCount).toBe(1)
    expect(metadata.textureCount).toBe(1)
    expect(metadata.boundingBox.size.x).toBeCloseTo(5.5)
    expect(metadata.isDemo).toBe(false)

    first.geometry.dispose()
    second.geometry.dispose()
    material.dispose()
    texture.dispose()
  })

  it('formats counts and dimensions for compact overlays', () => {
    expect(formatViewerCount(1234567)).toBe('1,234,567')
    expect(formatViewerDimension(12.345)).toBe('12.3 m')
    expect(formatViewerDimension(0.1234)).toBe('0.123 m')
  })

  it('time-slices bounds for a large synthetic mesh', async () => {
    const vertexCount = 4096
    const values = new Float32Array(vertexCount * 3)
    for (let index = 0; index < vertexCount; index += 1) {
      values[index * 3] = index
      values[index * 3 + 1] = index % 7
      values[index * 3 + 2] = 0
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(values, 3))
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const metadata = await computeViewerMetadataAsync(mesh, 'Large synthetic', false, { chunkSize: 256 })
      expect(metadata.vertexCount).toBe(vertexCount)
      expect(metadata.boundingBox.min.x).toBe(0)
      expect(metadata.boundingBox.max.x).toBe(vertexCount - 1)
      expect(timeoutSpy).toHaveBeenCalled()
    } finally {
      timeoutSpy.mockRestore()
      geometry.dispose()
      material.dispose()
    }
  })

  it('uses parser-owned source counts and bounds without rescanning expanded positions', async () => {
    const values = new Float32Array([
      0, 0, 0,
      2, 0, 0,
      0, 0, 2,
      0, 0, 0,
      2, 0, 0,
      0, 0, 2,
    ])
    const geometry = new THREE.BufferGeometry()
    const position = new THREE.BufferAttribute(values, 3)
    geometry.setAttribute('position', position)
    geometry.setIndex([0, 1, 2, 3, 4, 5])
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    const root = new THREE.Group()
    root.add(mesh)
    const getX = vi.spyOn(position, 'getX')
    try {
      const metadata = await computeViewerMetadataAsync(root, 'Source counts', false, {
        source: {
          vertexCount: 3,
          polygonCount: 2,
          bounds: {
            min: { x: 0, y: 0, z: 0 },
            max: { x: 100, y: 100, z: 100 },
            size: { x: 100, y: 100, z: 100 },
          },
          renderedBounds: {
            min: { x: 0, y: 0, z: 0 },
            max: { x: 2, y: 0, z: 2 },
            size: { x: 2, y: 0, z: 2 },
          },
        },
      })
      expect(metadata.vertexCount).toBe(6)
      expect(metadata.sourceVertexCount).toBe(3)
      expect(metadata.sourcePolygonCount).toBe(2)
      expect(metadata.sourceBounds?.max.x).toBe(100)
      expect(metadata.boundingBox.max.z).toBe(2)
      expect(getX).not.toHaveBeenCalled()
    } finally {
      getX.mockRestore()
      geometry.dispose()
      material.dispose()
    }
  })
})
