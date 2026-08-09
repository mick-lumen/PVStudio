/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PVSTUDIO_SAMPLE_BASE_PATH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
