import type { ViewerModelSource } from '../viewer'

/** Public paths for the checked-in, deterministic WebODM-shaped fixture. */
export const SAMPLE_MODEL_ASSET_NAMES = Object.freeze({
  obj: 'synthetic-webodm-house.obj',
  mtl: 'synthetic-webodm-house.mtl',
  textures: Object.freeze(['ground-texture.jpg', 'roof-texture.jpg', 'wall-texture.jpg']),
})

export interface SampleModelAssetPaths {
  readonly basePath: string
  readonly obj: string
  readonly mtl: string
  readonly textures: readonly string[]
}

const DEFAULT_SAMPLE_BASE_PATH = '/test-data/synthetic-webodm-house'

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, '')

/**
 * Resolve a fixture base path without assuming that PV Studio is hosted at
 * the origin root. VITE_PVSTUDIO_SAMPLE_BASE_PATH can point at a subpath or
 * an asset host; Vite's BASE_URL remains the safe default for static builds.
 */
export function sampleModelAssetPaths(basePath?: string): SampleModelAssetPaths {
  const configured = basePath?.trim() || import.meta.env.VITE_PVSTUDIO_SAMPLE_BASE_PATH?.trim()
  const viteBase = import.meta.env.BASE_URL.trim() || '/'
  const defaultPath = viteBase === '/' ? DEFAULT_SAMPLE_BASE_PATH : `${trimTrailingSlashes(viteBase)}/test-data/synthetic-webodm-house`
  const resolvedBase = trimTrailingSlashes(configured || defaultPath) || DEFAULT_SAMPLE_BASE_PATH
  const join = (name: string): string => `${resolvedBase}/${name}`
  return Object.freeze({
    basePath: resolvedBase,
    obj: join(SAMPLE_MODEL_ASSET_NAMES.obj),
    mtl: join(SAMPLE_MODEL_ASSET_NAMES.mtl),
    textures: Object.freeze(SAMPLE_MODEL_ASSET_NAMES.textures.map(join)),
  })
}

/**
 * Build the same URL-backed source that the production Viewer consumes. The
 * URLs deliberately stay public strings instead of File mocks, so the sample
 * action exercises the real fetch/OBJ/MTL/texture loading path.
 */
export function createSampleViewerSource(basePath?: string): ViewerModelSource {
  const paths = sampleModelAssetPaths(basePath)
  return Object.freeze({
    obj: paths.obj,
    mtl: paths.mtl,
    textures: paths.textures,
    name: 'Synthetic WebODM house',
  })
}
