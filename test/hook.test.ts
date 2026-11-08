import { describe, expect, it } from 'vitest'
import { formatFindings, hookFilePath, hookOutput } from '../src/hook.js'

describe('hookFilePath', () => {
  it('takes the file path of Edit, Write and MultiEdit calls', () => {
    for (const tool_name of ['Edit', 'Write', 'MultiEdit']) {
      expect(hookFilePath({ hook_event_name: 'PostToolUse', tool_name, tool_input: { file_path: '/r/a.ts' } })).toBe(
        '/r/a.ts'
      )
    }
  })

  it('ignores other tools and other events', () => {
    expect(
      hookFilePath({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/r/a.ts' } })
    ).toBeNull()
    expect(
      hookFilePath({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/a.ts' } })
    ).toBeNull()
    expect(hookFilePath({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {} })).toBeNull()
  })
})

describe('hookOutput', () => {
  const findings = [
    {
      path: 'src/lib/registration.ts',
      line: 120,
      name: 'groupParticipantsByClass',
      matches: [
        {
          path: 'src/lambda/lib/registration.ts',
          line: 45,
          name: 'groupRegistrationsByClass',
          score: 0.831,
          sameFolder: false,
          exact: false,
        },
        { path: 'src/lib/registration.ts', line: 300, name: 'byClass', score: 1, sameFolder: true, exact: true },
      ],
    },
  ]

  it('is empty when nothing passes, so the hook stays silent', () => {
    expect(hookOutput([])).toBe('')
  })

  it('is the PostToolUse JSON with the findings as additionalContext', () => {
    const out = JSON.parse(hookOutput(findings))
    expect(Object.keys(out)).toEqual(['hookSpecificOutput'])
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(out.hookSpecificOutput.additionalContext).toBe(formatFindings(findings))
  })

  it('lists file:line, name, score and folder, and says a score is a lead', () => {
    const text = formatFindings(findings)
    expect(text).toContain('A score is a lead, not a verdict')
    expect(text).toContain('groupParticipantsByClass (src/lib/registration.ts:120) resembles:')
    expect(text).toContain('  0.83  src/lambda/lib/registration.ts:45  groupRegistrationsByClass  (other folder)')
    expect(text).toContain('  exact copy  src/lib/registration.ts:300  byClass  (same folder)')
  })
})
