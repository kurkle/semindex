import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export interface RepoInfo {
  /** The working tree root of this checkout or worktree. */
  root: string
  /** The git common dir, shared by every worktree of one repository; the cache keys a repo by it. */
  commonDir: string
  head: string | null
}

export interface TreeEntry {
  path: string
  blobId: string
}

const MAX_BUFFER = 1 << 30

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** The repository a directory belongs to, or null when it is not inside a git working tree. */
export function repoOf(dir: string): RepoInfo | null {
  let out: string
  try {
    out = git(dir, ['rev-parse', '--show-toplevel', '--git-common-dir'])
  } catch {
    return null
  }
  const [top, common] = out.trim().split('\n')
  if (!top || !common) return null
  const root = realpathSync(top)
  const commonDir = realpathSync(isAbsolute(common) ? common : resolve(dir, common))
  let head: string | null = null
  try {
    head = git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).trim() || null
  } catch {
    head = null
  }
  return { root, commonDir, head }
}

/** Regular files of the HEAD commit with their blob ids. Symlinks and submodules are left out. */
export function listTree(root: string, rev = 'HEAD', path?: string): TreeEntry[] {
  let out: string
  try {
    out = git(root, ['ls-tree', '-r', '-z', '--full-tree', rev, ...(path ? ['--', path] : [])])
  } catch {
    return []
  }
  const entries: TreeEntry[] = []
  for (const rec of out.split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t')
    const [mode, type, id] = rec.slice(0, tab).split(' ')
    if (type !== 'blob' || !id || mode === '120000') continue
    entries.push({ path: rec.slice(tab + 1), blobId: id })
  }
  return entries
}

export interface WorkingChanges {
  /** Files whose working copy differs from HEAD, untracked ones included (ignored ones not). */
  changed: string[]
  deleted: string[]
}

/** Working tree changes against HEAD. Uses --no-optional-locks so that reading never rewrites the index. */
export function workingChanges(root: string): WorkingChanges {
  const out = execFileSync(
    'git',
    ['--no-optional-locks', '-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  const changed: string[] = []
  const deleted: string[] = []
  const recs = out.split('\0')
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    if (!rec || rec.length < 4) continue
    const x = rec[0]
    const y = rec[1]
    const path = rec.slice(3)
    if (x === 'R' || x === 'C') {
      const from = recs[++i]
      if (x === 'R' && from) deleted.push(from)
    }
    if (x === 'D' || y === 'D') deleted.push(path)
    else changed.push(path)
  }
  return { changed, deleted }
}

/** Contents of many blobs at once through one `git cat-file --batch`. */
export function readBlobs(root: string, ids: string[]): Map<string, Buffer> {
  const result = new Map<string, Buffer>()
  if (ids.length === 0) return result
  const res = spawnSync('git', ['-C', root, 'cat-file', '--batch'], {
    input: `${ids.join('\n')}\n`,
    maxBuffer: MAX_BUFFER,
  })
  if (res.status !== 0) throw new Error(`git cat-file failed: ${res.stderr?.toString()}`)
  const buf = res.stdout
  let pos = 0
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos)
    if (nl < 0) break
    const header = buf.subarray(pos, nl).toString('utf8').split(' ')
    pos = nl + 1
    if (header[1] === 'missing') continue
    const size = Number(header[2])
    if (header[0]) result.set(header[0], buf.subarray(pos, pos + size))
    pos += size + 1
  }
  return result
}
