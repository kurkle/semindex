import { PAIR_MIN_TOKENS, PAIR_THRESHOLD } from './constants.js'

export interface PairItem {
  /** Repository label, so pairs across repositories can be told apart. */
  repo: string
  path: string
  folder: string
  name: string
  line: number
  n: number
  astHash: string
  calls: string[]
  vec: Float32Array
}

export interface Pair {
  a: number
  b: number
  score: number
  scope: 'cross-repo' | 'cross-folder' | 'same-folder'
}

export interface PairResult {
  pairs: Pair[]
  /** Identical AST hash: the same code up to names and literals. Reported apart from the similarity pairs. */
  exact: Pair[]
}

function scopeOf(x: PairItem, y: PairItem): Pair['scope'] {
  if (x.repo !== y.repo) return 'cross-repo'
  return x.folder === y.folder ? 'same-folder' : 'cross-folder'
}

/** Either one calls (or renders) the other: a wrapper and the function it wraps look alike but are no copy. */
export function callsEither(x: PairItem, y: PairItem): boolean {
  return x.calls.includes(y.name) || y.calls.includes(x.name)
}

const SCOPE_ORDER = { 'cross-repo': 0, 'cross-folder': 1, 'same-folder': 2 }

/**
 * The pairing rule: cosine at or above the threshold, each the other's nearest neighbour among all items,
 * neither calls the other, both at least PAIR_MIN_TOKENS long. Exact copies (identical AST hash) come apart.
 * Sorted cross-repo first, then cross-folder, then same folder; by score within each.
 */
export function findPairs(items: PairItem[], threshold = PAIR_THRESHOLD, minTokens = PAIR_MIN_TOKENS): PairResult {
  const n = items.length
  const dims = items[0]?.vec.length ?? 0
  const m = new Float32Array(n * dims)
  items.forEach((it, i) => {
    m.set(it.vec, i * dims)
  })
  const best = new Int32Array(n).fill(-1)
  const bestScore = new Float32Array(n).fill(-2)
  const above: Pair[] = []
  for (let i = 0; i < n; i++) {
    const oi = i * dims
    for (let j = i + 1; j < n; j++) {
      const oj = j * dims
      let s = 0
      for (let d = 0; d < dims; d++) s += (m[oi + d] as number) * (m[oj + d] as number)
      if (s > (bestScore[i] as number)) {
        bestScore[i] = s
        best[i] = j
      }
      if (s > (bestScore[j] as number)) {
        bestScore[j] = s
        best[j] = i
      }
      if (s >= threshold) above.push({ a: i, b: j, score: s, scope: 'same-folder' })
    }
  }
  const pairs: Pair[] = []
  const exact: Pair[] = []
  const long = (x: PairItem): boolean => x.n >= minTokens
  for (let i = 0; i < n; i++) {
    const x = items[i] as PairItem
    if (!long(x)) continue
    for (let j = i + 1; j < n; j++) {
      const y = items[j] as PairItem
      if (long(y) && x.astHash && x.astHash === y.astHash) exact.push({ a: i, b: j, score: 1, scope: scopeOf(x, y) })
    }
  }
  for (const p of above) {
    const x = items[p.a] as PairItem
    const y = items[p.b] as PairItem
    if (!long(x) || !long(y)) continue
    if (x.astHash && x.astHash === y.astHash) continue
    if (best[p.a] !== p.b || best[p.b] !== p.a) continue
    if (callsEither(x, y)) continue
    pairs.push({ ...p, scope: scopeOf(x, y) })
  }
  const order = (p: Pair, q: Pair): number => SCOPE_ORDER[p.scope] - SCOPE_ORDER[q.scope] || q.score - p.score
  pairs.sort(order)
  exact.sort(order)
  return { pairs, exact }
}
