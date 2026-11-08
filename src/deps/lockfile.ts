/** A direct dependency of a package as its lockfile pins it. */
export interface LockedDep {
  name: string
  version: string
  /** Where the tarball came from; null for links, workspaces and git or file dependencies. */
  resolved: string | null
  integrity: string | null
  kind: 'prod' | 'dev' | 'peer'
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface LockEntry {
  version?: string
  resolved?: string
  integrity?: string
  link?: boolean
}

interface Lockfile {
  lockfileVersion?: number
  packages?: Record<string, LockEntry>
  dependencies?: Record<string, LockEntry>
}

/**
 * The direct dependencies of a package (dependencies, devDependencies, peerDependencies) at the versions its
 * npm lockfile pins: `packages["node_modules/<name>"]` in lockfile v2 and v3, `dependencies[<name>]` in v1.
 * A dependency missing from the lockfile (an uninstalled optional peer, say) is left out.
 */
export function lockedDeps(packageJson: string, lockfile: string): LockedDep[] {
  const pkg = JSON.parse(packageJson) as PackageJson
  const lock = JSON.parse(lockfile) as Lockfile
  const kinds: [LockedDep['kind'], Record<string, string> | undefined][] = [
    ['prod', pkg.dependencies],
    ['dev', pkg.devDependencies],
    ['peer', pkg.peerDependencies],
  ]
  const out = new Map<string, LockedDep>()
  for (const [kind, deps] of kinds) {
    for (const name of Object.keys(deps ?? {})) {
      if (out.has(name)) continue
      let entry = lock.packages?.[`node_modules/${name}`] ?? lock.dependencies?.[name]
      // A workspace link points at the folder that holds the package.
      if (entry?.link) entry = { version: entry.version, resolved: undefined }
      if (!entry?.version) continue
      const fromRegistry = !!entry.resolved && /^https?:\/\//.test(entry.resolved)
      out.set(name, {
        name,
        version: entry.version,
        resolved: fromRegistry ? (entry.resolved as string) : null,
        integrity: entry.integrity ?? null,
        kind,
      })
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The package an import specifier belongs to: `date-fns/locale` is date-fns, `@mui/material/Box` @mui/material. */
export function packageOfSpecifier(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec)
}

/**
 * The module names whose imports a package describes. `@types/foo` types `foo`, `@types/scope__bar` types
 * `@scope/bar`, and `@types/node` the builtins (`node:fs`, `fs`, ...); any other package describes itself.
 */
export function typedModules(name: string, builtins: readonly string[]): string[] {
  if (name === '@types/node') return [...builtins, ...builtins.map((b) => `node:${b}`)]
  const m = /^@types\/(.+)$/.exec(name)
  if (!m?.[1]) return [name]
  const inner = m[1]
  return [inner.includes('__') ? `@${inner.replace('__', '/')}` : inner]
}
