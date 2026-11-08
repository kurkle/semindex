import { realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { OnnxEmbedder } from './embed.js'
import { Engine, type HookFinding, type IndexStats } from './engine.js'
import { mergeBase, repoOf } from './git.js'
import { type HookInput, hookFilePath, hookOutput } from './hook.js'
import { ensureModel, MODEL } from './model.js'
import { Store } from './store.js'

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
  private readonly inflight = new Map<string, Promise<IndexStats>>()

  constructor(
    readonly cacheDir: string,
    private readonly log: (msg: string) => void = () => {}
  ) {
    const store = new Store(cacheDir, MODEL.slug)
    this.engine = new Engine(store, async () => OnnxEmbedder.load(await ensureModel(cacheDir, log)), log)
  }

  private rootOf(dir: string): string {
    const repo = repoOf(resolve(dir))
    if (!repo) throw new Error(`${dir} is not inside a git working tree`)
    return repo.root
  }

  /** One index run per working tree at a time; a second caller waits for the running one. */
  index(dir: string, opts: { embed?: boolean } = {}): Promise<IndexStats> {
    const root = this.rootOf(dir)
    const running = this.inflight.get(root)
    if (running) return running
    const p = this.engine.index(root, opts).finally(() => this.inflight.delete(root))
    this.inflight.set(root, p)
    return p
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

  async similar(file: string, line: number | undefined, k = 10) {
    const abs = realpathSync(resolve(file))
    const root = this.rootOf(dirname(abs))
    await this.index(root)
    const path = relative(root, abs)
    const target = this.engine.functionAt(root, path, line)
    if (!target) throw new Error(`no function found in ${path}${line ? ` at line ${line}` : ''}`)
    return {
      target: { path, line: target.chunk.line, name: target.chunk.name },
      matches: this.engine.nearest(root, target, k),
    }
  }

  /** Functions added or changed since the branch left `base`, with the existing functions they resemble. */
  async diff(dir: string, base: string): Promise<{ base: string; checked: number; findings: HookFinding[] }> {
    const root = this.rootOf(dir)
    await this.index(root)
    const commit = mergeBase(root, base)
    return { base: commit, ...this.engine.diffCheck(root, commit) }
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
   * The PostToolUse check. A working tree seen for the first time is loaded from the cache without embedding,
   * and whatever is missing is embedded in the background, so a hook never waits for a whole repository.
   */
  async hook(input: HookInput): Promise<string> {
    const file = hookFilePath(input)
    if (!file) return ''
    let abs: string
    try {
      abs = realpathSync(file)
    } catch {
      return ''
    }
    const repo = repoOf(dirname(abs))
    if (!repo) return ''
    const path = relative(repo.root, abs)
    if (!this.engine.hasView(repo.root) || this.engine.viewHead(repo.root) !== repo.head) {
      const stats = await this.index(repo.root, { embed: false })
      // The view was built after the edit, so compare the file with its HEAD version.
      this.engine.resetToHead(repo.root, path)
      if (stats.missingVectors > 0) {
        this.index(repo.root).catch((e: unknown) => this.log(`semindex: background index failed: ${String(e)}`))
      }
    }
    const findings = await this.engine.hookCheck(repo.root, path)
    return hookOutput(findings)
  }

  status() {
    return { cacheDir: this.cacheDir, model: MODEL.id, usage: this.engine.store.usage() }
  }
}
