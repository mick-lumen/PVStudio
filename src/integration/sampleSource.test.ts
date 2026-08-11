import { describe, expect, it } from 'vitest'
import { createSampleViewerSource, sampleModelAssetPaths } from './sampleSource'

describe('checked-in WebODM sample source', () => {
  it('uses the public fixture OBJ, MTL, and texture URLs by default', () => {
    const source = createSampleViewerSource()
    expect(source).toMatchObject({
      obj: '/test-data/synthetic-webodm-house/synthetic-webodm-house.obj.gz',
      mtl: '/test-data/synthetic-webodm-house/synthetic-webodm-house.mtl',
      name: 'Synthetic WebODM house',
      upAxis: 'y',
    })
    expect(source.textures).toEqual([
      '/test-data/synthetic-webodm-house/ground-texture.jpg',
      '/test-data/synthetic-webodm-house/roof-texture.jpg',
      '/test-data/synthetic-webodm-house/wall-texture.jpg',
    ])
    expect(Object.isFrozen(source)).toBe(true)
    expect(Object.isFrozen(source.textures)).toBe(true)
  })

  it('honours an explicit relative or absolute asset base path', () => {
    expect(sampleModelAssetPaths('/assets/fixture')).toEqual({
      basePath: '/assets/fixture',
      obj: '/assets/fixture/synthetic-webodm-house.obj.gz',
      mtl: '/assets/fixture/synthetic-webodm-house.mtl',
      textures: [
        '/assets/fixture/ground-texture.jpg',
        '/assets/fixture/roof-texture.jpg',
        '/assets/fixture/wall-texture.jpg',
      ],
    })
    expect(sampleModelAssetPaths('https://cdn.example.test/pv-sample/')).toMatchObject({
      basePath: 'https://cdn.example.test/pv-sample',
      obj: 'https://cdn.example.test/pv-sample/synthetic-webodm-house.obj.gz',
    })
  })
})
