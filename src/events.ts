import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { EVENTS_MAX_BYTES } from './constants.js'
import type { HookFinding } from './engine.js'
import { currentBranch } from './git.js'
import { type HookInput, hookOutput } from './hook.js'
import { hookPlan } from './service.js'

export type HookOutcome = 'finding' | 'none' | 'skipped' | 'error'

/** One line of `<cache>/events.jsonl`: one `semindex hook` run. Absent fields were not known for that run. */
export interface HookEvent {
  ts: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  /** Name of the repository: the folder that holds its git common dir. */
  repo?: string
  /** The working tree root the file is in. */
  root?: string
  /** The git common dir, shared by every worktree, so the report can still read git after a worktree is gone. */
  gitDir?: string
  branch?: string
  head?: string
  /** The file as the tool call named it. */
  file?: string
  /** The file relative to the working tree root. */
  path?: string
  tool_name?: string
  duration_ms: number
  outcome: HookOutcome
  /** Why a `skipped` run did nothing. */
  reason?: string
  /** What failed in an `error` run. */
  message?: string
  /** The functions the message named, for a `finding` run. */
  findings?: HookFinding[]
}

export function eventsPath(cacheDir: string): string {
  return join(cacheDir, 'events.jsonl')
}

/** The file events.jsonl is renamed to when it reaches EVENTS_MAX_BYTES; one generation is kept. */
export function rotatedEventsPath(cacheDir: string): string {
  return join(cacheDir, 'events.1.jsonl')
}

/** Appends one event. Never throws: the log must not get in the way of the hook. */
export function appendEvent(cacheDir: string, event: HookEvent, maxBytes = EVENTS_MAX_BYTES): void {
  try {
    const path = eventsPath(cacheDir)
    mkdirSync(cacheDir, { recursive: true })
    if (existsSync(path) && statSync(path).size >= maxBytes) renameSync(path, rotatedEventsPath(cacheDir))
    appendFileSync(path, `${JSON.stringify(event)}\n`)
  } catch {}
}

/** The events of both generations, oldest first. Lines that do not parse are left out. */
export function readEvents(cacheDir: string): HookEvent[] {
  const events: HookEvent[] = []
  for (const path of [rotatedEventsPath(cacheDir), eventsPath(cacheDir)]) {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        events.push(JSON.parse(line) as HookEvent)
      } catch {}
    }
  }
  return events
}

/**
 * One `semindex hook` run: parses the hook input, asks `check` for the findings when the hook acts on the file,
 * and appends the run's event. Returns the stdout for Claude Code. Never throws. `onStart` gets the event while
 * it is being filled in, so that a run killed before it ends can still log what it knew.
 */
export async function runHook(
  raw: string,
  cacheDir: string,
  check: (input: HookInput) => Promise<unknown>,
  onStart: (event: HookEvent, started: number) => void = () => {}
): Promise<{ stdout: string; event: HookEvent }> {
  const started = performance.now()
  const event: HookEvent = { ts: new Date().toISOString(), duration_ms: 0, outcome: 'error' }
  onStart(event, started)
  let stdout = ''
  try {
    const input = JSON.parse(raw) as HookInput
    Object.assign(event, {
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      cwd: input.cwd,
      tool_name: input.tool_name,
      file: input.tool_input?.file_path ?? input.tool_input?.path,
    })
    const plan = hookPlan(input, cacheDir)
    if (plan.repo) {
      Object.assign(event, {
        repo: basename(dirname(plan.repo.commonDir)),
        root: plan.repo.root,
        gitDir: plan.repo.commonDir,
        branch: currentBranch(plan.repo.root) ?? undefined,
        head: plan.repo.head ?? undefined,
        path: plan.path,
      })
    }
    if (plan.skipped !== undefined) {
      Object.assign(event, { outcome: 'skipped', reason: plan.skipped })
    } else {
      const findings = await check(input)
      if (!Array.isArray(findings)) throw new Error('the running server is another version; `semindex stop` ends it')
      stdout = hookOutput(findings)
      Object.assign(event, findings.length ? { outcome: 'finding', findings } : { outcome: 'none' })
    }
  } catch (e) {
    Object.assign(event, { outcome: 'error', message: e instanceof Error ? e.message : String(e) })
  }
  event.duration_ms = Math.round(performance.now() - started)
  appendEvent(cacheDir, event)
  return { stdout, event }
}
