/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PVSTUDIO_SAMPLE_BASE_PATH?: string
  readonly VITE_SURFACE_NORMAL_ANGLE_TOLERANCE_DEG?: string
  readonly VITE_SURFACE_PLANE_TOLERANCE_M?: string
  readonly VITE_SURFACE_JOIN_TOLERANCE_M?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
