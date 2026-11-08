import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { tokenize } from '../src/bm25.js'
import type { Embedder } from '../src/embed.js'
import { normalize } from '../src/embed.js'

/** Bag-of-words vectors hashed into 768 dims: texts sharing words point the same way. No model needed. */
export class FakeEmbedder implements Embedder {
  readonly dims = 768
  calls = 0
  texts = 0
  async embed(texts: string[]): Promise<Float32Array[][]> {
    this.calls++
    this.texts += texts.length
    return texts.map((t) => {
      const v = new Float32Array(768)
      for (const w of tokenize(t)) {
        let h = 0
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0
        v[h % 768] = (v[h % 768] ?? 0) + 1
      }
      return [normalize(v)]
    })
  }
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A git repository with the given files committed on main. */
export function makeRepo(files: Record<string, string>): string {
  const dir = tempDir('semindex-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFiles(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), c)
  }
}

/** A gzipped npm-style tarball (files under package/), built in memory for tests. */
export function makeTarball(files: Record<string, string>, opts: { top?: string } = {}): Buffer {
  const blocks: Buffer[] = []
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512)
    h.write(name.slice(0, 100), 0)
    h.write('0000644\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
    h.write('00000000000\0', 136)
    h.write('        ', 148)
    h.write(type, 156)
    h.write('ustar\0', 257)
    h.write('00', 263)
    let sum = 0
    for (const b of h) sum += b
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    return h
  }
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)])
  for (const [path, content] of Object.entries(files)) {
    const name = `${opts.top ?? 'package'}/${path}`
    const body = Buffer.from(content, 'utf8')
    if (name.length > 100) {
      const rec = ` path=${name}\n`
      let len = rec.length + 2
      while (`${len}${rec}`.length !== len) len++
      const pax = Buffer.from(`${len}${rec}`, 'utf8')
      blocks.push(header('PaxHeader', pax.length, 'x'), pad(pax))
    }
    blocks.push(header(name, body.length, '0'), pad(body))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

export function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}
