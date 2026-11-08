import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from './store.js'

/**
 * The user's configuration, kept outside every repository:
 *
 *   $XDG_CONFIG_HOME/semindex/config.json   (default ~/.config/semindex/config.json)
 *
 * `groups` maps a group name to its members' git common dirs, so every worktree of a member resolves to the
 * group.
 */
export interface Config {
  groups: Record<string, string[]>
}

export function defaultConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'semindex', 'config.json')
}

export function readConfig(path: string): Config {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
    return { ...c, groups: c.groups ?? {} }
  } catch {
    return { groups: {} }
  }
}

export function writeConfig(path: string, config: Config): void {
  writeAtomic(path, `${JSON.stringify(config, null, 2)}\n`)
}

/** Adds members (git common dirs) to a group, creating it when new. */
export function addToGroup(config: Config, name: string, commonDirs: string[]): Config {
  const members = [...new Set([...(config.groups[name] ?? []), ...commonDirs])].sort()
  return { ...config, groups: { ...config.groups, [name]: members } }
}

/** Removes members from a group, or the whole group when none are named; a group left empty goes too. */
export function removeFromGroup(config: Config, name: string, commonDirs?: string[]): Config {
  const groups = { ...config.groups }
  const left = commonDirs?.length ? (groups[name] ?? []).filter((m) => !commonDirs.includes(m)) : []
  if (left.length) groups[name] = left
  else delete groups[name]
  return { ...config, groups }
}

/** Removes a repository from every group it is in; returns the groups it left. */
export function removeEverywhere(config: Config, commonDir: string): { config: Config; left: string[] } {
  let next = config
  const left: string[] = []
  for (const [name, members] of Object.entries(config.groups)) {
    if (!members.includes(commonDir)) continue
    next = removeFromGroup(next, name, [commonDir])
    left.push(name)
  }
  return { config: next, left }
}

/** The other members of every group the repository is in, without itself. */
export function groupPeers(config: Config, commonDir: string): string[] {
  const peers = new Set<string>()
  for (const members of Object.values(config.groups)) {
    if (!members.includes(commonDir)) continue
    for (const m of members) if (m !== commonDir) peers.add(m)
  }
  return [...peers].sort()
}
