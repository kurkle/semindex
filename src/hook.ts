import type { HookFinding, Match } from './engine.js'

/** The part of a Claude Code PostToolUse hook input that the check needs. */
export interface HookInput {
  hook_event_name?: string
  tool_name?: string
  tool_input?: { file_path?: string; path?: string }
  cwd?: string
  session_id?: string
  transcript_path?: string
}

const TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

/** The file path a tool call names, if any. */
function namedPath(input: HookInput): string | null {
  const p = input.tool_input?.file_path ?? input.tool_input?.path
  return typeof p === 'string' && p ? p : null
}

/** Why the hook does nothing with this input on its face (event, tool, missing path), or null when it may act. */
export function hookInputSkip(input: HookInput): string | null {
  if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return 'not a PostToolUse event'
  if (!input.tool_name || !TOOLS.has(input.tool_name)) return 'tool not handled'
  return namedPath(input) ? null : 'no file path'
}

/** The absolute path of the file an Edit, Write or MultiEdit call wrote, or null for anything else. */
export function hookFilePath(input: HookInput): string | null {
  return hookInputSkip(input) ? null : namedPath(input)
}

/** Text of the message: one block per new function, its matches indented below it. */
export function formatFindings(findings: HookFinding[]): string {
  const lines = [
    'semindex: functions just written resemble existing ones. A score is a lead, not a verdict: read the match before reusing it or writing a copy.',
  ]
  return [...lines, ...findingLines(findings)].join('\n')
}

/** Where a match is: `path:line  name  (same folder)`, or with the repository named when it is another one. */
export function matchPlace(m: Match): string {
  if (m.repo) return `${m.repo}/${m.path}:${m.line}  ${m.name}  (other repo)`
  return `${m.path}:${m.line}  ${m.name}  (${m.sameFolder ? 'same folder' : 'other folder'})`
}

/** One block per function, its matches indented below it; shared by the hook and `semindex diff`. */
export function findingLines(findings: HookFinding[]): string[] {
  const lines: string[] = []
  for (const f of findings) {
    lines.push(`${f.name} (${f.path}:${f.line}) resembles:`)
    for (const m of f.matches) {
      const tag = m.exact ? 'exact copy' : m.score.toFixed(2)
      lines.push(`  ${tag}  ${matchPlace(m)}`)
    }
  }
  return lines
}

/**
 * The stdout of the hook: nothing when no function passes, otherwise the JSON shape Claude Code reads from a
 * PostToolUse hook that exits 0, whose additionalContext is shown to the model next to the tool result.
 */
export function hookOutput(findings: HookFinding[]): string {
  if (findings.length === 0) return ''
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: formatFindings(findings) },
  })
}
