/// <reference lib="webworker" />
import { parseObjDocument, type ObjDocumentBounds } from './objParser'

interface WorkerRequest {
  readonly type: 'parse'
  readonly buffer: ArrayBuffer
}

interface WorkerGroup {
  readonly name: string
  readonly materialName: string | null
  readonly indices: ArrayBuffer
  readonly indicesLength: number
  readonly uvIndices: ArrayBuffer
  readonly uvIndicesLength: number
  readonly normalIndices: ArrayBuffer
  readonly normalIndicesLength: number
}

interface WorkerResponse {
  readonly type: 'result' | 'error'
  readonly positions?: ArrayBuffer
  readonly positionsLength?: number
  readonly texcoords?: ArrayBuffer
  readonly texcoordsLength?: number
  readonly normals?: ArrayBuffer
  readonly normalsLength?: number
  readonly bounds?: ObjDocumentBounds
  readonly groups?: readonly WorkerGroup[]
  readonly message?: string
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: WorkerResponse, transfer: readonly Transferable[]) => void
}

const scope = globalThis as unknown as WorkerScope
scope.onmessage = (event): void => {
  try {
    const source = new TextDecoder().decode(event.data.buffer)
    // Keep large no-normal imports on the indexed flat-material path. Normal
    // derivation is O(cornerCount) and duplicates the worker's parser pass;
    // small/fallback parses can still request the historical generated-normal
    // behavior through parseObjDocument's default argument.
    const parsed = parseObjDocument(source, undefined, false)
    const groups = parsed.groups.map((group) => ({
      name: group.name,
      materialName: group.materialName,
      indices: group.indices.buffer as ArrayBuffer,
      indicesLength: group.indices.length,
      uvIndices: group.uvIndices.buffer as ArrayBuffer,
      uvIndicesLength: group.uvIndices.length,
      normalIndices: group.normalIndices.buffer as ArrayBuffer,
      normalIndicesLength: group.normalIndices.length,
    }))
    const positions = parsed.positions.buffer as ArrayBuffer
    const texcoords = parsed.texcoords.buffer as ArrayBuffer
    const normals = parsed.normals.buffer as ArrayBuffer
    const transfer: Transferable[] = [positions, texcoords, normals, ...groups.flatMap((group) => [group.indices, group.uvIndices, group.normalIndices])]
    scope.postMessage({
      type: 'result',
      positions,
      positionsLength: parsed.positions.length,
      texcoords,
      texcoordsLength: parsed.texcoords.length,
      normals,
      normalsLength: parsed.normals.length,
      bounds: parsed.bounds,
      groups,
    }, transfer)
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }, [])
  }
}
