/** Words of three or more letters, camelCase and snake_case split, lower case. Finnish letters count. */
export function tokenize(text: string): string[] {
  const spaced = text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
  return (spaced.toLowerCase().match(/\p{L}{3,}/gu) ?? []) as string[]
}

/** Okapi BM25 over a fixed set of documents. */
export class Bm25 {
  private readonly tf: Map<string, number>[]
  private readonly len: Int32Array
  private readonly df = new Map<string, number>()
  private readonly avg: number

  constructor(
    docs: string[][],
    private readonly k1 = 1.2,
    private readonly b = 0.75
  ) {
    this.tf = docs.map((d) => {
      const m = new Map<string, number>()
      for (const t of d) m.set(t, (m.get(t) ?? 0) + 1)
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      return m
    })
    this.len = Int32Array.from(docs.map((d) => d.length))
    this.avg = docs.length ? docs.reduce((s, d) => s + d.length, 0) / docs.length : 0
  }

  score(query: string[]): Float64Array {
    const n = this.tf.length
    const out = new Float64Array(n)
    const terms = [...new Set(query)]
    for (const t of terms) {
      const df = this.df.get(t)
      if (!df) continue
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      for (let i = 0; i < n; i++) {
        const f = this.tf[i]?.get(t)
        if (!f) continue
        const norm = this.k1 * (1 - this.b + (this.b * (this.len[i] ?? 0)) / (this.avg || 1))
        out[i] = (out[i] ?? 0) + (idf * f * (this.k1 + 1)) / (f + norm)
      }
    }
    return out
  }
}

/**
 * Reciprocal rank fusion of several score arrays over the same items: each item gets the sum of 1 / (k + rank)
 * over the rankings, rank starting at 1. Items scoring zero or less in a ranking get nothing from it.
 */
export function reciprocalRankFusion(rankings: ArrayLike<number>[], k: number): Float64Array {
  const n = rankings[0]?.length ?? 0
  const fused = new Float64Array(n)
  for (const scores of rankings) {
    const order = Array.from({ length: n }, (_, i) => i).filter((i) => (scores[i] ?? 0) > 0)
    order.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))
    order.forEach((item, rank) => {
      fused[item] = (fused[item] ?? 0) + 1 / (k + rank + 1)
    })
  }
  return fused
}
