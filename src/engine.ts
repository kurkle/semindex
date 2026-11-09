import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, relative } from 'node:path'
import { Bm25, reciprocalRankFusion, tokenize } from './bm25.js'
import {
  HOOK_MAX_FUNCTIONS,
  HOOK_MAX_MATCHES,
  HOOK_MIN_TOKENS,
  HOOK_OTHER_FOLDER_THRESHOLD,
  HOOK_SAME_FOLDER_THRESHOLD,
  RRF_K,
} from './constants.js'
import type { Embedder } from './embed.js'
import { type Chunk, classifyPath, type Extracted, extract, type Lang } from './extract/index.js'
import { listTree, type RepoInfo, readBlobs, repoOf, workingChanges } from './git.js'
import { gitBlobId } from './hash.js'
import { callsEither, findPairs, type PairItem } from './pairs.js'
import type { Store } from './store.js'

export interface FileRef {
  path: string
  blobId: string
  lang: Lang
  test: boolean
}

interface Blob {
  extracted: Extracted
  /** Per chunk, one vector per part; null until embedded. */
  vectors: Float32Array[][] | null
}

export interface Entry {
  file: FileRef
  chunk: Chunk
  vectors: Float32Array[]
}

interface View {
  repo: RepoInfo
  files: Map<string, FileRef>
  entries: Entry[] | null
  bm25: Bm25 | null
}

export interface IndexStats {
  root: string
  files: number
  chunks: number
  parsed: number
  embedded: number
  reusedVectors: number
  missingVectors: number
  seconds: number
}

export interface Match {
  /** The group member the match is in (basename of its main working tree); absent for the repository itself. */
  repo?: string
  path: string
  line: number
  name: string
  score: number
  sameFolder: boolean
  exact: boolean
}

/** Another member of a group: the root of its loaded view and the name its matches are reported under. */
export interface Peer {
  root: string
  label: string
}

export interface HookFinding {
  path: string
  line: number
  name: string
  matches: Match[]
}

const blobKey = (id: string, lang: Lang): string => `${id}.${lang}`

/** The indexable files of a working tree: HEAD's blobs, with dirty and untracked files read from disk. */
function listFiles(root: string): { files: Map<string, FileRef>; dirty: Map<string, string> } {
  const files = new Map<string, FileRef>()
  for (const e of listTree(root)) {
    const cls = classifyPath(e.path)
    if (cls) files.set(e.path, { path: e.path, blobId: e.blobId, lang: cls.lang, test: cls.test })
  }
  const dirty = new Map<string, string>()
  const changes = workingChanges(root)
  for (const p of changes.deleted) files.delete(p)
  for (const p of changes.changed) {
    const cls = classifyPath(p)
    const content = cls ? readRegularFile(`${root}/${p}`) : null
    if (!cls || !content) continue
    const blobId = gitBlobId(content)
    files.set(p, { path: p, blobId, lang: cls.lang, test: cls.test })
    dirty.set(blobId, content.toString('utf8'))
  }
  return { files, dirty }
}

function readRegularFile(path: string): Buffer | null {
  try {
    return statSync(path).isFile() ? readFileSync(path) : null
  } catch {
    return null
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number)
  return s
}

/**
 * Whether two functions read the same once `export`, the name in their declaration (`function name`, `const
 * name =`, `name()`) and the whitespace are taken out. The same word in the body stays.
 */
function sameTextButName(a: Chunk, b: Chunk): boolean {
  const bare = (c: Chunk) => {
    const name = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const head = new RegExp(`^((?:async\\s+)?function\\*?\\s+|(?:const|let|var)\\s+)?${name}(?![\\w$])`)
    return c.text
      .replace(/^export\s+(default\s+)?/, '')
      .replace(head, '$1')
      .replace(/\s+/g, '')
  }
  return bare(a) === bare(b)
}

/**
 * The index of one or more working trees, held in memory over a content-addressed store. Blobs are shared
 * across worktrees of a repository (and across repositories with identical files).
 */
export class Engine {
  private readonly blobs = new Map<string, Blob>()
  private readonly views = new Map<string, View>()
  private embedderPromise: Promise<Embedder> | null = null

  constructor(
    readonly store: Store,
    private readonly loadEmbedder: () => Promise<Embedder>,
    private readonly log: (msg: string) => void = () => {}
  ) {}

  embedder(): Promise<Embedder> {
    this.embedderPromise ??= this.loadEmbedder()
    return this.embedderPromise
  }

  private blob(ref: FileRef): Blob | null {
    const key = blobKey(ref.blobId, ref.lang)
    const mem = this.blobs.get(key)
    if (mem) return mem
    const extracted = this.store.readChunks(ref.blobId, ref.lang)
    if (!extracted) return null
    const vectors = extracted.chunks.length ? this.store.readVectors(ref.blobId, ref.lang, 768) : []
    const b = { extracted, vectors }
    this.blobs.set(key, b)
    return b
  }

  private parse(ref: FileRef, content: string): Blob {
    const extracted = extract(ref.path, content, ref.lang)
    this.store.writeChunks(ref.blobId, ref.lang, extracted)
    const b: Blob = { extracted, vectors: extracted.chunks.length ? null : [] }
    this.blobs.set(blobKey(ref.blobId, ref.lang), b)
    return b
  }

  /** Vectors already known by text hash, so unchanged functions of an edited file are not embedded again. */
  private knownVectors(files: Iterable<FileRef>): Map<string, Float32Array[]> {
    const known = new Map<string, Float32Array[]>()
    for (const ref of files) {
      const b = this.blobs.get(blobKey(ref.blobId, ref.lang))
      if (!b?.vectors) continue
      b.extracted.chunks.forEach((c, i) => {
        const v = b.vectors?.[i]
        if (v?.length) known.set(c.textHash, v)
      })
    }
    return known
  }

  private async embedBlobs(refs: FileRef[], known: Map<string, Float32Array[]>, stats: IndexStats): Promise<void> {
    const todo: { ref: FileRef; blob: Blob }[] = []
    for (const ref of refs) {
      const b = this.blobs.get(blobKey(ref.blobId, ref.lang))
      if (b && b.vectors === null) todo.push({ ref, blob: b })
    }
    if (todo.length === 0) return
    const embedder = await this.embedder()
    const BATCH = 64
    let pending: { text: string; hash: string }[] = []
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return
      const vecs = await embedder.embed(pending.map((p) => p.text))
      pending.forEach((p, i) => {
        known.set(p.hash, vecs[i] ?? [])
      })
      stats.embedded += pending.length
      pending = []
    }
    const total = todo.reduce((s, t) => s + t.blob.extracted.chunks.length, 0)
    let done = 0
    let lastLog = Date.now()
    for (const { ref, blob } of todo) {
      const seen = new Set<string>()
      for (const c of blob.extracted.chunks) {
        if (known.has(c.textHash)) {
          stats.reusedVectors++
          continue
        }
        if (seen.has(c.textHash)) continue
        seen.add(c.textHash)
        pending.push({ text: c.kind === 'doc' ? `${c.name}\n\n${c.text}` : c.text, hash: c.textHash })
        if (pending.length >= BATCH) await flush()
      }
      await flush()
      blob.vectors = blob.extracted.chunks.map((c) => known.get(c.textHash) ?? [])
      this.store.writeVectors(ref.blobId, ref.lang, blob.vectors)
      done += blob.extracted.chunks.length
      if (Date.now() - lastLog > 5000) {
        this.log(`semindex: embedded ${done}/${total} chunks`)
        lastLog = Date.now()
      }
    }
  }

  /**
   * Brings the view of a working tree up to date: HEAD's blobs plus the dirty files. Only blobs not yet in the
   * store are parsed, and only chunks whose text has no vector yet are embedded. With `embed: false` nothing
   * new is embedded and chunks without vectors stay out of the view.
   */
  async index(dir: string, opts: { embed?: boolean } = {}): Promise<IndexStats> {
    const t0 = performance.now()
    const repo = repoOf(dir)
    if (!repo) throw new Error(`${dir} is not inside a git working tree`)
    const { files, dirty } = listFiles(repo.root)
    const stats: IndexStats = {
      root: repo.root,
      files: files.size,
      chunks: 0,
      parsed: 0,
      embedded: 0,
      reusedVectors: 0,
      missingVectors: 0,
      seconds: 0,
    }
    const previous = this.views.get(repo.root)
    const known = this.knownVectors(previous ? previous.files.values() : [])
    const unparsed: FileRef[] = []
    for (const ref of files.values()) if (!this.blob(ref)) unparsed.push(ref)
    const fromGit = readBlobs(
      repo.root,
      unparsed.filter((r) => !dirty.has(r.blobId)).map((r) => r.blobId)
    )
    for (const ref of unparsed) {
      const content = dirty.get(ref.blobId) ?? fromGit.get(ref.blobId)?.toString('utf8')
      if (content === undefined) continue
      this.parse(ref, content)
      stats.parsed++
      for (const [k, v] of this.store.previousVectors(ref.blobId, ref.lang, 768)) known.set(k, v)
    }
    for (const [k, v] of this.knownVectors(files.values())) known.set(k, v)
    if (opts.embed !== false) await this.embedBlobs([...files.values()], known, stats)
    for (const ref of files.values()) {
      const b = this.blobs.get(blobKey(ref.blobId, ref.lang))
      stats.chunks += b?.extracted.chunks.length ?? 0
      if (b && b.vectors === null) stats.missingVectors += b.extracted.chunks.length
    }
    this.views.set(repo.root, { repo, files, entries: null, bm25: null })
    stats.seconds = (performance.now() - t0) / 1000
    return stats
  }

  /** Re-indexes one file of a loaded view from disk; returns the old and new chunks of that path. */
  async reindexFile(root: string, path: string): Promise<{ before: Chunk[]; after: Chunk[]; ref: FileRef } | null> {
    const view = this.views.get(root)
    const cls = classifyPath(path)
    if (!view || !cls) return null
    const old = view.files.get(path)
    const before = old ? (this.blob(old)?.extracted.chunks ?? []) : []
    const content = readFileSync(`${root}/${path}`)
    const ref: FileRef = { path, blobId: gitBlobId(content), lang: cls.lang, test: cls.test }
    if (!this.blob(ref)) this.parse(ref, content.toString('utf8'))
    const known = this.knownVectors(old ? [old] : [])
    const stats = { embedded: 0, reusedVectors: 0 } as IndexStats
    await this.embedBlobs([ref], known, stats)
    view.files.set(path, ref)
    view.entries = null
    view.bm25 = null
    return { before, after: this.blob(ref)?.extracted.chunks ?? [], ref }
  }

  /**
   * Puts a path of the view back to its HEAD version (or removes it when HEAD lacks it), so that the next
   * reindexFile reports what changed against HEAD. Used when a view is first built after the edit happened.
   */
  resetToHead(root: string, path: string): void {
    const view = this.views.get(root)
    const cls = classifyPath(path)
    if (!view || !cls) return
    const head = listTree(root, 'HEAD', path)[0]
    if (head) view.files.set(path, { path, blobId: head.blobId, lang: cls.lang, test: cls.test })
    else view.files.delete(path)
    view.entries = null
    view.bm25 = null
  }

  hasView(root: string): boolean {
    return this.views.has(root)
  }

  /** The HEAD commit the view was built at; a different HEAD means the view is stale. */
  viewHead(root: string): string | null | undefined {
    return this.views.get(root)?.repo.head
  }

  entries(root: string): Entry[] {
    const view = this.views.get(root)
    if (!view) throw new Error(`${root} is not indexed`)
    if (!view.entries) {
      const list: Entry[] = []
      for (const ref of view.files.values()) {
        const b = this.blobs.get(blobKey(ref.blobId, ref.lang))
        if (!b?.vectors) continue
        b.extracted.chunks.forEach((chunk, i) => {
          const vectors = b.vectors?.[i]
          if (vectors?.length) list.push({ file: ref, chunk, vectors })
        })
      }
      view.entries = list
    }
    return view.entries
  }

  private bm25(root: string): Bm25 {
    const view = this.views.get(root)
    if (!view) throw new Error(`${root} is not indexed`)
    view.bm25 ??= new Bm25(this.entries(root).map((e) => tokenize(`${e.file.path} ${e.chunk.name} ${e.chunk.text}`)))
    return view.bm25
  }

  /**
   * Hybrid search: embedding cosine (best part of each chunk) and BM25 fused by reciprocal rank.
   * `code` treats the text as code (no query prefix), as for `similar`.
   */
  async search(
    root: string,
    text: string,
    opts: { k?: number; code?: boolean; tests?: boolean; exclude?: (e: Entry) => boolean } = {}
  ): Promise<{ entry: Entry; cosine: number; fused: number }[]> {
    const entries = this.entries(root)
    const [qv] = (await (await this.embedder()).embed([text], { query: !opts.code }))[0] ?? []
    if (!qv) return []
    const keep = entries.map((e) => (opts.tests || !e.file.test) && !opts.exclude?.(e))
    const cos = new Float64Array(entries.length)
    entries.forEach((e, i) => {
      if (!keep[i]) return
      const parts = opts.code ? e.vectors.slice(0, 1) : e.vectors
      cos[i] = Math.max(...parts.map((v) => dot(v, qv)))
    })
    const kw = this.bm25(root).score(tokenize(text))
    entries.forEach((_, i) => {
      if (!keep[i]) kw[i] = 0
    })
    const fused = reciprocalRankFusion([cos, kw], RRF_K)
    const order = entries.map((_, i) => i).filter((i) => keep[i] && (fused[i] ?? 0) > 0)
    order.sort((a, b) => (fused[b] ?? 0) - (fused[a] ?? 0))
    return order
      .slice(0, opts.k ?? 10)
      .map((i) => ({ entry: entries[i] as Entry, cosine: cos[i] ?? 0, fused: fused[i] ?? 0 }))
  }

  /** The function at a line of a file in the view (the innermost one containing it), or the first one. */
  functionAt(root: string, path: string, line?: number): Entry | null {
    const fns = this.entries(root).filter((e) => e.file.path === path && e.chunk.kind === 'function')
    if (line === undefined) return fns[0] ?? null
    const containing = fns.filter((e) => e.chunk.line <= line && line <= e.chunk.endLine)
    containing.sort((a, b) => a.chunk.endLine - a.chunk.line - (b.chunk.endLine - b.chunk.line))
    return containing[0] ?? null
  }

  /**
   * Nearest production functions to one function, by cosine of the first parts, in its own view and in the
   * views of `peers`. Excludes the function itself (same path and name in its own view) and functions it calls
   * or that call it. A peer's function is never in the same folder. A function shorter than `HOOK_MIN_TOKENS`
   * is taken only as an exact copy, which for a short function means the same text apart from its own name and
   * whitespace: at that length an identical AST hash is shared by functions that do different jobs.
   */
  nearest(root: string, target: Entry, k: number, peers: Peer[] = []): Match[] {
    const qv = target.vectors[0]
    if (!qv) return []
    const self: PairItem = this.pairItem('', target)
    const folder = dirname(target.file.path)
    const out: Match[] = []
    for (const view of [{ root, label: '' }, ...peers]) {
      if (view.root !== root && !this.views.has(view.root)) continue
      const own = view.root === root
      for (const e of this.entries(view.root)) {
        if (e.chunk.kind !== 'function' || e.file.test) continue
        const sameAst = e.chunk.astHash === target.chunk.astHash
        const short = e.chunk.n < HOOK_MIN_TOKENS || target.chunk.n < HOOK_MIN_TOKENS
        const exact = sameAst && (!short || sameTextButName(e.chunk, target.chunk))
        if (e.chunk.n < HOOK_MIN_TOKENS && !exact) continue
        if (own && e.file.path === target.file.path && e.chunk.name === target.chunk.name) continue
        if (callsEither(self, this.pairItem('', e))) continue
        const v = e.vectors[0]
        if (!v) continue
        out.push({
          ...(own ? {} : { repo: view.label }),
          path: e.file.path,
          line: e.chunk.line,
          name: e.chunk.name,
          score: dot(v, qv),
          sameFolder: own && dirname(e.file.path) === folder,
          exact,
        })
      }
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, k)
  }

  /**
   * Existing functions at or above the hook thresholds for one function, and exact copies. A function shorter
   * than `HOOK_MIN_TOKENS` gets its exact copies only, from all functions rather than the nearest 20.
   */
  private leads(root: string, entry: Entry, peers: Peer[]): Match[] {
    if (entry.chunk.n < HOOK_MIN_TOKENS) {
      return this.nearest(root, entry, Number.POSITIVE_INFINITY, peers)
        .filter((m) => m.exact)
        .slice(0, HOOK_MAX_MATCHES)
    }
    return this.nearest(root, entry, 20, peers)
      .filter((m) => m.exact || m.score >= (m.sameFolder ? HOOK_SAME_FOLDER_THRESHOLD : HOOK_OTHER_FOLDER_THRESHOLD))
      .slice(0, HOOK_MAX_MATCHES)
  }

  /**
   * The hook check for one edited file: functions that are new or changed since the view last saw the file,
   * each with the existing functions above the same-folder or other-folder threshold, in its own view and in
   * the peers' views.
   */
  async hookCheck(root: string, path: string, peers: Peer[] = []): Promise<HookFinding[]> {
    const cls = classifyPath(path)
    if (!cls || cls.test || cls.lang === 'md' || cls.lang === 'mdx') return []
    const res = await this.reindexFile(root, path)
    if (!res) return []
    const old = new Set(res.before.map((c) => c.textHash))
    const changed = res.after.filter((c) => c.kind === 'function' && !old.has(c.textHash))
    const findings: HookFinding[] = []
    for (const c of changed) {
      const entry = this.entries(root).find((e) => e.file.path === path && e.chunk.textHash === c.textHash)
      if (!entry) continue
      const matches = this.leads(root, entry, peers)
      if (matches.length) findings.push({ path, line: c.line, name: c.name, matches })
    }
    findings.sort((a, b) => (b.matches[0]?.score ?? 0) - (a.matches[0]?.score ?? 0))
    return findings.slice(0, HOOK_MAX_FUNCTIONS)
  }

  /**
   * The check of a whole branch: every production function added or changed in the view since the commit
   * `base`, dirty files included, each with the existing functions above the hook thresholds (in the peers'
   * views too). A function is
   * compared with its own file at `base`, so one that moved to another file counts as new there.
   */
  diffCheck(root: string, base: string, peers: Peer[] = []): { checked: number; findings: HookFinding[] } {
    const view = this.views.get(root)
    if (!view) throw new Error(`${root} is not indexed`)
    const baseIds = new Map(listTree(root, base).map((e) => [e.path, e.blobId]))
    const changed = [...view.files.values()].filter(
      (r) => !r.test && r.lang !== 'md' && r.lang !== 'mdx' && baseIds.get(r.path) !== r.blobId
    )
    const baseRefs = changed.flatMap((r) => {
      const blobId = baseIds.get(r.path)
      return blobId ? [{ ...r, blobId }] : []
    })
    const unparsed = baseRefs.filter((r) => !this.blob(r))
    const contents = readBlobs(
      root,
      unparsed.map((r) => r.blobId)
    )
    for (const r of unparsed) {
      const content = contents.get(r.blobId)
      if (content) this.parse(r, content.toString('utf8'))
    }
    const key = (path: string, textHash: string) => `${path}\0${textHash}`
    const before = new Set(
      baseRefs.flatMap((r) => (this.blob(r)?.extracted.chunks ?? []).map((c) => key(r.path, c.textHash)))
    )
    const entries = new Map(this.entries(root).map((e) => [key(e.file.path, e.chunk.textHash), e]))
    let checked = 0
    const findings: HookFinding[] = []
    for (const r of changed) {
      for (const c of this.blob(r)?.extracted.chunks ?? []) {
        if (c.kind !== 'function' || before.has(key(r.path, c.textHash))) continue
        const entry = entries.get(key(r.path, c.textHash))
        if (!entry) continue
        checked++
        const matches = this.leads(root, entry, peers)
        if (matches.length) findings.push({ path: r.path, line: c.line, name: c.name, matches })
      }
    }
    findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    return { checked, findings }
  }

  /**
   * Production functions of a view with the package bindings each one uses, from the parsed chunks alone:
   * vectors are not needed, so this works on a view indexed with `embed: false`.
   */
  packageUses(root: string): {
    functions: number
    using: { path: string; line: number; name: string; uses: string[] }[]
  } {
    const view = this.views.get(root)
    if (!view) throw new Error(`${root} is not indexed`)
    let functions = 0
    const using: { path: string; line: number; name: string; uses: string[] }[] = []
    for (const ref of view.files.values()) {
      if (ref.test || ref.lang === 'md' || ref.lang === 'mdx') continue
      for (const c of this.blob(ref)?.extracted.chunks ?? []) {
        if (c.kind !== 'function') continue
        functions++
        if (c.uses?.length) using.push({ path: ref.path, line: c.line, name: c.name, uses: c.uses })
      }
    }
    return { functions, using }
  }

  pairItem(repo: string, e: Entry): PairItem {
    return {
      repo,
      path: e.file.path,
      folder: dirname(e.file.path),
      name: e.chunk.name,
      line: e.chunk.line,
      n: e.chunk.n,
      astHash: e.chunk.astHash,
      calls: e.chunk.calls,
      vec: e.vectors[0] as Float32Array,
    }
  }

  /** The pairing rule over the production functions of one or more indexed working trees. */
  pairs(roots: string[], threshold?: number) {
    const items: PairItem[] = []
    for (const root of roots) {
      const label = basename(root)
      for (const e of this.entries(root)) {
        if (e.chunk.kind === 'function' && !e.file.test && e.vectors[0]) items.push(this.pairItem(label, e))
      }
    }
    return { items, ...findPairs(items, threshold) }
  }

  rootOf(file: string): string | null {
    return repoOf(dirname(file))?.root ?? null
  }

  relativePath(root: string, file: string): string {
    return relative(root, file)
  }
}
