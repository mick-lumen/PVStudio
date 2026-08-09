import * as THREE from 'three'
import { computeViewerMetadata } from './metadata'
import { disposeViewerObject } from './renderMode'
import type { LoadedViewerModel } from './internalTypes'

const DEMO_COLORS = {
  ground: 0x778b7c,
  wall: 0xc6b9a2,
  roofNorth: 0x667d80,
  roofSouth: 0x70898b,
  trim: 0x4e5a5d,
  tree: 0x3d624c,
} as const

function createRoofSection(
  name: string,
  zStart: number,
  zEnd: number,
  ridgeHeight: number,
  edgeHeight: number,
  color: number,
): THREE.Mesh {
  const columns = 12
  const rows = 8
  const width = 10
  const positions: number[] = []
  const indices: number[] = []
  for (let row = 0; row <= rows; row += 1) {
    const rowProgress = row / rows
    const z = zStart + (zEnd - zStart) * rowProgress
    const y = ridgeHeight + (edgeHeight - ridgeHeight) * rowProgress
    for (let column = 0; column <= columns; column += 1) {
      const x = -width / 2 + (width * column) / columns
      positions.push(x, y, z)
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const topLeft = row * (columns + 1) + column
      const topRight = topLeft + 1
      const bottomLeft = topLeft + columns + 1
      const bottomRight = bottomLeft + 1
      indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.86,
    metalness: 0.03,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = name
  mesh.userData.surface = true
  mesh.userData.surfaceLabel = name
  return mesh
}

function createTree(position: THREE.Vector3, scale: number): THREE.Group {
  const tree = new THREE.Group()
  tree.name = 'Demo vegetation'
  tree.userData.selectable = false
  tree.position.copy(position)
  tree.scale.setScalar(scale)
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.14, 1.1, 6),
    new THREE.MeshStandardMaterial({ color: 0x765b3f, roughness: 1 }),
  )
  trunk.position.y = 0.55
  const canopy = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.75, 1),
    new THREE.MeshStandardMaterial({ color: DEMO_COLORS.tree, roughness: 1 }),
  )
  canopy.position.y = 1.35
  tree.add(trunk, canopy)
  return tree
}

/** Creates a deterministic, lightweight site resembling a textured survey model. */
export function createDemoSite(): THREE.Group {
  const site = new THREE.Group()
  site.name = 'Demo photogrammetry site'

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 20, 1, 1),
    new THREE.MeshStandardMaterial({ color: DEMO_COLORS.ground, roughness: 1, metalness: 0 }),
  )
  ground.name = 'Ground surface'
  ground.rotation.x = -Math.PI / 2
  ground.userData.surface = true
  ground.userData.surfaceLabel = 'Ground'
  site.add(ground)

  const house = new THREE.Mesh(
    new THREE.BoxGeometry(10, 3, 6),
    new THREE.MeshStandardMaterial({ color: DEMO_COLORS.wall, roughness: 0.92 }),
  )
  house.name = 'House walls'
  house.position.y = 1.5
  house.userData.surface = true
  site.add(house)

  const northRoof = createRoofSection('Roof north face', 0, 3.35, 4.65, 3.35, DEMO_COLORS.roofNorth)
  const southRoof = createRoofSection('Roof south face', -3.35, 0, 3.35, 4.65, DEMO_COLORS.roofSouth)
  site.add(northRoof, southRoof)

  const ridge = new THREE.Mesh(
    new THREE.BoxGeometry(10.3, 0.18, 0.2),
    new THREE.MeshStandardMaterial({ color: DEMO_COLORS.trim, roughness: 0.7 }),
  )
  ridge.name = 'Roof ridge'
  ridge.position.y = 4.65
  site.add(ridge)

  site.add(
    createTree(new THREE.Vector3(-8, 0, -5), 1.2),
    createTree(new THREE.Vector3(8, 0, 4.6), 0.9),
    createTree(new THREE.Vector3(-9.5, 0, 5.8), 0.78),
  )

  // Small survey markers help the scene read as a site capture while keeping
  // geometry intentionally inexpensive for tests and first paint.
  const markerMaterial = new THREE.MeshStandardMaterial({ color: 0xd2a354, roughness: 0.8 })
  for (const [x, z] of [
    [-6, -2],
    [6, -2],
    [6, 6],
    [-4, 7],
  ] as const) {
    const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.25, 8), markerMaterial)
    marker.name = 'Survey marker'
    marker.position.set(x, 0.125, z)
    site.add(marker)
  }

  site.updateMatrixWorld(true)
  return site
}

export function createDemoViewerModel(): LoadedViewerModel {
  const object = createDemoSite()
  const metadata = computeViewerMetadata(object, 'Demo survey site', true)
  return {
    object,
    metadata,
    dispose: () => {
      disposeViewerObject(object)
    },
  }
}
