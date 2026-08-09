/// <reference lib="webworker" />
import { exactObjArrayBuffer, parseObjDocument, type ObjDocumentBounds, type ObjDocumentSourceCounts } from './objParser'

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
  readonly referencedBounds?: ObjDocumentBounds
  readonly sourceCounts?: ObjDocumentSourceCounts
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
      indices: exactObjArrayBuffer(group.indices),
      indicesLength: group.indices.length,
      uvIndices: exactObjArrayBuffer(group.uvIndices),
      uvIndicesLength: group.uvIndices.length,
      normalIndices: exactObjArrayBuffer(group.normalIndices),
      normalIndicesLength: group.normalIndices.length,
    }))
    const positions = exactObjArrayBuffer(parsed.positions)
    const texcoords = exactObjArrayBuffer(parsed.texcoords)
    const normals = exactObjArrayBuffer(parsed.normals)
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
      referencedBounds: parsed.referencedBounds,
      sourceCounts: parsed.sourceCounts,
      groups,
    }, transfer)
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }, [])
  }
}
