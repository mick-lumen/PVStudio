import * as THREE from 'three'
import type { ViewerRenderMode } from './types'

interface WireframeMaterial extends THREE.Material {
  wireframe: boolean
}

interface TexturedMaterial extends THREE.Material {
  map: THREE.Texture | null
}

interface MaterialState {
  readonly wireframe?: boolean
  readonly map?: THREE.Texture | null
}

const originalMaterialState = new WeakMap<THREE.Material, MaterialState>()
const disposedTextures = new WeakSet<THREE.Texture>()

interface ViewerMesh extends THREE.Object3D {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
}

function isViewerMesh(child: THREE.Object3D): child is ViewerMesh {
  return child instanceof THREE.Mesh
}

function materialsFor(mesh: ViewerMesh): readonly THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

function hasWireframe(material: THREE.Material): material is WireframeMaterial {
  return 'wireframe' in material
}

function hasMap(material: THREE.Material): material is TexturedMaterial {
  return 'map' in material
}

/** Applies a clean texture/wireframe presentation while preserving the source material. */
export function applyViewerRenderMode(root: THREE.Object3D, mode: ViewerRenderMode): void {
  root.traverse((child) => {
    if (!isViewerMesh(child)) return
    for (const material of materialsFor(child)) {
      if (!originalMaterialState.has(material)) {
        originalMaterialState.set(material, {
          wireframe: hasWireframe(material) ? material.wireframe : undefined,
          map: hasMap(material) ? material.map : undefined,
        })
      }

      const original = originalMaterialState.get(material)
      if (mode === 'wireframe') {
        if (hasWireframe(material)) material.wireframe = true
        if (hasMap(material)) material.map = null
      } else {
        if (hasWireframe(material) && original?.wireframe !== undefined) material.wireframe = original.wireframe
        if (hasMap(material) && original !== undefined && original.map !== undefined) material.map = original.map
      }
      material.needsUpdate = true
    }
  })
}

/** Releases GPU resources owned by a loaded viewer object. */
export function disposeViewerObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  root.traverse((child) => {
    if (!isViewerMesh(child)) return
    geometries.add(child.geometry)
    for (const material of materialsFor(child)) {
      materials.add(material)
      const original = originalMaterialState.get(material)
      if (original?.map instanceof THREE.Texture) textures.add(original.map)
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value)
      }
    }
  })
  for (const geometry of geometries) geometry.dispose()
  for (const texture of textures) {
    if (disposedTextures.has(texture)) continue
    disposedTextures.add(texture)
    texture.dispose()
  }
  for (const material of materials) material.dispose()
  for (const material of materials) originalMaterialState.delete(material)
}
