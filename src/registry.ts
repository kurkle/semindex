import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { FORMAT_VERSION } from './constants.js'
import { writeAtomic } from './store.js'

export interface RepoEntry {
  /** Working tree roots seen for this repository; gc reads their lockfiles. */
  roots: string[]
  /** Indexed with `semindex index` (or added to a group): the hook acts in every worktree of it. */
  indexed?: boolean
}

/** Git common dir -> entry. */
export type Repos = Record<string, RepoEntry>

/**
 * The repositories this cache knows, keyed by git common dir so that every worktree of a repository shares
 * one entry: which ones opted in to the hook, and which working trees gc keeps dependency versions for.
 *
 *   <cache>/v<format>/repos.json
 *
 * Read from disk on every call, so a server and an in-process command see each other's changes.
 */
export class Registry {
  private readonly path: string
  /** The dependency registry this file replaced: { repos: { commonDir: roots[] } }. */
  private readonly legacyPath: string

  constructor(cacheDir: string) {
    const root = join(cacheDir, `v${FORMAT_VERSION}`)
    this.path = join(root, 'repos.json')
    this.legacyPath = join(root, 'deps', 'repos.json')
  }

  read(): Repos {
    try {
      return (JSON.parse(readFileSync(this.path, 'utf8')) as { repos: Repos }).repos
    } catch {}
    try {
      const legacy = JSON.parse(readFileSync(this.legacyPath, 'utf8')) as { repos: Record<string, string[]> }
      return Object.fromEntries(Object.entries(legacy.repos).map(([k, roots]) => [k, { roots }]))
    } catch {
      return {}
    }
  }

  write(repos: Repos): void {
    writeAtomic(this.path, JSON.stringify({ repos }, null, 1))
    if (existsSync(this.legacyPath)) rmSync(this.legacyPath, { force: true })
  }

  /** Remembers a working tree of a repository; with `indexed`, also opts the repository in to the hook. */
  add(commonDir: string, root: string, opts: { indexed?: boolean } = {}): void {
    const repos = this.read()
    const entry = repos[commonDir]
    const indexed = opts.indexed || entry?.indexed
    if (entry?.roots.includes(root) && entry.indexed === indexed) return
    const roots = [...new Set([...(entry?.roots ?? []), root])].sort()
    repos[commonDir] = indexed ? { roots, indexed: true } : { roots }
    this.write(repos)
  }

  isIndexed(commonDir: string): boolean {
    return this.read()[commonDir]?.indexed === true
  }

  /** Opts a repository out of the hook; returns false when it was not opted in. Cached data stays until gc. */
  forget(commonDir: string): boolean {
    const repos = this.read()
    const entry = repos[commonDir]
    if (!entry?.indexed) return false
    repos[commonDir] = { roots: entry.roots }
    this.write(repos)
    return true
  }
}
