import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FORMAT_VERSION } from '../constants.js'
import { sha1 } from '../hash.js'
import { decodeVectors, encodeVectors, writeAtomic } from '../store.js'
import type { LockedDep } from './lockfile.js'
import { DEPS_EXTRACTOR_VERSION, type PackageIndex } from './package.js'

/** The registry a tarball URL belongs to (its host), part of a namespace key. */
export function registryOf(resolved: string): string {
  try {
    return new URL(resolved).host
  } catch {
    return 'unknown'
  }
}

/**
 * The namespace of one package version: readable name and version, then a hash of registry, name, version and
 * the lockfile's integrity, so a republished or tampered tarball under the same version never shares it.
 */
export function namespaceKey(dep: Pick<LockedDep, 'name' | 'version' | 'resolved' | 'integrity'>): string {
  const registry = dep.resolved ? registryOf(dep.resolved) : 'unknown'
  const h = sha1(`${registry}\n${dep.name}\n${dep.version}\n${dep.integrity ?? ''}`).slice(0, 12)
  return `${dep.name.replace('/', '+')}@${dep.version}-${h}`
}

const nameOfKey = (key: string): string => key.slice(0, key.lastIndexOf('@', key.lastIndexOf('-'))).replace('+', '/')

/**
 * The dependency cache, shared by every repository and worktree on the machine:
 *
 *   <cache>/v<format>/deps/d<extractor>/<name>@<version>-<hash>.json     declarations, docs, API hashes
 *   <cache>/v<format>/deps/vectors/<model>/d<extractor>/<key>.vec       one vector per chunk, float16
 */
export class DepStore {
  readonly root: string
  constructor(
    cacheDir: string,
    readonly modelSlug: string
  ) {
    this.root = join(cacheDir, `v${FORMAT_VERSION}`, 'deps')
    mkdirSync(this.root, { recursive: true })
  }

  private indexDir(version = DEPS_EXTRACTOR_VERSION): string {
    return join(this.root, `d${version}`)
  }

  private vecDir(version = DEPS_EXTRACTOR_VERSION): string {
    return join(this.root, 'vectors', this.modelSlug, `d${version}`)
  }

  readIndex(key: string): PackageIndex | null {
    const p = join(this.indexDir(), `${key}.json`)
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as PackageIndex) : null
  }

  writeIndex(key: string, index: PackageIndex): void {
    writeAtomic(join(this.indexDir(), `${key}.json`), JSON.stringify(index))
  }

  hasVectors(key: string): boolean {
    return existsSync(join(this.vecDir(), `${key}.vec`))
  }

  readVectors(key: string, dims: number): Float32Array[] | null {
    const p = join(this.vecDir(), `${key}.vec`)
    if (!existsSync(p)) return null
    return decodeVectors(readFileSync(p), dims).map((parts) => parts[0] ?? new Float32Array(0))
  }

  writeVectors(key: string, vectors: Float32Array[]): void {
    writeAtomic(join(this.vecDir(), `${key}.vec`), encodeVectors(vectors.map((v) => [v])))
  }

  /**
   * Vectors stored for other versions of a package (any extractor version), by chunk text hash: most
   * declarations do not change between versions, so an upgrade embeds only the ones that did.
   */
  vectorsOfOtherVersions(name: string, except: string, dims: number): Map<string, Float32Array> {
    const found = new Map<string, Float32Array>()
    const prefix = `${name.replace('/', '+')}@`
    for (let v = DEPS_EXTRACTOR_VERSION; v >= 1; v--) {
      const vdir = this.vecDir(v)
      if (!existsSync(vdir)) continue
      for (const f of readdirSync(vdir)) {
        if (!f.startsWith(prefix) || !f.endsWith('.vec')) continue
        const key = f.slice(0, -4)
        if (key === except || nameOfKey(key) !== name) continue
        const ip = join(this.indexDir(v), `${key}.json`)
        if (!existsSync(ip)) continue
        const chunks = (JSON.parse(readFileSync(ip, 'utf8')) as PackageIndex).chunks
        const vecs = decodeVectors(readFileSync(join(vdir, f)), dims)
        chunks.forEach((c, i) => {
          const vec = vecs[i]?.[0]
          if (vec?.length && !found.has(c.textHash)) found.set(c.textHash, vec)
        })
      }
    }
    return found
  }

  /** Every namespace key in the cache, any extractor version, with the files that hold it. */
  namespaces(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    const add = (key: string, path: string) => out.set(key, [...(out.get(key) ?? []), path])
    for (const d of existsSync(this.root) ? readdirSync(this.root) : []) {
      if (!/^d\d+$/.test(d)) continue
      for (const f of readdirSync(join(this.root, d)))
        if (f.endsWith('.json')) add(f.slice(0, -5), join(this.root, d, f))
    }
    const vroot = join(this.root, 'vectors')
    for (const model of existsSync(vroot) ? readdirSync(vroot) : []) {
      for (const d of readdirSync(join(vroot, model))) {
        for (const f of readdirSync(join(vroot, model, d))) {
          if (f.endsWith('.vec')) add(f.slice(0, -4), join(vroot, model, d, f))
        }
      }
    }
    return out
  }

  /** Removes every namespace not in `keep`; returns the removed keys and the bytes freed. */
  removeExcept(keep: Set<string>): { removed: string[]; kept: number; bytes: number } {
    const removed: string[] = []
    let kept = 0
    let bytes = 0
    for (const [key, paths] of this.namespaces()) {
      if (keep.has(key)) {
        kept++
        continue
      }
      for (const p of paths) {
        bytes += statSync(p).size
        rmSync(p, { force: true })
      }
      removed.push(key)
    }
    return { removed: removed.sort(), kept, bytes }
  }

  /** Bytes used by declarations and docs, and by vectors. */
  usage(): { indexes: number; vectors: number } {
    let indexes = 0
    let vectors = 0
    for (const [, paths] of this.namespaces()) {
      for (const p of paths) {
        if (p.endsWith('.vec')) vectors += statSync(p).size
        else indexes += statSync(p).size
      }
    }
    return { indexes, vectors }
  }
}
