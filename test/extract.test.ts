import { describe, expect, it } from 'vitest'
import { classifyPath, isGeneratedContent } from '../src/extract/classify.js'
import { extractCode } from '../src/extract/code.js'
import { extract } from '../src/extract/index.js'

const SRC = `import { x } from './x'

export function totalPlaces(classes: { places: number }[]): number {
  let sum = 0
  for (const c of classes) sum += c.places
  return sum
}

export const label = (name: string) => {
  return format(name, 'label')
}

class Box {
  size(): number {
    return measure(this)
  }
  handler = () => {
    return <Panel title="x">text</Panel>
  }
}

const config = { onSave: function save() { return persist(1) } }
`

describe('extractCode', () => {
  it('finds functions, methods and arrow functions bound to a name', () => {
    const chunks = extractCode('a.tsx', SRC, 'tsx')
    expect(chunks.map((c) => [c.name, c.line])).toEqual([
      ['totalPlaces', 3],
      ['label', 9],
      ['size', 14],
      ['handler', 17],
      ['onSave', 22],
    ])
    expect(chunks[0]?.exported).toBe(true)
    expect(chunks[0]?.endLine).toBe(7)
    expect(chunks[1]?.text.startsWith('export const label')).toBe(true)
  })

  it('collects called and rendered names', () => {
    const chunks = extractCode('a.tsx', SRC, 'tsx')
    expect(chunks.find((c) => c.name === 'label')?.calls).toEqual(['format'])
    expect(chunks.find((c) => c.name === 'handler')?.calls).toEqual(['Panel'])
  })

  it('gives a renamed copy the same AST hash and a different text hash', () => {
    const a = extractCode(
      'a.ts',
      'function sum(xs: number[]) { let t = 0; for (const x of xs) t += x; return t }',
      'ts'
    )
    const b = extractCode(
      'b.ts',
      'function total(values: number[]) { let acc = 0; for (const v of values) acc += v; return acc }',
      'ts'
    )
    expect(a[0]?.astHash).toBe(b[0]?.astHash)
    expect(a[0]?.textHash).not.toBe(b[0]?.textHash)
  })

  it('ignores a JSDoc comment in the AST hash', () => {
    const a = extractCode('a.ts', '/** Adds one. */\nfunction f(x: number) { return x + 1 }', 'ts')
    const b = extractCode('a.ts', 'function g(y: number) { return y + 1 }', 'ts')
    expect(a[0]?.astHash).toBe(b[0]?.astHash)
    expect(a[0]?.n).toBe(b[0]?.n)
  })

  it('changes the AST hash when the structure changes', () => {
    const a = extractCode('a.ts', 'function f(x: number) { return x + 1 }', 'ts')
    const b = extractCode('a.ts', 'function f(x: number) { return x * 1 }', 'ts')
    expect(a[0]?.astHash).not.toBe(b[0]?.astHash)
  })

  it('ignores type annotations in the AST hash', () => {
    const a = extractCode('a.ts', 'function f(x: number): number { return x }', 'ts')
    const b = extractCode('a.ts', 'function f(x: string): string { return x }', 'ts')
    expect(a[0]?.astHash).toBe(b[0]?.astHash)
  })

  it('hashes and numbers lines the same for CRLF and LF', () => {
    const lf = extractCode('a.tsx', SRC, 'tsx')
    const crlf = extractCode('a.tsx', SRC.replace(/\n/g, '\r\n'), 'tsx')
    expect(crlf.map((c) => [c.line, c.endLine, c.astHash, c.textHash])).toEqual(
      lf.map((c) => [c.line, c.endLine, c.astHash, c.textHash])
    )
    expect(crlf[0]?.text.includes('\r')).toBe(false)
  })

  it('skips anonymous callbacks', () => {
    const chunks = extractCode('a.ts', 'items.map((x) => x + 1)\nsetTimeout(function () { run() })', 'ts')
    expect(chunks).toEqual([])
  })
})

describe('package uses', () => {
  it('records the package bindings each function refers to, namespace members resolved', () => {
    const src = `import { format as fmt, type Locale } from 'date-fns'
import * as fns from 'date-fns/locale'
import Box from '@mui/material/Box'
import { helper } from './helper'
import type ts = require('typescript')

export function label(d: Date, l: Locale): string {
  const o = { fmt: 1 }
  return fmt(d, 'P') + fns.fi.code + helper() + o.fmt
}
export const View = () => <Box sx={{ p: 1 }} />
export function kind(k: ts.SyntaxKind) {
  return k
}
function plain(n: number) {
  return n
}
`
    const chunks = extractCode('a.tsx', src, 'tsx')
    expect(Object.fromEntries(chunks.map((c) => [c.name, c.uses]))).toEqual({
      label: ['date-fns/locale:fi', 'date-fns:Locale', 'date-fns:format'],
      View: ['@mui/material/Box:*'],
      kind: ['typescript:SyntaxKind'],
      plain: undefined,
    })
  })
})

describe('classifyPath', () => {
  it('tells tests, production, docs and skipped files apart', () => {
    expect(classifyPath('src/lib/a.ts')).toEqual({ lang: 'ts', test: false })
    expect(classifyPath('src/lib/a.test.ts')?.test).toBe(true)
    expect(classifyPath('src/__mocks__/a.ts')?.test).toBe(true)
    expect(classifyPath('docs/guide.md')).toEqual({ lang: 'md', test: false })
    expect(classifyPath('src/generated/api.ts')).toBeNull()
    expect(classifyPath('types/index.d.ts')).toBeNull()
    expect(classifyPath('dist/index.js')).toBeNull()
    expect(classifyPath('vendor/lib.js')).toBeNull()
    expect(classifyPath('image.png')).toBeNull()
  })
})

describe('generated content', () => {
  it('is marked and yields no chunks', () => {
    const src = '// @generated by a tool\nexport function f() { return 1 }\n'
    expect(isGeneratedContent(src)).toBe(true)
    expect(extract('a.ts', src, 'ts')).toEqual({ generated: true, chunks: [] })
    expect(isGeneratedContent(`var a=${'1,'.repeat(400)}1\n`)).toBe(true)
    expect(isGeneratedContent(SRC)).toBe(false)
  })
})
