import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { defaultConfigPath, groupPeers, readConfig } from './config.js'
import { PEER_REFRESH_MS } from './constants.js'
import { type DepHit, Deps, type DepsStats, type UpgradeReport } from './deps/deps.js'
import { DepStore } from './deps/store.js'
import { type Embedder, OnnxEmbedder } from './embed.js'
import { Engine, type HookFinding, type IndexStats, type Peer } from './engine.js'
import { mainWorktree, mergeBase, type RepoInfo, repoOf } from './git.js'
import { type HookInput, hookFilePath, hookOutput } from './hook.js'
import { ensureModel, MODEL } from './model.js'
import { Registry } from './registry.js'
import { Store } from './store.js'

/** The repository and path of the file a hook input names, or null when the hook has nothing to do. */
export function hookTarget(input: HookInput): { repo: RepoInfo; path: string } | null {
  const file = hookFilePath(input)
  if (!file) return null
  let abs: string
  try {
    abs = realpathSync(file)
  } catch {
    return null
  }
  const repo = repoOf(dirname(abs))
  return repo ? { repo, path: relative(repo.root, abs) } : null
}

/**
 * True when the hook acts on this input: the file is in a repository indexed with `semindex index` (any
 * worktree of it). Cheap enough for the client to check before it starts a server.
 */
export function hookApplies(input: HookInput, cacheDir: string): boolean {
  const target = hookTarget(input)
  return !!target && new Registry(cacheDir).isIndexed(target.repo.commonDir)
}

export interface SearchHit {
  path: string
  line: number
  name: string
  kind: string
  cosine: number
}

export interface PairRow {
  scope: string
  score: number
  a: { repo: string; path: string; line: number; name: string }
  b: { repo: string; path: string; line: number; name: string }
}

/** The operations behind the CLI, run in the resident server or in-process with --local. */
export class Service {
  readonly engine: Engine
  readonly deps: Deps
  readonly registry: Registry
  private readonly inflight = new Map<string, Promise<IndexStats>>()
  /** When each working tree's view was last built, for refreshing group members' views. */
  private readonly builtAt = new Map<string, number>()
  /** Group members' main working trees, by common dir. */
  private readonly mainRoots = new Map<string, string>()
  /** Group members whose view still lacks vectors; their embedding runs in the background. */
  private readonly unembedded = new Set<string>()
  /** Working trees to index in the background once the current request has answered, one at a time. */
  private readonly later = new Set<string>()
  private draining = false
  /** Requests that may queue background runs; the queue waits while any of them is running. */
  private active = 0

  constructor(
    readonly cacheDir: string,
    private readonly log: (msg: string) => void = () => {},
    loadEmbedder: () => Promise<Embedder> = async () => OnnxEmbedder.load(await ensureModel(cacheDir, log))
  ) {
    const store = new Store(cacheDir, MODEL.slug)
    this.engine = new Engine(store, loadEmbedder, log)
    this.registry = new Registry(cacheDir)
    this.deps = new Deps(new DepStore(cacheDir, MODEL.slug), this.registry, () => this.engine.embedder(), log)
  }

  private repoOf(dir: string): RepoInfo {
    const repo = repoOf(resolve(dir))
    if (!repo) throw new Error(`${dir} is not inside a git working tree`)
    return repo
  }

  private rootOf(dir: string): string {
    return this.repoOf(dir).root
  }

  /** One index run per working tree at a time; a second caller waits for the running one. */
  index(dir: string, opts: { embed?: boolean } = {}): Promise<IndexStats> {
    const root = this.rootOf(dir)
    const running = this.inflight.get(root)
    if (running) return running
    const p = this.engine
      .index(root, opts)
      .then((stats) => {
        this.builtAt.set(root, Date.now())
        if (opts.embed !== false) this.unembedded.delete(root)
        return stats
      })
      .finally(() => this.inflight.delete(root))
    this.inflight.set(root, p)
    return p
  }

  /** Opts a working tree's repository in to the hook (every worktree of it), as `semindex index` does. */
  register(dir: string): void {
    const repo = this.repoOf(dir)
    this.registry.add(repo.commonDir, repo.root, { indexed: true })
  }

  private background(root: string): void {
    this.later.add(root)
  }

  private async request<T>(run: () => Promise<T>): Promise<T> {
    this.active++
    try {
      return await run()
    } finally {
      this.active--
      this.startLater()
    }
  }

  /**
   * Runs the queued background index runs one after another, after the current answer is sent (setImmediate
   * runs after the reply's microtasks) and never while a hook, diff or similar request is running: listing a
   * working tree is synchronous git work, about 0.2 s even for a small repository, and would hold the request
   * up.
   */
  private startLater(): void {
    if (this.later.size === 0 || this.draining) return
    this.draining = true
    const next = (): void => {
      if (this.active > 0) {
        setTimeout(next, 20)
        return
      }
      const root = this.later.values().next().value
      if (root === undefined) {
        this.draining = false
        return
      }
      this.later.delete(root)
      this.index(root)
        .catch((e: unknown) => this.log(`semindex: background index failed: ${String(e)}`))
        .finally(() => setImmediate(next))
    }
    setImmediate(next)
  }

  /** A group member's main working tree, looked up once per server unless it disappears. */
  private mainRoot(commonDir: string): string | null {
    const known = this.mainRoots.get(commonDir)
    if (known && existsSync(known)) return known
    const root = mainWorktree(commonDir)
    if (root) this.mainRoots.set(commonDir, root)
    return root
  }

  /**
   * The views of the other members of the repository's groups, each at its main working tree's HEAD plus dirty
   * files. A member seen for the first time is loaded from the cache without embedding; what is missing is
   * embedded in the background, and a view older than PEER_REFRESH_MS is rebuilt in the background. Nothing
   * here waits for embedding. `pending` names the members whose embedding has not finished yet.
   */
  async peers(repo: RepoInfo, configPath = defaultConfigPath()): Promise<{ peers: Peer[]; pending: string[] }> {
    const peers: Peer[] = []
    const pending: string[] = []
    for (const commonDir of groupPeers(readConfig(configPath), repo.commonDir)) {
      const root = this.mainRoot(commonDir)
      if (!root) continue
      if (!this.engine.hasView(root)) {
        // Straight to the engine: a running embedding pass of this member must not hold the caller up.
        const stats = await this.engine.index(root, { embed: false })
        this.builtAt.set(root, Date.now())
        if (stats.missingVectors > 0) {
          this.unembedded.add(root)
          this.background(root)
        }
      } else if (Date.now() - (this.builtAt.get(root) ?? 0) > PEER_REFRESH_MS) {
        this.builtAt.set(root, Date.now())
        this.background(root)
      }
      const label = basename(root)
      peers.push({ root, label })
      if (this.unembedded.has(root)) pending.push(label)
    }
    return { peers, pending }
  }

  async query(dir: string, text: string, k = 10, tests = false): Promise<SearchHit[]> {
    const root = this.rootOf(dir)
    await this.index(root)
    const hits = await this.engine.search(root, text, { k, tests })
    return hits.map((h) => ({
      path: h.entry.file.path,
      line: h.entry.chunk.line,
      name: h.entry.chunk.name,
      kind: h.entry.chunk.kind,
      cosine: h.cosine,
    }))
  }

  async similar(file: string, line: number | undefined, k = 10, configPath?: string) {
    const abs = realpathSync(resolve(file))
    const repo = this.repoOf(dirname(abs))
    const root = repo.root
    await this.index(root)
    const path = relative(root, abs)
    const target = this.engine.functionAt(root, path, line)
    if (!target) throw new Error(`no function found in ${path}${line ? ` at line ${line}` : ''}`)
    return this.request(async () => {
      const { peers, pending } = await this.peers(repo, configPath)
      return {
        target: { path, line: target.chunk.line, name: target.chunk.name },
        matches: this.engine.nearest(root, target, k, peers),
        pending,
      }
    })
  }

  /**
   * Functions added or changed since the branch left `base`, with the existing functions they resemble in the
   * repository and in the other members of its groups.
   */
  async diff(
    dir: string,
    base: string,
    configPath?: string
  ): Promise<{ base: string; checked: number; findings: HookFinding[]; pending: string[] }> {
    const repo = this.repoOf(dir)
    await this.index(repo.root)
    const commit = mergeBase(repo.root, base)
    return this.request(async () => {
      const { peers, pending } = await this.peers(repo, configPath)
      return { base: commit, ...this.engine.diffCheck(repo.root, commit, peers), pending }
    })
  }

  async pairs(dirs: string[], threshold?: number): Promise<{ pairs: PairRow[]; exact: PairRow[]; functions: number }> {
    const roots = [...new Set(dirs.map((d) => this.rootOf(d)))]
    for (const r of roots) await this.index(r)
    const res = this.engine.pairs(roots, threshold)
    const side = (i: number) => {
      const it = res.items[i]
      return { repo: it?.repo ?? '', path: it?.path ?? '', line: it?.line ?? 0, name: it?.name ?? '' }
    }
    const rows = (list: typeof res.pairs): PairRow[] =>
      list.map((p) => ({ scope: p.scope, score: p.score, a: side(p.a), b: side(p.b) }))
    return { pairs: rows(res.pairs), exact: rows(res.exact), functions: res.items.length }
  }

  /**
   * The PostToolUse check, only in a repository indexed with `semindex index`. A working tree seen for the
   * first time is loaded from the cache without embedding, and whatever is missing is embedded in the
   * background, so a hook never waits for a whole repository. The other members of the repository's groups
   * are searched too, loaded the same way.
   */
  async hook(input: HookInput, configPath?: string): Promise<string> {
    const target = hookTarget(input)
    if (!target || !this.registry.isIndexed(target.repo.commonDir)) return ''
    const { repo, path } = target
    return this.request(async () => {
      if (!this.engine.hasView(repo.root) || this.engine.viewHead(repo.root) !== repo.head) {
        const stats = await this.index(repo.root, { embed: false })
        // The view was built after the edit, so compare the file with its HEAD version.
        this.engine.resetToHead(repo.root, path)
        if (stats.missingVectors > 0) this.background(repo.root)
      }
      const { peers } = await this.peers(repo, configPath)
      return hookOutput(await this.engine.hookCheck(repo.root, path, peers))
    })
  }

  /** Parses the locked direct dependencies of a working tree, and with `embed` embeds them. */
  indexDeps(dir: string, opts: { embed?: boolean; packages?: string[] } = {}): Promise<DepsStats> {
    return this.deps.build(this.repoOf(dir), opts)
  }

  queryDeps(dir: string, text: string, k = 10, packages?: string[]): Promise<{ hits: DepHit[]; stats: DepsStats }> {
    return this.deps.search(this.repoOf(dir), text, { k, packages })
  }

  /**
   * Upgrade impact since the branch left `base`: the repository's own code is parsed (no embedding) for the
   * package bindings each function uses, and compared with the API diff of every bumped dependency.
   */
  async upgrade(dir: string, base: string): Promise<UpgradeReport> {
    const repo = this.repoOf(dir)
    // Straight to the engine, not through `index`: a running embedding pass must not hold this up.
    await this.engine.index(repo.root, { embed: false })
    const commit = mergeBase(repo.root, base)
    return this.deps.upgrade(repo, commit, this.engine.packageUses(repo.root))
  }

  gc() {
    return this.deps.gc()
  }

  /** True while an index run or a background dependency embedding is going; the server stays up for it. */
  busy(): boolean {
    return this.inflight.size > 0 || this.later.size > 0 || this.draining || this.deps.embeddingRunning()
  }

  status() {
    return {
      cacheDir: this.cacheDir,
      model: MODEL.id,
      usage: { ...this.engine.store.usage(), dependencies: this.deps.store.usage() },
    }
  }
}
