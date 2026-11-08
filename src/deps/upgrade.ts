import type { PackageIndex } from './package.js'

export interface ApiDiff {
  added: string[]
  removed: string[]
  /** Declarations whose text (comments and whitespace aside) differs; removed ones are not repeated here. */
  changed: string[]
  /** Changed or removed names that the docs lines new in this version mention. */
  mentioned: string[]
}

function hashesByName(index: PackageIndex): Map<string, string> {
  const by = new Map<string, Set<string>>()
  for (const d of index.decls) {
    const set = by.get(d.name) ?? new Set<string>()
    set.add(d.hash)
    by.set(d.name, set)
  }
  return new Map([...by].map(([n, s]) => [n, [...s].sort().join(',')]))
}

function docLines(index: PackageIndex): Set<string> {
  const lines = new Set<string>()
  for (const c of index.chunks) if (c.kind === 'doc') for (const l of c.text.split('\n')) lines.add(l)
  return lines
}

/** Names shorter than this are too common in prose to count as a changelog mention. */
const MIN_MENTION_LENGTH = 4

/**
 * The declarations added, removed and changed between two versions of a package, a name counting as changed
 * when its set of declaration hashes differs, and the changed or removed names that the Markdown lines new in
 * the later version (changelog, README, docs) name as a word.
 */
export function diffApi(before: PackageIndex, after: PackageIndex): ApiDiff {
  const a = hashesByName(before)
  const b = hashesByName(after)
  const added = [...b.keys()].filter((n) => !a.has(n)).sort()
  const removed = [...a.keys()].filter((n) => !b.has(n)).sort()
  const changed = [...a]
    .filter(([n, h]) => b.has(n) && b.get(n) !== h)
    .map(([n]) => n)
    .sort()
  const old = docLines(before)
  const words = new Set<string>()
  for (const l of docLines(after)) {
    if (old.has(l)) continue
    for (const w of l.match(/[A-Za-z_$][\w$]*/g) ?? []) words.add(w)
  }
  const mentioned = [...removed, ...changed].filter((n) => n.length >= MIN_MENTION_LENGTH && words.has(n)).sort()
  return { added, removed, changed, mentioned }
}

export interface UsingFunction {
  path: string
  line: number
  name: string
  /** `<module specifier>:<name>` as the extractor records them. */
  uses: string[]
}

export interface BumpedPackage {
  name: string
  /** Module specifiers the package answers for (itself; `foo` for @types/foo; builtins for @types/node). */
  modules: string[]
  diff: ApiDiff | null
}

export interface SymbolUse {
  package: string
  symbol: string
  status: 'removed' | 'changed' | 'mentioned' | 'used'
}

export interface Impact {
  tier: 1 | 2 | 3
  path: string
  line: number
  name: string
  usesRemoved: boolean
  symbols: SymbolUse[]
}

function packageFor(spec: string, bumped: BumpedPackage[]): BumpedPackage | undefined {
  return bumped.find((p) => p.modules.some((m) => spec === m || spec.startsWith(`${m}/`)))
}

/**
 * The functions that use a bumped package, in three tiers: 1 uses a changed or removed declaration that the
 * new docs lines name, 2 uses a changed or removed declaration (a default or namespace import used as a whole
 * counts when anything changed), 3 uses the package at all. Within a tier, functions using a removed
 * declaration come first.
 */
export function rankImpact(functions: UsingFunction[], bumped: BumpedPackage[]): Impact[] {
  const sets = new Map(
    bumped.map((p) => [
      p.name,
      {
        removed: new Set(p.diff?.removed),
        changed: new Set([...(p.diff?.removed ?? []), ...(p.diff?.changed ?? [])]),
        mentioned: new Set(p.diff?.mentioned),
      },
    ])
  )
  const out: Impact[] = []
  for (const fn of functions) {
    const symbols: SymbolUse[] = []
    for (const u of fn.uses) {
      const cut = u.lastIndexOf(':')
      const spec = u.slice(0, cut)
      const symbol = u.slice(cut + 1)
      const pkg = packageFor(spec, bumped)
      const s = pkg && sets.get(pkg.name)
      if (!pkg || !s) continue
      let status: SymbolUse['status'] = 'used'
      if (s.mentioned.has(symbol)) status = 'mentioned'
      else if (s.removed.has(symbol)) status = 'removed'
      else if (symbol === '*' ? s.changed.size > 0 : s.changed.has(symbol)) status = 'changed'
      if (s.removed.has(symbol) && status === 'mentioned')
        symbols.push({ package: pkg.name, symbol, status: 'removed' })
      symbols.push({ package: pkg.name, symbol, status })
    }
    if (symbols.length === 0) continue
    const unique = [...new Map(symbols.map((s) => [`${s.package}:${s.symbol}:${s.status}`, s])).values()]
    const has = (st: SymbolUse['status']) => unique.some((s) => s.status === st)
    const tier = has('mentioned') ? 1 : has('removed') || has('changed') ? 2 : 3
    out.push({ tier, path: fn.path, line: fn.line, name: fn.name, usesRemoved: has('removed'), symbols: unique })
  }
  const weight = (i: Impact) => i.symbols.filter((s) => s.status !== 'used').length
  out.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(b.usesRemoved) - Number(a.usesRemoved) ||
      weight(b) - weight(a) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line
  )
  return out
}
