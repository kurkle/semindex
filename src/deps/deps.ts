import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { Bm25, reciprocalRankFusion, tokenize } from '../bm25.js'
import {
  DEP_FETCH_CONCURRENCY,
  DEP_FETCH_TIMEOUT_MS,
  DEP_FILE_MAX_BYTES,
  DEP_TARBALL_MAX_BYTES,
  DEP_UNPACKED_MAX_BYTES,
  RRF_K,
} from '../constants.js'
import type { Embedder } from '../embed.js'
import { type RepoInfo, showFile, worktreeRoots } from '../git.js'
import { type Fetcher, fetchTarball } from './fetch.js'
import { type LockedDep, lockedDeps, typedModules } from './lockfile.js'
import { indexPackage, keepFile, type PackageIndex } from './package.js'
import { DepStore, namespaceKey, registryOf } from './store.js'
import { readTarball } from './tar.js'
import { type ApiDiff, type BumpedPackage, diffApi, type Impact, rankImpact, type UsingFunction } from './upgrade.js'

const DIMS = 768

export interface DepsStats {
  root: string
  /** Direct dependencies in the lockfile (after a --package filter). */
  packages: number
  /** Namespaces found in the cache, and parsed from a fetched tarball this run. */
  cached: number
  parsed: number
  chunks: number
  embedded: number
  reusedVectors: number
  /** Namespaces without vectors after this run. */
  missingVectors: number
  noTypes: { name: string; version: string; typesFrom: string | null }[]
  skipped: { name: string; version: string; reason: string }[]
  seconds: number
}

export interface DepHit {
  package: string
  version: string
  path: string
  line: number
  name: string
  kind: string
  cosine: number
  text: string
}

export interface PackageChange {
  name: string
  from: string | null
  to: string | null
  types?: { before: string; after: string }
  added?: number
  removed?: string[]
  changed?: number
  mentioned?: string[]
  error?: string
}

export interface UpgradeReport {
  base: string
  changes: PackageChange[]
  /** Production functions checked for uses of the bumped packages. */
  functions: number
  impacts: Impact[]
}

interface Loaded {
  dep: LockedDep
  key: string
  index: PackageIndex
}

async function inPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

function dot(a: Float32Array, b: Float32Array, offset: number): number {
  let s = 0
  for (let i = 0; i < b.length; i++) s += (a[offset + i] as number) * (b[i] as number)
  return s
}

/**
 * The index of a repository's locked direct dependencies. Each package version is parsed once from its
 * registry tarball into a namespace of the shared cache; embedding is a separate step that only search needs.
 */
export class Deps {
  private readonly indexes = new Map<string, PackageIndex>()
  private readonly vectors = new Map<string, Float32Array>()
  private readonly inflight = new Map<string, Promise<{ index: PackageIndex; parsed: boolean }>>()
  private bm25: { signature: string; bm25: Bm25 } | null = null

  constructor(
    readonly store: DepStore,
    private readonly embedder: () => Promise<Embedder>,
    private readonly log: (msg: string) => void = () => {},
    private readonly fetcher: Fetcher = fetch
  ) {}

  /** The direct dependencies the working tree's lockfile pins, or the lockfile at commit `rev`. */
  locked(root: string, rev?: string): LockedDep[] {
    const read = (p: string) => {
      if (rev) return showFile(root, rev, p)
      const abs = join(root, p)
      return existsSync(abs) ? readFileSync(abs, 'utf8') : null
    }
    const pkg = read('package.json')
    const lock = read('package-lock.json')
    const where = rev ? `at ${rev}` : `in ${root}`
    if (!pkg) throw new Error(`no package.json ${where}`)
    if (!lock) throw new Error(`no package-lock.json ${where}; dependency indexing reads npm lockfiles`)
    return lockedDeps(pkg, lock)
  }

  /** A package version's index: from memory, from the cache, or parsed from its verified tarball. */
  ensure(dep: LockedDep): Promise<{ index: PackageIndex; parsed: boolean }> {
    const key = namespaceKey(dep)
    const mem = this.indexes.get(key)
    if (mem) return Promise.resolve({ index: mem, parsed: false })
    const stored = this.store.readIndex(key)
    if (stored) {
      this.indexes.set(key, stored)
      return Promise.resolve({ index: stored, parsed: false })
    }
    const running = this.inflight.get(key)
    if (running) return running
    const p = this.parse(dep, key).finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async parse(dep: LockedDep, key: string): Promise<{ index: PackageIndex; parsed: boolean }> {
    const what = `${dep.name}@${dep.version}`
    if (!dep.resolved) throw new Error(`${what}: not from a registry (link, workspace, git or file dependency)`)
    const gz = await fetchTarball(
      dep.resolved,
      dep.integrity,
      what,
      { maxBytes: DEP_TARBALL_MAX_BYTES, timeoutMs: DEP_FETCH_TIMEOUT_MS },
      this.fetcher
    )
    const files = readTarball(gz, keepFile, { maxBytes: DEP_UNPACKED_MAX_BYTES, maxFileBytes: DEP_FILE_MAX_BYTES })
    const index = indexPackage(
      { name: dep.name, version: dep.version, registry: registryOf(dep.resolved), integrity: dep.integrity ?? '' },
      files
    )
    this.store.writeIndex(key, index)
    this.indexes.set(key, index)
    return { index, parsed: true }
  }

  /** Parses whatever the cache lacks for these dependencies; failures are reported, not thrown. */
  private async loadAll(deps: LockedDep[], stats: DepsStats): Promise<Loaded[]> {
    const loaded: Loaded[] = []
    await inPool(deps, DEP_FETCH_CONCURRENCY, async (dep) => {
      try {
        const r = await this.ensure(dep)
        if (r.parsed) stats.parsed++
        else stats.cached++
        loaded.push({ dep, key: namespaceKey(dep), index: r.index })
      } catch (e) {
        stats.skipped.push({ name: dep.name, version: dep.version, reason: e instanceof Error ? e.message : String(e) })
      }
    })
    return loaded.sort((a, b) => a.dep.name.localeCompare(b.dep.name))
  }

  private vectorsOf(key: string): Float32Array | null {
    const mem = this.vectors.get(key)
    if (mem) return mem
    const rows = this.store.readVectors(key, DIMS)
    if (!rows) return null
    const flat = new Float32Array(rows.length * DIMS)
    rows.forEach((v, i) => {
      flat.set(v, i * DIMS)
    })
    this.vectors.set(key, flat)
    return flat
  }

  /** Embeds the chunks of packages that have no vectors yet, reusing vectors by chunk text across versions. */
  private async embed(loaded: Loaded[], stats: DepsStats): Promise<void> {
    const todo = loaded.filter((l) => l.index.chunks.length > 0 && !this.vectorsOf(l.key))
    if (todo.length === 0) return
    const embedder = await this.embedder()
    const total = todo.reduce((s, l) => s + l.index.chunks.length, 0)
    let done = 0
    let lastLog = Date.now()
    for (const l of todo) {
      const known = this.store.vectorsOfOtherVersions(l.index.name, l.key, DIMS)
      const chunks = l.index.chunks
      const pending = [...new Map(chunks.filter((c) => !known.has(c.textHash)).map((c) => [c.textHash, c])).values()]
      stats.reusedVectors += chunks.length - pending.length
      const BATCH = 256
      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH)
        const texts = batch.map((c) => (c.kind === 'doc' ? `${c.name}\n\n${c.text}` : c.text))
        const vecs = await embedder.embed(texts, { firstPart: true })
        batch.forEach((c, j) => {
          const v = vecs[j]?.[0]
          if (v) known.set(c.textHash, v)
        })
        stats.embedded += batch.length
        done += batch.length
        if (Date.now() - lastLog > 5000) {
          this.log(`semindex: embedded ${done}/${total} dependency chunks (${l.index.name}@${l.index.version})`)
          lastLog = Date.now()
        }
      }
      const flat = new Float32Array(chunks.length * DIMS)
      const rows = chunks.map((c, i) => {
        const v = known.get(c.textHash) ?? new Float32Array(DIMS)
        flat.set(v, i * DIMS)
        return v
      })
      this.store.writeVectors(l.key, rows)
      this.vectors.set(l.key, flat)
      done += chunks.length - pending.length
    }
  }

  private select(root: string, packages?: string[]): LockedDep[] {
    const all = this.locked(root)
    if (!packages?.length) return all
    const unknown = packages.filter((p) => !all.some((d) => d.name === p))
    if (unknown.length) throw new Error(`not a direct dependency in the lockfile: ${unknown.join(', ')}`)
    return all.filter((d) => packages.includes(d.name))
  }

  /** Parses (and with `embed`, embeds) the repository's locked direct dependencies; registers it for gc. */
  async build(repo: RepoInfo, opts: { embed?: boolean; packages?: string[] } = {}): Promise<DepsStats> {
    return (await this.prepare(repo, opts)).stats
  }

  private async prepare(
    repo: RepoInfo,
    opts: { embed?: boolean; packages?: string[] }
  ): Promise<{ stats: DepsStats; loaded: Loaded[] }> {
    const t0 = performance.now()
    const deps = this.select(repo.root, opts.packages)
    this.store.register(repo.commonDir, repo.root)
    const stats: DepsStats = {
      root: repo.root,
      packages: deps.length,
      cached: 0,
      parsed: 0,
      chunks: 0,
      embedded: 0,
      reusedVectors: 0,
      missingVectors: 0,
      noTypes: [],
      skipped: [],
      seconds: 0,
    }
    const loaded = await this.loadAll(deps, stats)
    if (opts.embed) await this.embed(loaded, stats)
    const names = new Set(this.locked(repo.root).map((d) => d.name))
    for (const l of loaded) {
      stats.chunks += l.index.chunks.length
      if (l.index.chunks.length && !this.store.hasVectors(l.key)) stats.missingVectors++
      if (l.index.types === 'none') {
        const types = `@types/${l.dep.name.startsWith('@') ? l.dep.name.slice(1).replace('/', '__') : l.dep.name}`
        stats.noTypes.push({ name: l.dep.name, version: l.dep.version, typesFrom: names.has(types) ? types : null })
      }
    }
    stats.skipped.sort((a, b) => a.name.localeCompare(b.name))
    stats.seconds = (performance.now() - t0) / 1000
    return { stats, loaded }
  }

  /**
   * Hybrid search over the chunks of the repository's locked dependency versions: BM25 and embedding cosine
   * fused by reciprocal rank. Packages without vectors are embedded first.
   */
  async search(
    repo: RepoInfo,
    text: string,
    opts: { k?: number; packages?: string[] } = {}
  ): Promise<{ hits: DepHit[]; stats: DepsStats }> {
    const { stats, loaded } = await this.prepare(repo, { embed: true, packages: opts.packages })
    const rows: { l: Loaded; i: number; vec: Float32Array }[] = []
    for (const l of loaded) {
      const vec = this.vectorsOf(l.key)
      if (vec) l.index.chunks.forEach((_, i) => rows.push({ l, i, vec }))
    }
    const signature = loaded.map((l) => l.key).join('\n')
    if (this.bm25?.signature !== signature) {
      const docs = rows.map(({ l, i }) => {
        const c = l.index.chunks[i]
        return tokenize(`${l.index.name} ${c?.path ?? ''} ${c?.name ?? ''} ${c?.text ?? ''}`)
      })
      this.bm25 = { signature, bm25: new Bm25(docs) }
    }
    const [qv] = (await (await this.embedder()).embed([text], { query: true }))[0] ?? []
    if (!qv) return { hits: [], stats }
    const cos = new Float64Array(rows.length)
    rows.forEach((r, j) => {
      cos[j] = dot(r.vec, qv, r.i * DIMS)
    })
    const kw = this.bm25.bm25.score(tokenize(text))
    const fused = reciprocalRankFusion([cos, kw], RRF_K)
    const order = rows.map((_, j) => j).sort((a, b) => (fused[b] ?? 0) - (fused[a] ?? 0))
    const hits = order.slice(0, opts.k ?? 10).map((j) => {
      const { l, i } = rows[j] as (typeof rows)[number]
      const c = l.index.chunks[i]
      return {
        package: l.index.name,
        version: l.index.version,
        path: c?.path ?? '',
        line: c?.line ?? 0,
        name: c?.name ?? '',
        kind: c?.declKind ?? '',
        cosine: cos[j] ?? 0,
        text: (c?.text ?? '').slice(0, 2000),
      }
    })
    return { hits, stats }
  }

  /**
   * Upgrade impact: the direct dependencies whose locked version differs between commit `base` and the
   * working tree, each with its API diff, and the repository's functions that use them, ranked in tiers.
   * Needs the two versions' declarations only, never embeddings.
   */
  async upgrade(
    repo: RepoInfo,
    base: string,
    code: { functions: number; using: UsingFunction[] }
  ): Promise<UpgradeReport> {
    const before = new Map(this.locked(repo.root, base).map((d) => [d.name, d]))
    const after = new Map(this.locked(repo.root).map((d) => [d.name, d]))
    const changes: PackageChange[] = []
    const bumped: BumpedPackage[] = []
    const names = [...new Set([...before.keys(), ...after.keys()])].sort()
    await inPool(names, DEP_FETCH_CONCURRENCY, async (name) => {
      const a = before.get(name)
      const b = after.get(name)
      if (a && b && a.version === b.version) return
      const change: PackageChange = { name, from: a?.version ?? null, to: b?.version ?? null }
      changes.push(change)
      if (!a || !b) return
      let diff: ApiDiff | null = null
      try {
        const [x, y] = await Promise.all([this.ensure(a), this.ensure(b)])
        diff = diffApi(x.index, y.index)
        change.types = { before: x.index.types, after: y.index.types }
        change.added = diff.added.length
        change.removed = diff.removed
        change.changed = diff.changed.length
        change.mentioned = diff.mentioned
      } catch (e) {
        change.error = e instanceof Error ? e.message : String(e)
      }
      bumped.push({ name, modules: typedModules(name, builtinModules), diff })
    })
    changes.sort((x, y) => x.name.localeCompare(y.name))
    bumped.sort((x, y) => x.name.localeCompare(y.name))
    return { base, changes, functions: code.functions, impacts: rankImpact(code.using, bumped) }
  }

  /**
   * Removes the package versions that no lockfile of a registered repository references any more. A
   * registered repository or worktree that no longer exists drops out of the registry.
   */
  gc(): { removed: string[]; kept: number; bytes: number; repos: number } {
    const reg = this.store.readRegistry()
    const keep = new Set<string>()
    const live: Record<string, string[]> = {}
    for (const commonDir of Object.keys(reg.repos)) {
      if (!existsSync(commonDir)) continue
      const roots = [...new Set([...worktreeRoots(commonDir), ...(reg.repos[commonDir] ?? [])])].filter((r) =>
        existsSync(join(r, 'package-lock.json'))
      )
      if (roots.length === 0) continue
      live[commonDir] = roots.sort()
      for (const root of roots) {
        try {
          for (const d of this.locked(root)) keep.add(namespaceKey(d))
        } catch {}
      }
    }
    this.store.writeRegistry({ repos: live })
    const r = this.store.removeExcept(keep)
    for (const key of r.removed) {
      this.indexes.delete(key)
      this.vectors.delete(key)
    }
    this.bm25 = null
    return { ...r, repos: Object.keys(live).length }
  }
}
