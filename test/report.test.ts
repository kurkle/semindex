import { realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HookFinding } from '../src/engine.js'
import type { HookEvent } from '../src/events.js'
import { buildReport, classifyFate, durations } from '../src/report.js'
import { git, makeRepo, writeFiles } from './helpers.js'

const PLACES = `export function distributePlacesAmongClasses(total: number, n: number) {
  return Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0))
}
`
const COPY = `export function splitPlacesPerDay(total: number, n: number) {
  return Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0))
}
`
const USES_MATCH = `import { distributePlacesAmongClasses } from '../lib/places'

export const perDay = (total: number) => distributePlacesAmongClasses(total, 3)
`
const NEITHER = `export const perDay = (total: number) => total / 3
`

const finding: HookFinding = {
  path: 'src/pages/day.ts',
  line: 1,
  name: 'splitPlacesPerDay',
  matches: [
    {
      path: 'src/lib/places.ts',
      line: 1,
      name: 'distributePlacesAmongClasses',
      score: 0.9,
      sameFolder: false,
      exact: false,
    },
  ],
}

describe('classifyFate', () => {
  it('is kept while the function is there, by name', () => {
    expect(classifyFate(COPY, finding)).toBe('kept')
  })

  it('is replaced-by-match when the function is gone and the file refers to the match', () => {
    expect(classifyFate(USES_MATCH, finding)).toBe('replaced-by-match')
  })

  it('is removed when the function is gone and nothing refers to a match, or the file is gone', () => {
    expect(classifyFate(NEITHER, finding)).toBe('removed')
    expect(classifyFate(null, finding)).toBe('removed')
  })

  it('does not count the definition of a match in the same file as a reference to it', () => {
    const sameFile = {
      ...finding,
      matches: finding.matches.map((m) => ({ ...m, path: 'src/pages/day.ts' })),
    }
    expect(classifyFate(PLACES, sameFile)).toBe('removed')
    expect(classifyFate(`${PLACES}export const d = () => distributePlacesAmongClasses(1, 1)\n`, sameFile)).toBe(
      'replaced-by-match'
    )
  })
})

describe('durations', () => {
  it('takes the nearest-rank median and p95', () => {
    expect(durations([5, 1, 3, 2, 4])).toEqual({ runs: 5, median: 3, p95: 5 })
    expect(durations(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({ runs: 100, median: 50, p95: 95 })
    expect(durations([])).toEqual({ runs: 0, median: 0, p95: 0 })
  })
})

/** Commits `content` as src/pages/day.ts on a new branch off main. */
function branch(repo: string, name: string, ...contents: string[]): void {
  git(repo, 'checkout', '-q', '-b', name, 'main')
  for (const c of contents) {
    writeFiles(repo, { 'src/pages/day.ts': c })
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', `${name}: day`)
  }
  git(repo, 'checkout', '-q', 'main')
}

function merge(repo: string, name: string, subject: string): void {
  git(repo, 'merge', '-q', '--no-ff', '-m', subject, name)
}

describe('buildReport', () => {
  it('reads each finding at its branch tip or at the merge into origin/main, and counts outcomes', () => {
    const repo = realpathSync(makeRepo({ 'src/lib/places.ts': PLACES }))
    const head = git(repo, 'rev-parse', 'HEAD').trim()
    branch(repo, 'kept', COPY)
    branch(repo, 'reused', COPY, USES_MATCH)
    branch(repo, 'dropped', COPY, NEITHER)
    // Merged with the copy, then removed on main later: judged at the merge, so kept.
    branch(repo, 'merged', COPY)
    merge(repo, 'merged', 'Merge branch merged')
    // Merged through a pull request and deleted: found by the merge subject.
    branch(repo, 'gone-merged', USES_MATCH)
    merge(repo, 'gone-merged', 'Merge pull request #2 from kurkle/gone-merged')
    git(repo, 'branch', '-q', '-D', 'gone-merged')
    writeFiles(repo, { 'src/pages/day.ts': NEITHER })
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'drop day')
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'main')
    // Deleted without a merge: unknown.
    branch(repo, 'gone', COPY)
    git(repo, 'branch', '-q', '-D', 'gone')
    const gitDir = join(repo, '.git')
    const ev = (b: string, ts: string, extra: Partial<HookEvent> = {}): HookEvent => ({
      ts,
      duration_ms: 100,
      outcome: 'finding',
      repo: 'places',
      gitDir,
      branch: b,
      head,
      findings: [finding],
      ...extra,
    })
    const events: HookEvent[] = [
      { ts: '2026-11-01T00:00:00.000Z', duration_ms: 5, outcome: 'skipped', reason: 'repo not indexed' },
      ev('kept', '2026-11-02T00:00:00.000Z'),
      ev('reused', '2026-11-02T00:00:01.000Z'),
      ev('dropped', '2026-11-02T00:00:02.000Z'),
      ev('merged', '2026-11-02T00:00:03.000Z'),
      ev('gone-merged', '2026-11-02T00:00:04.000Z'),
      ev('gone', '2026-11-02T00:00:05.000Z'),
      ev('kept', '2026-11-02T00:00:06.000Z', { gitDir: join(repo, 'missing') }),
      { ts: '2026-11-03T00:00:00.000Z', duration_ms: 300, outcome: 'none', repo: 'places' },
      { ts: '2026-11-03T00:00:01.000Z', duration_ms: 30000, outcome: 'error', message: 'killed by SIGTERM' },
    ]
    const r = buildReport(events)
    expect(r.runs).toBe(10)
    expect(Object.fromEntries(Object.entries(r.outcomes).map(([k, d]) => [k, d.runs]))).toEqual({
      finding: 7,
      none: 1,
      skipped: 1,
      error: 1,
    })
    expect(r.reasons).toEqual({ skipped: { 'repo not indexed': 1 }, error: { 'killed by SIGTERM': 1 } })
    expect(r.repos.map((g) => g.repo)).toEqual(['places'])
    const fates = r.repos[0]?.findings.map((f) => [f.branch, f.fate, f.at?.via])
    expect(fates).toEqual([
      ['kept', 'kept', 'branch'],
      ['reused', 'replaced-by-match', 'branch'],
      ['dropped', 'removed', 'branch'],
      ['merged', 'kept', 'merge'],
      ['gone-merged', 'replaced-by-match', 'merge'],
      ['gone', 'unknown', undefined],
      ['kept', 'unknown', undefined],
    ])
    expect(r.repos[0]?.fates).toEqual({ removed: 1, 'replaced-by-match': 2, kept: 2, unknown: 2 })
    const mergedAt = r.repos[0]?.findings[3]?.at?.commit
    expect(git(repo, 'log', '-1', '--format=%s', mergedAt as string).trim()).toBe('Merge branch merged')

    const since = buildReport(events, Date.parse('2026-11-03T00:00:00.000Z'))
    expect(since.runs).toBe(2)
    expect(since.repos).toEqual([])
    rmSync(repo, { recursive: true, force: true })
  })
})
