import type * as THREE from 'three'
import type { ViewerModelMetadata } from './types'

/** Renderer-owned model handle; never exported from the viewer public barrel. */
export interface LoadedViewerModel {
  readonly object: THREE.Group
  readonly metadata: ViewerModelMetadata
  readonly dispose: () => void
}
