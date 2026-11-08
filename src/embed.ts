import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import { MAX_TOKENS, QUERY_PREFIX } from './constants.js'

export interface Embedder {
  readonly dims: number
  /** Each text gives one or more unit vectors: one per part of at most MAX_TOKENS tokens. */
  embed(texts: string[], opts?: { query?: boolean }): Promise<Float32Array[][]>
}

/** Batches of similar length: padding is what makes large mixed batches slow on CPU. */
const BATCH = 8

interface Piece {
  owner: number
  ids: number[]
}

/** CodeRankEmbed through onnxruntime: CLS pooling, unit length, the query prefix only on queries. */
export class OnnxEmbedder implements Embedder {
  readonly dims = 768
  private constructor(
    private readonly session: import('onnxruntime-node').InferenceSession,
    private readonly ort: typeof import('onnxruntime-node'),
    private readonly tokenizer: Tokenizer,
    private readonly cls: number,
    private readonly sep: number
  ) {}

  static async load(dir: string): Promise<OnnxEmbedder> {
    const ort = await import('onnxruntime-node')
    const session = await ort.InferenceSession.create(join(dir, 'model.onnx'), {
      intraOpNumThreads: Math.min(8, availableParallelism()),
      graphOptimizationLevel: 'all',
    })
    const tokenizer = new Tokenizer(
      JSON.parse(readFileSync(join(dir, 'tokenizer.json'), 'utf8')),
      JSON.parse(readFileSync(join(dir, 'tokenizer_config.json'), 'utf8'))
    )
    const cls = tokenizer.token_to_id('[CLS]') ?? 101
    const sep = tokenizer.token_to_id('[SEP]') ?? 102
    return new OnnxEmbedder(session, ort, tokenizer, cls, sep)
  }

  private tokens(text: string): number[] {
    return this.tokenizer.encode(text, { add_special_tokens: false }).ids
  }

  /** Splits a text at line ends into parts that fit the model; a single overlong line is cut. */
  private split(text: string): number[][] {
    const budget = MAX_TOKENS - 2
    const all = this.tokens(text)
    if (all.length <= budget) return [all]
    const parts: number[][] = []
    let cur: number[] = []
    for (const line of text.split('\n')) {
      const ids = this.tokens(line)
      if (cur.length + ids.length > budget && cur.length > 0) {
        parts.push(cur)
        cur = []
      }
      cur.push(...ids.slice(0, budget))
    }
    if (cur.length > 0) parts.push(cur)
    return parts
  }

  async embed(texts: string[], opts: { query?: boolean } = {}): Promise<Float32Array[][]> {
    const pieces: Piece[] = []
    texts.forEach((t, owner) => {
      const parts = opts.query ? [this.tokens(QUERY_PREFIX + t).slice(0, MAX_TOKENS - 2)] : this.split(t)
      for (const ids of parts) pieces.push({ owner, ids })
    })
    const order = pieces.map((_, i) => i).sort((a, b) => (pieces[a]?.ids.length ?? 0) - (pieces[b]?.ids.length ?? 0))
    const vecs: Float32Array[] = new Array(pieces.length)
    for (let b = 0; b < order.length; b += BATCH) {
      const idx = order.slice(b, b + BATCH)
      const len = Math.max(...idx.map((i) => (pieces[i]?.ids.length ?? 0) + 2))
      const ids = new BigInt64Array(idx.length * len)
      const mask = new BigInt64Array(idx.length * len)
      idx.forEach((pi, row) => {
        const seq = [this.cls, ...(pieces[pi]?.ids ?? []), this.sep]
        seq.forEach((id, col) => {
          ids[row * len + col] = BigInt(id)
          mask[row * len + col] = 1n
        })
      })
      const shape = [idx.length, len]
      const out = await this.session.run({
        input_ids: new this.ort.Tensor('int64', ids, shape),
        attention_mask: new this.ort.Tensor('int64', mask, shape),
        token_type_ids: new this.ort.Tensor('int64', new BigInt64Array(idx.length * len), shape),
      })
      const hidden = Object.values(out)[0]?.data as Float32Array
      idx.forEach((pi, row) => {
        const v = hidden.slice(row * len * this.dims, row * len * this.dims + this.dims)
        vecs[pi] = normalize(v)
      })
    }
    const result: Float32Array[][] = texts.map(() => [])
    pieces.forEach((p, i) => {
      const v = vecs[i]
      if (v) result[p.owner]?.push(v)
    })
    return result
  }
}

export function normalize(v: Float32Array): Float32Array {
  let s = 0
  for (const x of v) s += x * x
  const n = Math.sqrt(s) || 1
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / n
  return v
}
