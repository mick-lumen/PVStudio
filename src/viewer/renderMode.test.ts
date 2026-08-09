import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { applyViewerRenderMode, disposeViewerObject } from './renderMode'

describe('viewer render mode and disposal', () => {
  it('toggles wireframe without losing the source texture', () => {
    const texture = new THREE.Texture()
    const material = new THREE.MeshBasicMaterial({ map: texture, wireframe: false })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)

    applyViewerRenderMode(mesh, 'wireframe')
    expect(material.wireframe).toBe(true)
    expect(material.map).toBeNull()
    applyViewerRenderMode(mesh, 'texture')
    expect(material.wireframe).toBe(false)
    expect(material.map).toBe(texture)

    mesh.geometry.dispose()
    material.dispose()
    texture.dispose()
  })

  it('deduplicates shared GPU resources during disposal', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshBasicMaterial()
    const first = new THREE.Mesh(geometry, material)
    const second = new THREE.Mesh(geometry, material)
    const root = new THREE.Group().add(first, second)
    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')

    disposeViewerObject(root)
    disposeViewerObject(root)
    expect(geometryDispose).toHaveBeenCalledTimes(2)
    expect(materialDispose).toHaveBeenCalledTimes(2)
  })

  it('recovers and disposes the source map once after wireframe mode', () => {
    const texture = new THREE.Texture()
    const material = new THREE.MeshBasicMaterial({ map: texture })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
    const textureDispose = vi.spyOn(texture, 'dispose')

    applyViewerRenderMode(mesh, 'wireframe')
    expect(material.map).toBeNull()
    applyViewerRenderMode(mesh, 'texture')
    applyViewerRenderMode(mesh, 'wireframe')
    disposeViewerObject(mesh)
    disposeViewerObject(mesh)

    expect(textureDispose).toHaveBeenCalledTimes(1)
  })
})
