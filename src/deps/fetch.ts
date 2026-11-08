import { createHash } from 'node:crypto'

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>

export interface FetchLimits {
  /** Compressed tarball size. */
  maxBytes: number
  timeoutMs: number
}

/** The sha512 digest a Subresource Integrity string pins, base64; null when it pins none. */
export function sha512Of(integrity: string | null): string | null {
  for (const part of (integrity ?? '').trim().split(/\s+/)) {
    if (part.startsWith('sha512-')) return part.slice(7).replace(/\?.*$/, '')
  }
  return null
}

/** Throws unless the bytes hash to the sha512 the lockfile pins. */
export function verifyIntegrity(bytes: Uint8Array, integrity: string | null, what: string): void {
  const want = sha512Of(integrity)
  if (!want) throw new Error(`${what}: the lockfile pins no sha512 integrity, refusing to use the tarball`)
  const got = createHash('sha512').update(bytes).digest('base64')
  if (got !== want) throw new Error(`${what}: integrity mismatch (sha512-${got} is not the locked sha512-${want})`)
}

/**
 * Downloads a registry tarball and checks it against the lockfile's integrity before anything reads it.
 * The download is cut off at `maxBytes` and after `timeoutMs`.
 */
export async function fetchTarball(
  url: string,
  integrity: string | null,
  what: string,
  limits: FetchLimits,
  fetcher: Fetcher = fetch
): Promise<Uint8Array> {
  if (!sha512Of(integrity)) throw new Error(`${what}: the lockfile pins no sha512 integrity, refusing to fetch`)
  const res = await fetcher(url, { signal: AbortSignal.timeout(limits.timeoutMs) })
  if (!res.ok || !res.body) throw new Error(`${what}: ${url} answered HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > limits.maxBytes) throw new Error(`${what}: tarball of ${declared} bytes exceeds ${limits.maxBytes}`)
  const parts: Uint8Array[] = []
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.length
    if (total > limits.maxBytes) throw new Error(`${what}: tarball exceeds ${limits.maxBytes} bytes`)
    parts.push(chunk)
  }
  const bytes = Buffer.concat(parts)
  verifyIntegrity(bytes, integrity, what)
  return bytes
}
