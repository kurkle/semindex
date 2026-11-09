import { existsSync } from 'node:fs'
import type { HookFinding, Match } from './engine.js'
import type { HookEvent, HookOutcome } from './events.js'
import { classifyPath, extract } from './extract/index.js'
import { firstParentDescendants, firstParentMerges, isAncestor, resolveCommit, showFile } from './git.js'

/**
 * What became of a flagged function, read from git now. `kept` says only that the function is still there; it
 * does not say whether the match was a false lead.
 */
export type Fate = 'removed' | 'replaced-by-match' | 'kept' | 'unknown'

export const FATES: Fate[] = ['removed', 'replaced-by-match', 'kept', 'unknown']

/** The commit a finding is judged at: the branch tip, or the commit that merged the branch into origin/main. */
export interface Landing {
  commit: string
  via: 'branch' | 'merge' | 'main'
}

export interface FindingFate {
  ts: string
  branch?: string
  session_id?: string
  path: string
  line: number
  name: string
  matches: Match[]
  fate: Fate
  /** Where the fate was read, absent for `unknown`. */
  at?: Landing
}

export interface Durations {
  runs: number
  median: number
  p95: number
}

export interface Report {
  since?: string
  runs: number
  durations: Durations
  outcomes: Partial<Record<HookOutcome, Durations>>
  /** Count of each skip reason and error message. */
  reasons: Partial<Record<'skipped' | 'error', Record<string, number>>>
  repos: { repo: string; fates: Record<Fate, number>; findings: FindingFate[] }[]
}

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0
}

export function durations(values: number[]): Durations {
  const sorted = [...values].sort((a, b) => a - b)
  return { runs: sorted.length, median: percentile(sorted, 50), p95: percentile(sorted, 95) }
}

const MAIN = 'refs/remotes/origin/main'

/**
 * Where the work of a branch went: the commit on origin/main's first-parent line that merged the branch tip
 * (or that is the tip, for a fast-forward), else the tip itself. A branch whose ref is gone is looked up by the
 * GitHub merge subject (`Merge pull request #N from owner/branch`) of a merge that contains the event's head.
 * Null when git no longer has any of these.
 */
export function landing(gitDir: string, branch: string | undefined, head: string | undefined): Landing | null {
  if (!existsSync(gitDir) || !branch) return null
  const main = resolveCommit(gitDir, MAIN)
  if (branch === 'main') {
    const tip = main ?? resolveCommit(gitDir, 'refs/heads/main')
    return tip ? { commit: tip, via: 'main' } : null
  }
  const tip = resolveCommit(gitDir, `refs/heads/${branch}`) ?? resolveCommit(gitDir, `refs/remotes/origin/${branch}`)
  if (tip) {
    if (main && isAncestor(gitDir, tip, main)) {
      const next = firstParentDescendants(gitDir, tip, main)[0]
      // A fast-forward puts the tip itself on the first-parent line; its successor there is not the merge.
      const merged = next && resolveCommit(gitDir, `${next}^1`) !== tip ? next : tip
      return { commit: merged, via: 'merge' }
    }
    return { commit: tip, via: 'branch' }
  }
  if (!main || !head || !resolveCommit(gitDir, head)) return null
  const merges = firstParentMerges(gitDir, main).filter(
    (m) => m.subject.endsWith(`/${branch}`) || m.subject.endsWith(` ${branch}`)
  )
  const merge = merges.reverse().find((m) => isAncestor(gitDir, head, m.id))
  return merge ? { commit: merge.id, via: 'merge' } : null
}

/** True when `name` occurs as an identifier in the text. */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(text)
}

/**
 * The fate of a flagged function from its file's content at the landing commit (null: the file is gone there).
 * Present by name: `kept`. Gone, and the file refers to a match's name outside that match's own definition:
 * `replaced-by-match`. Otherwise `removed`.
 */
export function classifyFate(content: string | null, finding: Pick<HookFinding, 'path' | 'name' | 'matches'>): Fate {
  if (content === null) return 'removed'
  const cls = classifyPath(finding.path)
  if (!cls) return 'unknown'
  const functions = extract(finding.path, content, cls.lang).chunks.filter((c) => c.kind === 'function')
  if (functions.some((c) => c.name === finding.name)) return 'kept'
  const lines = content.split('\n')
  for (const m of finding.matches) {
    // A match defined in the same file is no reference to it; only uses elsewhere in the file count.
    const own = m.repo || m.path !== finding.path ? [] : functions.filter((c) => c.name === m.name)
    const rest = lines.filter((_, i) => !own.some((c) => i + 1 >= c.line && i + 1 <= c.endLine)).join('\n')
    if (mentions(rest, m.name)) return 'replaced-by-match'
  }
  return 'removed'
}

/** The report over the events since `since` (ms since the epoch). */
export function buildReport(events: HookEvent[], since?: number): Report {
  const list = since === undefined ? events : events.filter((e) => Date.parse(e.ts) >= since)
  const outcomes: Report['outcomes'] = {}
  const reasons: Report['reasons'] = {}
  for (const outcome of ['finding', 'none', 'skipped', 'error'] as const) {
    const of = list.filter((e) => e.outcome === outcome)
    if (of.length) outcomes[outcome] = durations(of.map((e) => e.duration_ms))
  }
  for (const e of list) {
    if (e.outcome !== 'skipped' && e.outcome !== 'error') continue
    const why = (e.outcome === 'skipped' ? e.reason : e.message) ?? '?'
    const counts = (reasons[e.outcome] ??= {})
    counts[why] = (counts[why] ?? 0) + 1
  }
  const landings = new Map<string, Landing | null>()
  const repos = new Map<string, Report['repos'][number]>()
  for (const e of list) {
    if (e.outcome !== 'finding' || !e.findings) continue
    const key = `${e.gitDir}\0${e.branch}\0${e.head}`
    if (!landings.has(key)) landings.set(key, e.gitDir ? landing(e.gitDir, e.branch, e.head) : null)
    const at = landings.get(key) ?? null
    const name = e.repo ?? '?'
    let group = repos.get(name)
    if (!group) {
      group = { repo: name, fates: { removed: 0, 'replaced-by-match': 0, kept: 0, unknown: 0 }, findings: [] }
      repos.set(name, group)
    }
    for (const f of e.findings) {
      const fate = at && e.gitDir ? classifyFate(showFile(e.gitDir, at.commit, f.path), f) : 'unknown'
      group.fates[fate]++
      group.findings.push({
        ts: e.ts,
        branch: e.branch,
        session_id: e.session_id,
        path: f.path,
        line: f.line,
        name: f.name,
        matches: f.matches,
        fate,
        ...(fate === 'unknown' || !at ? {} : { at }),
      })
    }
  }
  return {
    ...(since === undefined ? {} : { since: new Date(since).toISOString() }),
    runs: list.length,
    durations: durations(list.map((e) => e.duration_ms)),
    outcomes,
    reasons,
    repos: [...repos.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
  }
}

function place(m: Match): string {
  return `${m.repo ? `${m.repo}/` : ''}${m.path}:${m.line} ${m.name} ${m.exact ? 'exact' : m.score.toFixed(2)}`
}

export function printReport(r: Report, path: string): void {
  console.log(`${r.runs} hook runs in ${path}${r.since ? ` since ${r.since}` : ''}`)
  if (r.runs === 0) return
  const ms = (d: Durations) => `median ${d.median} ms, p95 ${d.p95} ms`
  console.log(`  all       ${String(r.runs).padStart(5)}  ${ms(r.durations)}`)
  for (const [outcome, d] of Object.entries(r.outcomes)) {
    console.log(`  ${outcome.padEnd(8)}  ${String(d.runs).padStart(5)}  ${ms(d)}`)
    const counts = r.reasons[outcome as 'skipped' | 'error'] ?? {}
    for (const [why, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(5)}  ${why}`)
    }
  }
  for (const g of r.repos) {
    const counts = FATES.map((f) => `${g.fates[f]} ${f}`).join(', ')
    console.log(`\n${g.repo}: ${g.findings.length} flagged functions; ${counts}`)
    for (const f of g.findings) {
      const at = f.at ? `${f.at.via} ${f.at.commit.slice(0, 9)}` : 'no commit found'
      const best = f.matches[0]
      console.log(
        `  ${f.fate.padEnd(17)} ${f.ts.slice(0, 10)} ${f.branch ?? '(detached)'}  ${f.path}:${f.line} ${f.name}` +
          `${best ? `  ~ ${place(best)}` : ''}  (${at})`
      )
    }
  }
  if (r.repos.length) {
    console.log(
      '\nkept means only that the function is still there, not that the match was a false lead; removed and ' +
        'replaced-by-match say what changed, not why.'
    )
  }
}
