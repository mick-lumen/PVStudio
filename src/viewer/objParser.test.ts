import { describe, expect, it, vi } from 'vitest'
import { exactObjArrayBuffer, parseObjDocument, parseObjDocumentAsync } from './objParser'

describe('non-blocking OBJ parser', () => {
  it('triangulates polygons, resolves negative indices, and groups materials', () => {
    const parsed = parseObjDocument([
      'o Roof',
      'v 0 0 0',
      'v 2 0 0',
      'v 2 0 2',
      'v 0 0 2',
      'usemtl Blue',
      'f 1 2 3 4',
      'usemtl Red',
      'f -4 -3 -2',
    ].join('\n'))
    expect(parsed.positions).toHaveLength(12)
    expect(parsed.groups).toHaveLength(2)
    expect(parsed.groups[0]?.indices).toHaveLength(6)
    expect(parsed.groups[1]?.indices).toEqual(new Uint32Array([0, 1, 2]))
    expect(parsed.sourceCounts).toEqual({
      vertexCount: 4,
      texcoordCount: 0,
      normalCount: 0,
      polygonCount: 3,
      cornerCount: 9,
    })
  })

  it('preserves texture and normal streams, including negative corner indices', () => {
    const parsed = parseObjDocument([
      'v 0 0 0',
      'v 1 0 0',
      'v 1 0 1',
      'v 0 0 1',
      'vt 0 0',
      'vt 1 0',
      'vt 1 1',
      'vt 0 1',
      'vn 0 1 0',
      'usemtl RoofTexture',
      'f -4/-4/-1 -3/-3/-1 -2/-2/-1 -1/-1/-1',
    ].join('\n'))
    expect(parsed.texcoords).toEqual(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]))
    expect(parsed.normals).toEqual(new Float32Array([0, 1, 0]))
    expect(parsed.groups[0]?.indices).toEqual(new Uint32Array([0, 1, 2, 0, 2, 3]))
    expect(parsed.groups[0]?.uvIndices).toEqual(new Int32Array([0, 1, 2, 0, 2, 3]))
    expect(parsed.groups[0]?.normalIndices).toEqual(new Int32Array([0, 0, 0, 0, 0, 0]))
  })

  it('can skip generated normals for the worker large-model flat path', () => {
    const source = [
      'v 0 0 0',
      'v 1 0 0',
      'v 0 0 1',
      'f 1 2 3',
    ].join('\n')
    const parsed = parseObjDocument(source, undefined, false)
    expect(parsed.normals).toHaveLength(0)
    expect(parsed.groups[0]?.normalIndices).toEqual(new Int32Array([-1, -1, -1]))
  })

  it('keeps the asynchronous large-model path free of generated normals', async () => {
    const source = [
      'v 0 0 0',
      'v 1 0 0',
      'v 0 0 1',
      'f 1 2 3',
    ].join('\n')
    const parsed = await parseObjDocumentAsync(source, { chunkSize: 1, deriveNormals: false })
    expect(parsed.normals).toHaveLength(0)
    expect(parsed.groups[0]?.normalIndices).toEqual(new Int32Array([-1, -1, -1]))
  })

  it('yields macrotasks between chunks instead of blocking one long parse task', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const channel = vi.spyOn(globalThis, 'MessageChannel')
    const source = Array.from({ length: 8 }, (_, index) => `v ${String(index)} 0 0`).join('\n')
    await parseObjDocumentAsync(source, { chunkSize: 2 })
    expect(timer.mock.calls.length + channel.mock.calls.length).toBeGreaterThan(0)
    timer.mockRestore()
    channel.mockRestore()
  })

  it('returns exact-length typed-array backing buffers for worker transfer', () => {
    const parsed = parseObjDocument([
      'v 0 0 0',
      'v 1 0 0',
      'v 0 0 1',
      'vt 0 0',
      'vt 1 0',
      'vt 0 1',
      'f 1/1 2/2 3/3',
    ].join('\n'), undefined, false)
    const streams: readonly ArrayLike<number>[] = [
      parsed.positions,
      parsed.texcoords,
      parsed.normals,
      parsed.groups[0]?.indices ?? new Uint32Array(),
      parsed.groups[0]?.uvIndices ?? new Int32Array(),
      parsed.groups[0]?.normalIndices ?? new Int32Array(),
    ]
    for (const stream of streams) {
      if (!(stream instanceof Float32Array || stream instanceof Uint32Array || stream instanceof Int32Array)) continue
      expect(stream.byteOffset).toBe(0)
      expect(stream.buffer.byteLength).toBe(stream.byteLength)
    }
    const subarray = parsed.positions.subarray(3)
    const transferred = exactObjArrayBuffer(subarray)
    expect(transferred.byteLength).toBe(subarray.byteLength)
  })

  it('keeps source bounds separate from positions referenced by faces', () => {
    const parsed = parseObjDocument([
      'v 0 0 0',
      'v 1 0 0',
      'v 0 0 1',
      'v 1000 1000 1000',
      'f 1 2 3',
    ].join('\n'), undefined, false)

    expect(parsed.bounds.max).toEqual({ x: 1000, y: 1000, z: 1000 })
    expect(parsed.referencedBounds?.max).toEqual({ x: 1, y: 0, z: 1 })
  })
})
