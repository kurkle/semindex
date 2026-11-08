import { realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Deps } from '../src/deps/deps.js'
import { DepStore, namespaceKey } from '../src/deps/store.js'
import { Engine } from '../src/engine.js'
import { repoOf } from '../src/git.js'
import { Store } from '../src/store.js'
import { FakeEmbedder, git, integrityOf, makeRepo, makeTarball, tempDir } from './helpers.js'

const V1 = makeTarball({
  'index.d.ts': `/** Formats a date with a pattern. */
export declare function format(date: Date, pattern: string): string
/** Parses a date. */
export declare function parse(text: string): Date
export declare function gone(): void
export declare function keep(): void
`,
  'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- First release.\n',
})
const V2 = makeTarball({
  'index.d.ts': `/** Formats a date with a pattern. */
export declare function format(date: Date, pattern: string): string
/** Parses a date against a reference date. */
export declare function parse(text: string, reference: Date): Date
export declare function keep(): void
`,
  'CHANGELOG.md': '# Changelog\n\n## 2.0.0\n\n- parse needs a reference date.\n\n## 1.0.0\n\n- First release.\n',
})
const NOTYPES = makeTarball({ 'README.md': '# plain\n\nNo declarations here.\n', 'index.js': 'module.exports = 1' })

const url = (name: string, v: string) => `https://registry.test/${name}/-/${name}-${v}.tgz`
const TARBALLS: Record<string, Buffer> = {
  [url('lib', '1.0.0')]: V1,
  [url('lib', '2.0.0')]: V2,
  [url('plain', '1.0.0')]: NOTYPES,
}

function registry(overrides: Record<string, Buffer> = {}) {
  const calls: string[] = []
  const fetcher = async (u: string) => {
    calls.push(u)
    const body = overrides[u] ?? TARBALLS[u]
    return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 })
  }
  return { calls, fetcher }
}

function files(libVersion: string, opts: { integrity?: string } = {}) {
  return {
    'package.json': JSON.stringify({ dependencies: { lib: '*' }, devDependencies: { plain: '*' } }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/lib': {
          version: libVersion,
          resolved: url('lib', libVersion),
          integrity: opts.integrity ?? integrityOf(TARBALLS[url('lib', libVersion)] as Buffer),
        },
        'node_modules/plain': { version: '1.0.0', resolved: url('plain', '1.0.0'), integrity: integrityOf(NOTYPES) },
      },
    }),
  }
}

const SRC = `import { format, keep, parse } from 'lib'
import * as all from 'lib'

export function show(d: Date) {
  return format(d, 'yyyy')
}
export function read(s: string) {
  return parse(s)
}
export function idle() {
  keep()
}
export function whole() {
  return all.gone()
}
export function local(n: number) {
  return n + 1
}
`

function setup(fetcher: ReturnType<typeof registry>['fetcher'], cache = tempDir('semindex-deps-')) {
  const embedder = new FakeEmbedder()
  const store = new DepStore(cache, 'fake')
  return {
    cache,
    embedder,
    store,
    deps: new Deps(
      store,
      async () => embedder,
      () => {},
      fetcher
    ),
  }
}

function repoInfo(dir: string) {
  const r = repoOf(realpathSync(dir))
  if (!r) throw new Error('no repo')
  return r
}

describe('dependency cache', () => {
  it('parses a package version once and serves it to another repository from the cache', async () => {
    const reg = registry()
    const { cache, deps } = setup(reg.fetcher)
    const a = await deps.build(repoInfo(makeRepo(files('1.0.0'))))
    expect(a).toMatchObject({ packages: 2, parsed: 2, cached: 0, skipped: [] })
    expect(a.noTypes).toEqual([{ name: 'plain', version: '1.0.0', typesFrom: null }])
    // A fresh process (new Deps over the same cache) for another repo locking the same versions.
    const other = setup(reg.fetcher, cache)
    const b = await other.deps.build(repoInfo(makeRepo(files('1.0.0'))), { embed: true })
    expect(b).toMatchObject({ parsed: 0, cached: 2 })
    expect(reg.calls).toHaveLength(2)
    const c = await setup(reg.fetcher, cache).deps.build(repoInfo(makeRepo(files('1.0.0'))), { embed: true })
    expect(c).toMatchObject({ parsed: 0, cached: 2, embedded: 0, missingVectors: 0 })
  })

  it('refuses a tarball whose bytes do not match the lockfile integrity, and stores nothing', async () => {
    const tampered = Buffer.from(V1)
    tampered[20] = (tampered[20] ?? 0) ^ 0xff
    const reg = registry({ [url('lib', '1.0.0')]: tampered })
    const { deps, store } = setup(reg.fetcher)
    const stats = await deps.build(repoInfo(makeRepo(files('1.0.0'))))
    expect(stats.parsed).toBe(1)
    expect(stats.skipped).toHaveLength(1)
    expect(stats.skipped[0]?.reason).toMatch(/lib@1\.0\.0: integrity mismatch/)
    const lock = JSON.parse(files('1.0.0')['package-lock.json']).packages['node_modules/lib']
    expect(store.readIndex(namespaceKey({ name: 'lib', ...lock }))).toBeNull()
  })

  it('refuses a lockfile entry without a sha512 before fetching', async () => {
    const reg = registry()
    const { deps } = setup(reg.fetcher)
    const stats = await deps.build(repoInfo(makeRepo(files('1.0.0', { integrity: 'sha1-abc' }))))
    expect(stats.skipped[0]?.reason).toMatch(/no sha512/)
    expect(reg.calls).not.toContain(url('lib', '1.0.0'))
  })

  it('embeds only the chunks whose text changed between versions', async () => {
    const reg = registry()
    const { deps, embedder } = setup(reg.fetcher)
    const first = await deps.build(repoInfo(makeRepo(files('1.0.0'))), { embed: true })
    expect(first.embedded).toBe(first.chunks)
    const before = embedder.texts
    const second = await deps.build(repoInfo(makeRepo(files('2.0.0'))), { embed: true })
    // parse's declaration and the changelog's sections changed; format, keep and the plain package did not.
    expect(second.embedded).toBe(embedder.texts - before)
    expect(second.embedded).toBeLessThan(second.chunks)
    expect(second.reusedVectors).toBeGreaterThan(0)
  })

  it('finds a declaration by description, labelled with the locked version', async () => {
    const { deps } = setup(registry().fetcher)
    const { hits } = await deps.search(repoInfo(makeRepo(files('2.0.0'))), 'parses a date against a reference date')
    expect(hits[0]).toMatchObject({ package: 'lib', version: '2.0.0', path: 'index.d.ts', name: 'parse' })
  })

  it('gc removes versions no registered lockfile references and forgets repositories that are gone', async () => {
    const reg = registry()
    const { deps, store } = setup(reg.fetcher)
    const kept = makeRepo(files('1.0.0'))
    const gone = makeRepo(files('2.0.0'))
    await deps.build(repoInfo(kept), { embed: true })
    await deps.build(repoInfo(gone), { embed: true })
    expect(store.namespaces().size).toBe(3)
    rmSync(gone, { recursive: true, force: true })
    const r = deps.gc()
    expect(r.removed).toHaveLength(1)
    expect(r.removed[0]).toMatch(/^lib@2\.0\.0-/)
    expect(r.kept).toBe(2)
    expect(r.repos).toBe(1)
    expect(Object.values(store.readRegistry().repos)).toEqual([[realpathSync(kept)]])
    expect(deps.gc().removed).toEqual([])
  })
})

describe('upgrade impact', () => {
  it('diffs the bumped versions and ranks the functions that use them, without embedding', async () => {
    const reg = registry()
    const { deps, embedder } = setup(reg.fetcher)
    const dir = makeRepo({ ...files('1.0.0'), 'src/dates.ts': SRC })
    git(dir, 'branch', 'base')
    for (const [p, c] of Object.entries(files('2.0.0'))) writeFileSync(join(dir, p), c)
    const repo = repoInfo(dir)
    const engine = new Engine(new Store(tempDir('semindex-code-'), 'fake'), async () => embedder)
    await engine.index(repo.root, { embed: false })
    const report = await deps.upgrade(repo, 'base', engine.packageUses(repo.root))
    expect(report.changes).toEqual([
      {
        name: 'lib',
        from: '1.0.0',
        to: '2.0.0',
        types: { before: 'own', after: 'own' },
        added: 0,
        removed: ['gone'],
        changed: 1,
        mentioned: ['parse'],
      },
    ])
    expect(report.functions).toBe(5)
    expect(report.impacts.map((i) => `${i.tier} ${i.name} ${i.symbols.map((s) => `${s.symbol}:${s.status}`)}`)).toEqual(
      ['1 read parse:mentioned', '2 whole gone:removed', '3 show format:used', '3 idle keep:used']
    )
    expect(embedder.calls).toBe(0)
  })
})
