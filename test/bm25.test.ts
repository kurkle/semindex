import { describe, expect, it } from 'vitest'
import { Bm25, reciprocalRankFusion, tokenize } from '../src/bm25.js'

describe('tokenize', () => {
  it('splits camelCase, PascalCase and snake_case and drops short words', () => {
    expect(tokenize('getHTTPResponse start_list_published xy päivämäärä')).toEqual([
      'get',
      'http',
      'response',
      'start',
      'list',
      'published',
      'päivämäärä',
    ])
  })
})

describe('Bm25', () => {
  const docs = [
    ['start', 'list', 'published'],
    ['results', 'published', 'class'],
    ['email', 'template', 'send', 'email'],
  ]
  const bm = new Bm25(docs)

  it('ranks the document with the rarer matching term first', () => {
    const s = bm.score(['start', 'published'])
    expect(s[0]).toBeGreaterThan(s[1] ?? 0)
    expect(s[2]).toBe(0)
  })

  it('rewards term frequency', () => {
    const s = bm.score(['email'])
    expect(s[2]).toBeGreaterThan(0)
    expect(s[0]).toBe(0)
  })
})

describe('reciprocalRankFusion', () => {
  it('sums 1/(k+rank) over the rankings and ignores non-positive scores', () => {
    const fused = reciprocalRankFusion(
      [
        [0.9, 0.5, 0.1],
        [0, 3, 1],
      ],
      60
    )
    expect(fused[0]).toBeCloseTo(1 / 61)
    expect(fused[1]).toBeCloseTo(1 / 62 + 1 / 61)
    expect(fused[2]).toBeCloseTo(1 / 63 + 1 / 62)
    expect(fused[1]).toBeGreaterThan(fused[2] ?? 0)
  })
})
