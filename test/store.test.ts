import { describe, expect, it } from 'vitest'
import { decodeVectors, encodeVectors } from '../src/store.js'

describe('vector files', () => {
  it('round-trip parts per chunk through float16', () => {
    const a = Float32Array.from({ length: 8 }, (_, i) => i / 10)
    const b = Float32Array.from({ length: 8 }, (_, i) => -i / 7)
    const decoded = decodeVectors(encodeVectors([[a], [], [b, a]]), 8)
    expect(decoded.map((p) => p.length)).toEqual([1, 0, 2])
    decoded[2]?.[0]?.forEach((x, i) => {
      expect(x).toBeCloseTo(b[i] ?? 0, 3)
    })
  })
})
