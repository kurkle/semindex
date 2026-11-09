import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HookFinding } from '../src/engine.js'
import { appendEvent, eventsPath, type HookEvent, readEvents, rotatedEventsPath, runHook } from '../src/events.js'
import { repoOf } from '../src/git.js'
import { Registry } from '../src/registry.js'
import { git, makeRepo, tempDir, writeFiles } from './helpers.js'

const FINDINGS: HookFinding[] = [
  {
    path: 'src/pages/day.ts',
    line: 1,
    name: 'splitPlacesPerDay',
    matches: [
      {
        path: 'src/lib/places.ts',
        line: 1,
        name: 'distributePlacesAmongClasses',
        score: 0.91,
        sameFolder: false,
        exact: false,
      },
    ],
  },
]

const input = (file: string, tool_name = 'Write') =>
  JSON.stringify({
    session_id: 'sess-1',
    transcript_path: '/t/sess-1.jsonl',
    cwd: '/somewhere',
    hook_event_name: 'PostToolUse',
    tool_name,
    tool_input: { file_path: file },
  })

/** A repository with one code file being written, on branch `task`. */
function repoWithEdit(indexedIn?: string): { repo: string; file: string; head: string } {
  const repo = realpathSync(makeRepo({ 'src/lib/places.ts': 'export const a = 1\n' }))
  git(repo, 'checkout', '-q', '-b', 'task')
  writeFiles(repo, { 'src/pages/day.ts': 'export const b = 2\n' })
  const info = repoOf(repo)
  if (indexedIn && info) new Registry(indexedIn).add(info.commonDir, info.root, { indexed: true })
  return { repo, file: join(repo, 'src/pages/day.ts'), head: git(repo, 'rev-parse', 'HEAD').trim() }
}

const lines = (cache: string): HookEvent[] =>
  readFileSync(eventsPath(cache), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as HookEvent)

describe('hook event log', () => {
  it('logs a finding with the session, the repository and every match', async () => {
    const cache = tempDir('semindex-cache-')
    const { repo, file, head } = repoWithEdit(cache)
    const r = await runHook(input(file), cache, async () => FINDINGS)
    expect(r.stdout).toContain('splitPlacesPerDay')
    const [e] = lines(cache)
    expect(e).toEqual({
      ts: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      duration_ms: expect.any(Number),
      outcome: 'finding',
      session_id: 'sess-1',
      transcript_path: '/t/sess-1.jsonl',
      cwd: '/somewhere',
      tool_name: 'Write',
      file,
      repo: expect.any(String),
      root: repo,
      gitDir: realpathSync(join(repo, '.git')),
      branch: 'task',
      head,
      path: 'src/pages/day.ts',
      findings: FINDINGS,
    })
  })

  it('logs none when the check finds nothing, and prints nothing', async () => {
    const cache = tempDir('semindex-cache-')
    const { file } = repoWithEdit(cache)
    const r = await runHook(input(file), cache, async () => [])
    expect(r.stdout).toBe('')
    expect(lines(cache)[0]).toMatchObject({ outcome: 'none', path: 'src/pages/day.ts' })
    expect(lines(cache)[0]?.findings).toBeUndefined()
  })

  it('logs skipped with the reason, without asking the check', async () => {
    const cache = tempDir('semindex-cache-')
    const { file } = repoWithEdit()
    const check = async () => {
      throw new Error('must not be called')
    }
    await runHook(input(file, 'Read'), cache, check)
    await runHook(input(file), cache, check)
    await runHook(input(join(tempDir('semindex-plain-'), 'x.ts')), cache, check)
    const indexed = tempDir('semindex-cache-')
    const other = repoWithEdit(indexed)
    writeFiles(other.repo, { 'README.md': '# r\n', 'src/day.test.ts': 'export const t = 1\n' })
    await runHook(input(join(other.repo, 'README.md')), indexed, check)
    await runHook(input(join(other.repo, 'src/day.test.ts')), indexed, check)
    const reasons = [...lines(cache), ...lines(indexed)].map((e) => [e.outcome, e.reason])
    expect(reasons).toEqual([
      ['skipped', 'tool not handled'],
      ['skipped', 'repo not indexed'],
      ['skipped', 'file not found'],
      ['skipped', 'not a code file'],
      ['skipped', 'test file'],
    ])
    expect(lines(cache)[1]).toMatchObject({ branch: 'task', path: 'src/pages/day.ts', file })
  })

  it('logs an error with its message, for a failing check and for input that is not JSON', async () => {
    const cache = tempDir('semindex-cache-')
    const { file } = repoWithEdit(cache)
    const r = await runHook(input(file), cache, async () => {
      throw new Error('server closed the connection')
    })
    expect(r.stdout).toBe('')
    await runHook('not json', cache, async () => [])
    await runHook(input(file), cache, async () => 'text from an older server')
    const [failed, garbled, older] = lines(cache)
    expect(failed).toMatchObject({ outcome: 'error', message: 'server closed the connection', branch: 'task' })
    expect(garbled?.outcome).toBe('error')
    expect(garbled?.message).toMatch(/JSON/)
    expect(older?.message).toMatch(/another version/)
  })

  it('swallows a write error', () => {
    const cache = tempDir('semindex-cache-')
    writeFiles(cache, { 'file.txt': 'x' })
    expect(() => appendEvent(join(cache, 'file.txt'), { ts: 'x', duration_ms: 1, outcome: 'none' })).not.toThrow()
  })

  it('rotates at the size limit and reads both generations, oldest first', () => {
    const cache = tempDir('semindex-cache-')
    for (let i = 0; i < 5; i++) appendEvent(cache, { ts: String(i), duration_ms: i, outcome: 'none' }, 100)
    // Each line is 44 bytes: the third one passes 100, so the fourth starts a new file.
    expect(readFileSync(rotatedEventsPath(cache), 'utf8').trim().split('\n')).toHaveLength(3)
    expect(lines(cache).map((e) => e.ts)).toEqual(['3', '4'])
    expect(readEvents(cache).map((e) => e.ts)).toEqual(['0', '1', '2', '3', '4'])
  })
})
