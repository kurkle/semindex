import { describe, expect, it } from 'vitest'
import { absoluteDirs, parseFileSpec } from '../src/args.js'

describe('absoluteDirs', () => {
  it('resolves relative directories against the caller, not the server', () => {
    expect(absoluteDirs(['.', '../other'], '/repo/wt')).toEqual(['/repo/wt', '/repo/other'])
  })

  it('defaults to the current directory', () => {
    expect(absoluteDirs([], '/repo/wt')).toEqual(['/repo/wt'])
  })
})

describe('parseFileSpec', () => {
  it('resolves a relative file against the caller', () => {
    expect(parseFileSpec('src/a.ts', '/repo/wt')).toEqual({ file: '/repo/wt/src/a.ts' })
  })

  it('keeps the line', () => {
    expect(parseFileSpec('src/a.ts:12', '/repo/wt')).toEqual({ file: '/repo/wt/src/a.ts', line: 12 })
  })

  it('leaves an absolute file as it is', () => {
    expect(parseFileSpec('/x/b.ts', '/repo/wt')).toEqual({ file: '/x/b.ts' })
  })
})
