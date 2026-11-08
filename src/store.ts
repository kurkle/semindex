import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { FORMAT_VERSION } from './constants.js'
import { EXTRACTOR_VERSION, type Extracted, type Lang } from './extract/index.js'

export function defaultCacheDir(): string {
  if (process.env.SEMINDEX_CACHE) return process.env.SEMINDEX_CACHE
  const xdg = process.env.XDG_CACHE_HOME
  return join(xdg || join(homedir(), '.cache'), 'semindex')
}

export function writeAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

/**
 * Content-addressed store. A file's chunks are kept once per (git blob id, language) and its vectors once per
 * (model, blob id, language), so every commit, branch and worktree of a repository shares them. Nothing is
 * written into the indexed repository.
 *
 *   <cache>/v<format>/chunks/e<extractor>/<ab>/<blob>.<lang>.json
 *   <cache>/v<format>/vectors/<model>/e<extractor>/<ab>/<blob>.<lang>.vec
 *
 * A .vec file is: uint32 chunk count, uint16 part count per chunk, padding to 4 bytes, then float16 rows.
 */
export class Store {
  readonly root: string
  constructor(
    readonly cacheDir: string,
    readonly modelSlug: string
  ) {
    this.root = join(cacheDir, `v${FORMAT_VERSION}`)
    mkdirSync(this.root, { recursive: true })
  }

  private chunkPath(blobId: string, lang: Lang, version = EXTRACTOR_VERSION): string {
    return join(this.root, 'chunks', `e${version}`, blobId.slice(0, 2), `${blobId}.${lang}.json`)
  }

  private vecPath(blobId: string, lang: Lang, version = EXTRACTOR_VERSION): string {
    return join(this.root, 'vectors', this.modelSlug, `e${version}`, blobId.slice(0, 2), `${blobId}.${lang}.vec`)
  }

  /**
   * Vectors of the same blob stored by older extractor versions, by chunk text hash. An extractor change that
   * leaves a chunk's text alone (a hash rule, a new field) then costs no embedding.
   */
  previousVectors(blobId: string, lang: Lang, dims: number): Map<string, Float32Array[]> {
    const found = new Map<string, Float32Array[]>()
    for (let v = EXTRACTOR_VERSION - 1; v >= 1; v--) {
      const cp = this.chunkPath(blobId, lang, v)
      const vp = this.vecPath(blobId, lang, v)
      if (!existsSync(cp) || !existsSync(vp)) continue
      const chunks = (JSON.parse(readFileSync(cp, 'utf8')) as Extracted).chunks
      const vecs = decodeVectors(readFileSync(vp), dims)
      chunks.forEach((c, i) => {
        const vec = vecs[i]
        if (vec?.length && !found.has(c.textHash)) found.set(c.textHash, vec)
      })
    }
    return found
  }

  readChunks(blobId: string, lang: Lang): Extracted | null {
    const p = this.chunkPath(blobId, lang)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as Extracted
  }

  writeChunks(blobId: string, lang: Lang, data: Extracted): void {
    writeAtomic(this.chunkPath(blobId, lang), JSON.stringify(data))
  }

  hasVectors(blobId: string, lang: Lang): boolean {
    return existsSync(this.vecPath(blobId, lang))
  }

  readVectors(blobId: string, lang: Lang, dims: number): Float32Array[][] | null {
    const p = this.vecPath(blobId, lang)
    if (!existsSync(p)) return null
    return decodeVectors(readFileSync(p), dims)
  }

  writeVectors(blobId: string, lang: Lang, vectors: Float32Array[][]): void {
    writeAtomic(this.vecPath(blobId, lang), encodeVectors(vectors))
  }

  /** Bytes used per top-level folder, for `semindex status`. */
  usage(): Record<string, number> {
    const sizes: Record<string, number> = {}
    const walk = (dir: string): number => {
      let total = 0
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        total += e.isDirectory() ? walk(p) : statSync(p).size
      }
      return total
    }
    for (const sub of ['chunks', 'vectors']) {
      const p = join(this.root, sub)
      sizes[sub] = existsSync(p) ? walk(p) : 0
    }
    return sizes
  }
}

export function encodeVectors(vectors: Float32Array[][]): Uint8Array {
  const dims = vectors.find((v) => v.length > 0)?.[0]?.length ?? 0
  const rows = vectors.reduce((s, v) => s + v.length, 0)
  const head = 4 + 2 * vectors.length
  const pad = (4 - (head % 4)) % 4
  const buf = new ArrayBuffer(head + pad + rows * dims * 2)
  const view = new DataView(buf)
  view.setUint32(0, vectors.length, true)
  vectors.forEach((v, i) => {
    view.setUint16(4 + 2 * i, v.length, true)
  })
  const data = new Float16Array(buf, head + pad, rows * dims)
  let o = 0
  for (const parts of vectors) {
    for (const v of parts) {
      data.set(v, o)
      o += dims
    }
  }
  return new Uint8Array(buf)
}

export function decodeVectors(bytes: Uint8Array, dims: number): Float32Array[][] {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const view = new DataView(buf)
  const count = view.getUint32(0, true)
  const head = 4 + 2 * count
  const pad = (4 - (head % 4)) % 4
  const data = new Float16Array(buf, head + pad)
  const result: Float32Array[][] = []
  let o = 0
  for (let i = 0; i < count; i++) {
    const parts = view.getUint16(4 + 2 * i, true)
    const list: Float32Array[] = []
    for (let p = 0; p < parts; p++) {
      list.push(Float32Array.from(data.subarray(o, o + dims)))
      o += dims
    }
    result.push(list)
  }
  return result
}
