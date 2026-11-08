import { describe, expect, it } from 'vitest'
import { OnnxEmbedder } from '../src/embed.js'
import { isModelCached, modelDir } from '../src/model.js'
import { defaultCacheDir } from '../src/store.js'

const cache = defaultCacheDir()

/** Runs only where the model is already downloaded; CI has no model. */
describe.skipIf(!isModelCached(cache))('CodeRankEmbed', () => {
  it('scores a renamed copy far above an unrelated function, and splits long input into parts', async () => {
    const e = await OnnxEmbedder.load(modelDir(cache))
    const a = 'function sumPlaces(classes) { let total = 0; for (const c of classes) total += c.places; return total }'
    const b = 'function totalPlaces(list) { let sum = 0; for (const item of list) sum += item.places; return sum }'
    const c = 'async function sendMail(to, subject) { await ses.send({ to, subject }) }'
    const [va, vb, vc] = (await e.embed([a, b, c])).map((p) => p[0] ?? new Float32Array(768))
    const cos = (x?: Float32Array, y?: Float32Array): number => {
      let s = 0
      x?.forEach((v, i) => {
        s += v * (y?.[i] ?? 0)
      })
      return s
    }
    expect(cos(va, vb)).toBeGreaterThan(0.75)
    expect(cos(va, vb)).toBeGreaterThan(cos(va, vc) + 0.1)
    const long = Array.from({ length: 400 }, (_, i) => `const value${i} = compute(${i})`).join('\n')
    const [parts] = await e.embed([long])
    expect(parts?.length).toBeGreaterThan(1)
  }, 120_000)
})
