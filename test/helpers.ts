import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
