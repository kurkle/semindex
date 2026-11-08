import { basename, join } from 'node:path'
import { addToGroup, readConfig, removeEverywhere, removeFromGroup, writeConfig } from './config.js'
import { mainWorktree, type RepoInfo, repoOf } from './git.js'
import { Registry } from './registry.js'

// The registry and group commands. They only read and write two small files, so the CLI runs them in its
// own process; the server reads both files again on every request.

export interface Member {
  commonDir: string
  /** The main working tree, or null when the repository is gone or bare. */
  root: string | null
  name: string
  indexed: boolean
}

function repoAt(dir: string): RepoInfo {
  const repo = repoOf(dir)
  if (!repo) throw new Error(`${dir} is not inside a git working tree`)
  return repo
}

function member(commonDir: string, registry: Registry): Member {
  const root = mainWorktree(commonDir)
  const name = root ? basename(root) : basename(commonDir) === '.git' ? basename(join(commonDir, '..')) : commonDir
  return { commonDir, root, name, indexed: registry.isIndexed(commonDir) }
}

/** Opts a repository out of the hook and takes it out of every group; its cached data stays until gc. */
export function forget(
  cacheDir: string,
  configPath: string,
  dir: string
): { root: string; wasIndexed: boolean; groups: string[] } {
  const repo = repoAt(dir)
  const wasIndexed = new Registry(cacheDir).forget(repo.commonDir)
  const { config, left } = removeEverywhere(readConfig(configPath), repo.commonDir)
  if (left.length) writeConfig(configPath, config)
  return { root: repo.root, wasIndexed, groups: left }
}

/** Adds repositories to a group (creating it) and opts each one in to the hook. */
export function groupAdd(cacheDir: string, configPath: string, name: string, dirs: string[]): Member[] {
  if (!name) throw new Error('usage: semindex group add <name> <dir...>')
  if (dirs.length === 0) throw new Error('name at least one repository to add')
  const repos = dirs.map(repoAt)
  const registry = new Registry(cacheDir)
  for (const r of repos) registry.add(r.commonDir, r.root, { indexed: true })
  const config = addToGroup(
    readConfig(configPath),
    name,
    repos.map((r) => r.commonDir)
  )
  writeConfig(configPath, config)
  return (config.groups[name] ?? []).map((c) => member(c, registry))
}

/**
 * The common dir a `group remove` argument means: the repository at that path, or, for a repository that is
 * gone, the member stored under that path (or its .git).
 */
function memberDir(dir: string, members: string[]): string {
  const repo = repoOf(dir)
  if (repo) return repo.commonDir
  for (const c of [dir, join(dir, '.git')]) if (members.includes(c)) return c
  throw new Error(`${dir} is not a member of the group`)
}

/** Removes repositories from a group, or the whole group when none are named. They stay indexed. */
export function groupRemove(configPath: string, name: string, dirs: string[]): { removed: string[]; left: number } {
  const config = readConfig(configPath)
  const members = config.groups[name]
  if (!members) throw new Error(`no group named ${name}`)
  const remove = dirs.length ? dirs.map((d) => memberDir(d, members)) : members
  const next = removeFromGroup(config, name, dirs.length ? remove : undefined)
  writeConfig(configPath, next)
  return { removed: remove, left: next.groups[name]?.length ?? 0 }
}

export function groupList(cacheDir: string, configPath: string): { name: string; members: Member[] }[] {
  const registry = new Registry(cacheDir)
  return Object.entries(readConfig(configPath).groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, members]) => ({ name, members: members.map((c) => member(c, registry)) }))
}
