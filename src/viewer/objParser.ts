/**
 * Small, allocation-conscious OBJ position/index parser.  It intentionally
 * leaves material construction to the main thread while making the expensive
 * text scan yield at macrotask boundaries (or run in viewerModelWorker.ts).
 */

export interface ParsedObjGroup {
  readonly name: string
  readonly materialName: string | null
  readonly indices: Uint32Array
  /** Texture-coordinate index for each corner in `indices`, or -1 when absent. */
  readonly uvIndices: Int32Array
  /** Vertex-normal index for each corner in `indices`, or -1 when absent. */
  readonly normalIndices: Int32Array
}

export interface ObjDocumentBounds {
  readonly min: { readonly x: number; readonly y: number; readonly z: number }
  readonly max: { readonly x: number; readonly y: number; readonly z: number }
}

export interface ParsedObjDocument {
  readonly positions: Float32Array
  readonly texcoords: Float32Array
  readonly normals: Float32Array
  readonly groups: readonly ParsedObjGroup[]
  /** Bounds collected while reading `v` records; avoids a second vertex scan. */
  readonly bounds: ObjDocumentBounds
}

export interface ObjParserOptions {
  readonly signal?: AbortSignal
  /** Number of source lines processed between macrotask yields. */
  readonly chunkSize?: number
  /** Cooperative time budget (ms) for a fallback parser slice. */
  readonly timeBudgetMs?: number
  /** Skip generated normals for large no-`vn` imports; explicit normals remain. */
  readonly deriveNormals?: boolean
}

interface MutableGroup {
  readonly name: string
  readonly materialName: string | null
  readonly indices: Uint32Builder
  readonly uvIndices: Int32Builder
  readonly normalIndices: Int32Builder
  generatedNormalIndices?: Int32Array
}

interface ObjAccumulator {
  readonly positions: Float32Builder
  readonly texcoords: Float32Builder
  readonly normals: Float32Builder
  readonly groups: Map<string, MutableGroup>
  groupName: string
  materialName: string | null
  generatedNormals?: Float32Array
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

/** Growable typed buffers keep large OBJ scans off the JS number[] heap. */
class Float32Builder {
  private buffer = new Float32Array(256)
  public length = 0

  private ensure(extra: number): void {
    const required = this.length + extra
    if (required <= this.buffer.length) return
    let capacity = this.buffer.length
    while (capacity < required) capacity = Math.min(Math.max(required, capacity * 2), 0x3fffffff)
    const next = new Float32Array(capacity)
    next.set(this.buffer)
    this.buffer = next
  }

  public push2(first: number, second: number): void {
    this.ensure(2)
    this.buffer[this.length] = first
    this.buffer[this.length + 1] = second
    this.length += 2
  }

  public push3(first: number, second: number, third: number): void {
    this.ensure(3)
    this.buffer[this.length] = first
    this.buffer[this.length + 1] = second
    this.buffer[this.length + 2] = third
    this.length += 3
  }

  public view(): Float32Array {
    return this.buffer.subarray(0, this.length)
  }
}

class Uint32Builder {
  private buffer = new Uint32Array(256)
  public length = 0

  private ensure(extra: number): void {
    const required = this.length + extra
    if (required <= this.buffer.length) return
    let capacity = this.buffer.length
    while (capacity < required) capacity = Math.min(Math.max(required, capacity * 2), 0x3fffffff)
    const next = new Uint32Array(capacity)
    next.set(this.buffer)
    this.buffer = next
  }

  public push3(first: number, second: number, third: number): void {
    this.ensure(3)
    this.buffer[this.length] = first
    this.buffer[this.length + 1] = second
    this.buffer[this.length + 2] = third
    this.length += 3
  }

  public view(): Uint32Array {
    return this.buffer.subarray(0, this.length)
  }
}

class Int32Builder {
  private buffer = new Int32Array(256)
  public length = 0

  private ensure(extra: number): void {
    const required = this.length + extra
    if (required <= this.buffer.length) return
    let capacity = this.buffer.length
    while (capacity < required) capacity = Math.min(Math.max(required, capacity * 2), 0x3fffffff)
    const next = new Int32Array(capacity)
    next.set(this.buffer)
    this.buffer = next
  }

  public push3(first: number, second: number, third: number): void {
    this.ensure(3)
    this.buffer[this.length] = first
    this.buffer[this.length + 1] = second
    this.buffer[this.length + 2] = third
    this.length += 3
  }

  public view(): Int32Array {
    return this.buffer.subarray(0, this.length)
  }
}

function newAccumulator(): ObjAccumulator {
  return {
    positions: new Float32Builder(),
    texcoords: new Float32Builder(),
    normals: new Float32Builder(),
    groups: new Map(),
    groupName: 'default',
    materialName: null,
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  }
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Model loading was cancelled', 'AbortError')
}

function parseNumberRange(source: string, start: number, end: number): number | null {
  if (start >= end) return null
  const parsed = Number(source.slice(start, end))
  return Number.isFinite(parsed) ? parsed : null
}

function sourceIndexRange(source: string, start: number, end: number, count: number): number | null {
  const parsed = parseNumberRange(source, start, end)
  if (parsed === null || !Number.isInteger(parsed) || parsed === 0) return null
  const resolved = parsed < 0 ? count + parsed : parsed - 1
  return resolved >= 0 && resolved < count ? resolved : null
}

interface FaceCornerScratch {
  position: number
  uv: number
  normal: number
}

/** Parses one face token without split/map/filter allocations. */
function parseFaceCornerRange(
  source: string,
  start: number,
  end: number,
  vertexCount: number,
  texcoordCount: number,
  normalCount: number,
  target: FaceCornerScratch,
): boolean {
  let firstSlash = -1
  let secondSlash = -1
  for (let index = start; index < end; index += 1) {
    const code = source.charCodeAt(index)
    if (code !== 47) continue
    if (firstSlash < 0) firstSlash = index
    else {
      secondSlash = index
      break
    }
  }
  const positionEnd = firstSlash < 0 ? end : firstSlash
  const position = sourceIndexRange(source, start, positionEnd, vertexCount)
  if (position === null) return false
  target.position = position
  target.uv = -1
  target.normal = -1
  if (firstSlash < 0) return true
  const uvStart = firstSlash + 1
  const uvEnd = secondSlash < 0 ? end : secondSlash
  if (uvStart < uvEnd) target.uv = sourceIndexRange(source, uvStart, uvEnd, texcoordCount) ?? -1
  if (secondSlash >= 0 && secondSlash + 1 < end) target.normal = sourceIndexRange(source, secondSlash + 1, end, normalCount) ?? -1
  return true
}

function groupFor(accumulator: ObjAccumulator): MutableGroup {
  const key = `${accumulator.groupName}\u0000${accumulator.materialName ?? ''}`
  const existing = accumulator.groups.get(key)
  if (existing !== undefined) return existing
  const created: MutableGroup = {
    name: accumulator.groupName,
    materialName: accumulator.materialName,
    indices: new Uint32Builder(),
    uvIndices: new Int32Builder(),
    normalIndices: new Int32Builder(),
  }
  accumulator.groups.set(key, created)
  return created
}

function parseLine(line: string, accumulator: ObjAccumulator): void {
  let start = 0
  while (start < line.length && line.charCodeAt(start) <= 32) start += 1
  if (start >= line.length || line.charCodeAt(start) === 35) return
  let commandEnd = start
  while (commandEnd < line.length && line.charCodeAt(commandEnd) > 32) commandEnd += 1
  const command = line.slice(start, commandEnd)
  let contentEnd = line.indexOf('#', commandEnd)
  if (contentEnd < 0) contentEnd = line.length
  const nextToken = (from: number): [number, number] | null => {
    let tokenStart = from
    while (tokenStart < contentEnd && line.charCodeAt(tokenStart) <= 32) tokenStart += 1
    if (tokenStart >= contentEnd) return null
    let tokenEnd = tokenStart + 1
    while (tokenEnd < contentEnd && line.charCodeAt(tokenEnd) > 32) tokenEnd += 1
    return [tokenStart, tokenEnd]
  }
  if (command === 'v' || command === 'vt' || command === 'vn') {
    const first = nextToken(commandEnd)
    const second = first === null ? null : nextToken(first[1])
    const third = second === null ? null : nextToken(second[1])
    const x = first === null ? null : parseNumberRange(line, first[0], first[1])
    const y = second === null ? null : parseNumberRange(line, second[0], second[1])
    const z = third === null ? null : parseNumberRange(line, third[0], third[1])
    if (x === null || y === null) return
    if (command === 'vt') {
      accumulator.texcoords.push2(x, y)
    } else {
      if (z === null) return
      if (command === 'v') {
        accumulator.positions.push3(x, y, z)
        accumulator.minX = Math.min(accumulator.minX, x)
        accumulator.minY = Math.min(accumulator.minY, y)
        accumulator.minZ = Math.min(accumulator.minZ, z)
        accumulator.maxX = Math.max(accumulator.maxX, x)
        accumulator.maxY = Math.max(accumulator.maxY, y)
        accumulator.maxZ = Math.max(accumulator.maxZ, z)
      }
      else accumulator.normals.push3(x, y, z)
    }
    return
  }
  if (command === 'o' || command === 'g' || command === 'usemtl') {
    let nameStart = commandEnd
    while (nameStart < contentEnd && line.charCodeAt(nameStart) <= 32) nameStart += 1
    const name = line.slice(nameStart, contentEnd).trim()
    if (command === 'usemtl') accumulator.materialName = name.length === 0 ? null : name
    else accumulator.groupName = name.length === 0 ? 'default' : name
    return
  }
  if (command !== 'f') return
  const vertexCount = accumulator.positions.length / 3
  const texcoordCount = accumulator.texcoords.length / 2
  const normalCount = accumulator.normals.length / 3
  const parsedCorner = { position: 0, uv: -1, normal: -1 } satisfies FaceCornerScratch
  let validCorners = 0
  let firstPosition = 0
  let firstUv = -1
  let firstNormal = -1
  let secondPosition = 0
  let secondUv = -1
  let secondNormal = -1
  let token = nextToken(commandEnd)
  let group: MutableGroup | undefined
  while (token !== null) {
    if (parseFaceCornerRange(line, token[0], token[1], vertexCount, texcoordCount, normalCount, parsedCorner)) {
      if (validCorners === 0) {
        firstPosition = parsedCorner.position; firstUv = parsedCorner.uv; firstNormal = parsedCorner.normal
      } else if (validCorners === 1) {
        secondPosition = parsedCorner.position; secondUv = parsedCorner.uv; secondNormal = parsedCorner.normal
      } else {
        group ??= groupFor(accumulator)
        group.indices.push3(firstPosition, secondPosition, parsedCorner.position)
        group.uvIndices.push3(firstUv, secondUv, parsedCorner.uv)
        group.normalIndices.push3(firstNormal, secondNormal, parsedCorner.normal)
        secondPosition = parsedCorner.position; secondUv = parsedCorner.uv; secondNormal = parsedCorner.normal
      }
      validCorners += 1
    }
    token = nextToken(token[1])
  }
}

/**
 * Checks whether a source line is blank/comment-only without allocating a
 * substring. Large OBJ exports often carry a multi-megabyte trailing comment;
 * slicing that line before discovering it is ignorable creates a transient
 * duplicate of the complete source and can trigger a long GC pause.
 */
function isBlankOrCommentRange(source: string, start: number, end: number): boolean {
  let cursor = start
  while (cursor < end && source.charCodeAt(cursor) <= 32) cursor += 1
  return cursor >= end || source.charCodeAt(cursor) === 35
}

/**
 * Generates one normal per indexed position for worker-side OBJ input that
 * does not provide an explicit `vn` stream.  The generated normal indices are
 * exactly the position indices, so the main thread can keep the geometry
 * indexed instead of expanding every face corner.
 */
function derivePositionNormals(accumulator: ObjAccumulator): void {
  if (accumulator.normals.length > 0 || accumulator.generatedNormals !== undefined) return
  const positions = accumulator.positions.view()
  const sums = new Float32Array(positions.length)
  for (const group of accumulator.groups.values()) {
    const indices = group.indices.view()
    const generatedIndices = new Int32Array(indices.length)
    for (let corner = 0; corner < indices.length; corner += 1) generatedIndices[corner] = indices[corner] ?? 0
    group.generatedNormalIndices = generatedIndices
    for (let corner = 0; corner + 2 < indices.length; corner += 3) {
      const first = (indices[corner] ?? 0) * 3
      const second = (indices[corner + 1] ?? 0) * 3
      const third = (indices[corner + 2] ?? 0) * 3
      const ax = (positions[second] ?? 0) - (positions[first] ?? 0)
      const ay = (positions[second + 1] ?? 0) - (positions[first + 1] ?? 0)
      const az = (positions[second + 2] ?? 0) - (positions[first + 2] ?? 0)
      const bx = (positions[third] ?? 0) - (positions[first] ?? 0)
      const by = (positions[third + 1] ?? 0) - (positions[first + 1] ?? 0)
      const bz = (positions[third + 2] ?? 0) - (positions[first + 2] ?? 0)
      const normalX = ay * bz - az * by
      const normalY = az * bx - ax * bz
      const normalZ = ax * by - ay * bx
      const firstIndex = indices[corner] ?? 0
      const secondIndex = indices[corner + 1] ?? 0
      const thirdIndex = indices[corner + 2] ?? 0
      const firstOffset = firstIndex * 3
      const secondOffset = secondIndex * 3
      const thirdOffset = thirdIndex * 3
      sums[firstOffset] = (sums[firstOffset] ?? 0) + normalX
      sums[firstOffset + 1] = (sums[firstOffset + 1] ?? 0) + normalY
      sums[firstOffset + 2] = (sums[firstOffset + 2] ?? 0) + normalZ
      sums[secondOffset] = (sums[secondOffset] ?? 0) + normalX
      sums[secondOffset + 1] = (sums[secondOffset + 1] ?? 0) + normalY
      sums[secondOffset + 2] = (sums[secondOffset + 2] ?? 0) + normalZ
      sums[thirdOffset] = (sums[thirdOffset] ?? 0) + normalX
      sums[thirdOffset + 1] = (sums[thirdOffset + 1] ?? 0) + normalY
      sums[thirdOffset + 2] = (sums[thirdOffset + 2] ?? 0) + normalZ
    }
  }
  for (let offset = 0; offset < sums.length; offset += 3) {
    const length = Math.hypot(sums[offset] ?? 0, sums[offset + 1] ?? 0, sums[offset + 2] ?? 0)
    if (length > Number.EPSILON) {
      sums[offset] = (sums[offset] ?? 0) / length
      sums[offset + 1] = (sums[offset + 1] ?? 0) / length
      sums[offset + 2] = (sums[offset + 2] ?? 0) / length
    } else {
      sums[offset] = 0
      sums[offset + 1] = 1
      sums[offset + 2] = 0
    }
  }
  accumulator.generatedNormals = sums
}

function finish(accumulator: ObjAccumulator, deriveNormals = false): ParsedObjDocument {
  if (deriveNormals) derivePositionNormals(accumulator)
  const hasBounds = Number.isFinite(accumulator.minX) && Number.isFinite(accumulator.maxX)
  return {
    positions: accumulator.positions.view(),
    texcoords: accumulator.texcoords.view(),
    normals: accumulator.generatedNormals ?? accumulator.normals.view(),
    groups: [...accumulator.groups.values()].filter((group) => group.indices.length > 0).map((group) => ({
      name: group.name,
      materialName: group.materialName,
      indices: group.indices.view(),
      uvIndices: group.uvIndices.view(),
      normalIndices: group.generatedNormalIndices ?? group.normalIndices.view(),
    })),
    bounds: {
      min: {
        x: hasBounds ? accumulator.minX : 0,
        y: hasBounds ? accumulator.minY : 0,
        z: hasBounds ? accumulator.minZ : 0,
      },
      max: {
        x: hasBounds ? accumulator.maxX : 0,
        y: hasBounds ? accumulator.maxY : 0,
        z: hasBounds ? accumulator.maxZ : 0,
      },
    },
  }
}

/**
 * Synchronous parser used inside the dedicated worker.
 *
 * Normal derivation is optional because a large OBJ with no `vn` records can
 * otherwise spend most of its worker time accumulating a normal for every
 * indexed corner. The main-thread builder already has a bounded flat-material
 * fallback for that case; callers that need generated normals (and the
 * historical public default) keep `deriveNormals` enabled.
 */
export function parseObjDocument(text: string, signal?: AbortSignal, deriveNormals = true): ParsedObjDocument {
  const accumulator = newAccumulator()
  forEachSourceLine(text, (line) => {
    parseLine(line, accumulator)
    abortIfRequested(signal)
  })
  return finish(accumulator, deriveNormals)
}

function yieldToNextTask(): Promise<void> {
  // A timer yields to the browser's regular task queue and keeps rendering and
  // pointer work eligible between parser slices. MessageChannel can bypass the
  // timer queue in some browsers and otherwise produce long uninterrupted gaps.
  if (typeof setTimeout !== 'undefined') return new Promise((resolve) => { setTimeout(resolve, 0) })
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        channel.port2.close()
        resolve()
      }
      channel.port2.postMessage(undefined)
    })
  }
  return Promise.resolve()
}

/**
 * Non-blocking fallback for environments that cannot construct a module
 * Worker (SSR, jsdom, or strict CSP). Slices yield on a bounded time budget,
 * while an explicit chunkSize remains available for deterministic tests and
 * callers that need a fixed cadence.
 */
export async function parseObjDocumentAsync(text: string, options: ObjParserOptions = {}): Promise<ParsedObjDocument> {
  const accumulator = newAccumulator()
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? 16_384))
  const timeBudgetMs = Math.max(1, options.timeBudgetMs ?? 8)
  let processed = 0
  let lineStart = 0
  let sliceStarted = typeof performance === 'undefined' ? Date.now() : performance.now()
  // `indexOf` lets the engine scan for newline delimiters in native code. A
  // character-at-a-time loop is measurably expensive for 50 MB inline OBJ
  // documents and can monopolise the event loop even when slices yield.
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const atEnd = newline < 0
    const offset = atEnd ? text.length : newline
    const lineEnd = atEnd ? offset : (offset > lineStart && text.charCodeAt(offset - 1) === 13 ? offset - 1 : offset)
    if (!isBlankOrCommentRange(text, lineStart, lineEnd)) parseLine(text.slice(lineStart, lineEnd), accumulator)
    processed += 1
    abortIfRequested(options.signal)
    const elapsed = (typeof performance === 'undefined' ? Date.now() : performance.now()) - sliceStarted
    const budgetDue = processed % 128 === 0 && elapsed >= timeBudgetMs
    if (!atEnd && (processed % chunkSize === 0 || budgetDue)) {
      await yieldToNextTask()
      sliceStarted = typeof performance === 'undefined' ? Date.now() : performance.now()
    }
    if (atEnd) break
    lineStart = offset + 1
  }
  return finish(accumulator, options.deriveNormals ?? true)
}

/** Visits newline-delimited source without retaining a second full line array. */
function forEachSourceLine(text: string, visit: (line: string) => void): void {
  let lineStart = 0
  for (let offset = 0; offset <= text.length; offset += 1) {
    const atEnd = offset === text.length
    if (!atEnd && text.charCodeAt(offset) !== 10) continue
    const lineEnd = atEnd ? offset : (offset > lineStart && text.charCodeAt(offset - 1) === 13 ? offset - 1 : offset)
    visit(text.slice(lineStart, lineEnd))
    lineStart = offset + 1
  }
}
