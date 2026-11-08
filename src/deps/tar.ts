import { gunzipSync } from 'node:zlib'

export interface TarLimits {
  /** Uncompressed tar size. */
  maxBytes: number
  /** Size of a single kept file; a larger one is skipped. */
  maxFileBytes: number
}

export interface TarFile {
  path: string
  content: Buffer
}

function field(h: Buffer, start: number, len: number): string {
  const s = h.subarray(start, start + len).toString('utf8')
  const nul = s.indexOf('\0')
  return nul >= 0 ? s.slice(0, nul) : s
}

function octal(h: Buffer, start: number, len: number): number {
  const s = field(h, start, len).trim()
  return s ? Number.parseInt(s, 8) : 0
}

/** `path` from a pax extended header ("<len> path=<value>\n" records). */
function paxPath(body: Buffer): string | null {
  const text = body.toString('utf8')
  let pos = 0
  while (pos < text.length) {
    const sp = text.indexOf(' ', pos)
    if (sp < 0) break
    const len = Number(text.slice(pos, sp))
    if (!len) break
    const rec = text.slice(sp + 1, pos + len - 1)
    if (rec.startsWith('path=')) return rec.slice(5)
    pos += len
  }
  return null
}

/**
 * Regular files of a gzipped tarball whose path passes `keep`, read without touching the file system and
 * without running anything. ustar, pax and GNU long names are understood; links and devices are skipped.
 * Throws when the uncompressed tarball exceeds `maxBytes`.
 */
export function readTarball(gz: Uint8Array, keep: (path: string) => boolean, limits: TarLimits): TarFile[] {
  let buf: Buffer
  try {
    buf = gunzipSync(gz, { maxOutputLength: limits.maxBytes })
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`tarball is larger than ${limits.maxBytes} bytes unpacked`)
    throw new Error(`tarball does not unpack: ${e instanceof Error ? e.message : String(e)}`)
  }
  const files: TarFile[] = []
  let longName: string | null = null
  for (let o = 0; o + 512 <= buf.length; ) {
    const h = buf.subarray(o, o + 512)
    if (h.every((b) => b === 0)) break
    const size = octal(h, 124, 12)
    const type = String.fromCharCode(h[156] ?? 0)
    const body = buf.subarray(o + 512, o + 512 + size)
    o += 512 + Math.ceil(size / 512) * 512
    if (type === 'x' || type === 'L') {
      longName = type === 'x' ? paxPath(body) : field(body, 0, body.length)
      continue
    }
    if (type === 'g') continue
    const prefix = field(h, 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100))
    longName = null
    if (type !== '0' && type !== '\0' && type !== '7') continue
    // npm tarballs put everything under one top folder, usually package/.
    const path = name.replace(/^\.?\/?[^/]+\//, '')
    if (path.split('/').includes('..') || !keep(path) || size > limits.maxFileBytes) continue
    files.push({ path, content: Buffer.from(body) })
  }
  return files
}
