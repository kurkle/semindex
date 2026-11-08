import { describe, expect, it } from 'vitest'
import { normalize } from '../src/embed.js'
import { findPairs, type PairItem } from '../src/pairs.js'

function vec(...xs: number[]): Float32Array {
  const v = new Float32Array(4)
  v.set(xs)
  return normalize(v)
}

function item(name: string, folder: string, v: Float32Array, extra: Partial<PairItem> = {}): PairItem {
  return {
    repo: 'r',
    path: `${folder}/${name}.ts`,
    folder,
    name,
    line: 1,
    n: 100,
    astHash: name,
    calls: [],
    vec: v,
    ...extra,
  }
}

describe('findPairs', () => {
  it('keeps mutual nearest neighbours above the threshold, cross-folder first', () => {
    const items = [
      item('a', 'x', vec(1, 0.1, 0, 0)),
      item('b', 'y', vec(1, 0.15, 0, 0)),
      item('c', 'x', vec(0, 1, 0, 0.1)),
      item('d', 'x', vec(0, 1, 0, 0.12)),
      item('e', 'z', vec(0, 0, 1, 0)),
    ]
    const { pairs } = findPairs(items, 0.9, 60)
    expect(pairs.map((p) => [items[p.a]?.name, items[p.b]?.name, p.scope])).toEqual([
      ['a', 'b', 'cross-folder'],
      ['c', 'd', 'same-folder'],
    ])
  })

  it('drops a pair that is not mutual', () => {
    // b's nearest is c, so a-b is dropped although above the threshold
    const items = [
      item('a', 'x', vec(1, 0.3, 0, 0)),
      item('b', 'y', vec(1, 0.5, 0, 0)),
      item('c', 'z', vec(1, 0.55, 0, 0)),
    ]
    const names = findPairs(items, 0.9, 60).pairs.map((p) => `${items[p.a]?.name}${items[p.b]?.name}`)
    expect(names).toEqual(['bc'])
  })

  it('drops a wrapper and the function it calls', () => {
    const items = [item('wrap', 'x', vec(1, 0, 0, 0), { calls: ['inner'] }), item('inner', 'y', vec(1, 0.01, 0, 0))]
    expect(findPairs(items, 0.9, 60).pairs).toEqual([])
  })

  it('drops short functions', () => {
    const items = [item('a', 'x', vec(1, 0, 0, 0), { n: 59 }), item('b', 'y', vec(1, 0.01, 0, 0))]
    expect(findPairs(items, 0.9, 60).pairs).toEqual([])
  })

  it('reports identical AST hashes as exact copies, apart from the similarity pairs', () => {
    const items = [
      item('a', 'x', vec(1, 0, 0, 0), { astHash: 'h' }),
      item('b', 'y', vec(1, 0, 0, 0), { astHash: 'h' }),
      item('c', 'z', vec(0, 1, 0, 0)),
    ]
    const r = findPairs(items, 0.9, 60)
    expect(r.pairs).toEqual([])
    expect(r.exact.map((p) => [p.a, p.b])).toEqual([[0, 1]])
  })

  it('puts cross-repo pairs before cross-folder ones', () => {
    const items = [
      item('a', 'x', vec(1, 0, 0, 0)),
      item('b', 'y', vec(1, 0.01, 0, 0)),
      item('c', 'x', vec(0, 1, 0, 0), { repo: 'one' }),
      item('d', 'x', vec(0, 1, 0.2, 0), { repo: 'two' }),
    ]
    expect(findPairs(items, 0.9, 60).pairs.map((p) => p.scope)).toEqual(['cross-repo', 'cross-folder'])
  })
})
