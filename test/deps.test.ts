import { describe, expect, it } from 'vitest'
import { extractDeclarations, LARGE_DECLARATION_CHARS } from '../src/deps/declarations.js'
import { sha512Of, verifyIntegrity } from '../src/deps/fetch.js'
import { lockedDeps, packageOfSpecifier, typedModules } from '../src/deps/lockfile.js'
import { indexPackage } from '../src/deps/package.js'
import { namespaceKey } from '../src/deps/store.js'
import { readTarball } from '../src/deps/tar.js'
import { diffApi, rankImpact } from '../src/deps/upgrade.js'
import { integrityOf, makeTarball } from './helpers.js'

const PKG = JSON.stringify({
  dependencies: { 'date-fns': '^4.0.0', local: 'file:../local' },
  devDependencies: { '@types/hast': '^3.0.0', missing: '^1.0.0' },
  peerDependencies: { react: '^19.0.0', 'date-fns': '^4.0.0' },
})

describe('lockedDeps', () => {
  it('reads direct dependencies from a v3 lockfile, workspaces and links without a tarball', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/date-fns': {
          version: '4.1.0',
          resolved: 'https://registry.npmjs.org/date-fns/-/date-fns-4.1.0.tgz',
          integrity: 'sha512-abc',
        },
        'node_modules/@types/hast': { version: '3.0.4', resolved: 'https://r.example/h.tgz', integrity: 'sha512-x' },
        'node_modules/react': { version: '19.1.0', resolved: 'https://r.example/r.tgz', integrity: 'sha512-y' },
        'node_modules/local': { version: '1.0.0', resolved: '../local', link: true },
        'node_modules/date-fns/node_modules/nested': { version: '9.9.9' },
      },
    })
    const deps = lockedDeps(PKG, lock)
    expect(deps.map((d) => [d.name, d.version, d.kind, !!d.resolved])).toEqual([
      ['@types/hast', '3.0.4', 'dev', true],
      ['date-fns', '4.1.0', 'prod', true],
      ['local', '1.0.0', 'prod', false],
      ['react', '19.1.0', 'peer', true],
    ])
    expect(deps.find((d) => d.name === 'date-fns')?.integrity).toBe('sha512-abc')
  })

  it('falls back to the dependencies map of a v1 lockfile', () => {
    const lock = JSON.stringify({
      lockfileVersion: 1,
      dependencies: { 'date-fns': { version: '2.30.0', resolved: 'https://r.example/d.tgz', integrity: 'sha512-z' } },
    })
    expect(lockedDeps(PKG, lock).map((d) => `${d.name}@${d.version}`)).toEqual(['date-fns@2.30.0'])
  })
})

describe('module names', () => {
  it('maps a specifier to its package', () => {
    expect(packageOfSpecifier('date-fns/locale')).toBe('date-fns')
    expect(packageOfSpecifier('@mui/material/Box')).toBe('@mui/material')
  })

  it('maps @types packages to the modules they type', () => {
    expect(typedModules('@types/hast', [])).toEqual(['hast'])
    expect(typedModules('@types/babel__core', [])).toEqual(['@babel/core'])
    expect(typedModules('@types/node', ['fs'])).toEqual(['fs', 'node:fs'])
    expect(typedModules('date-fns', [])).toEqual(['date-fns'])
  })
})

describe('namespaceKey', () => {
  it('differs by integrity and registry for the same name and version', () => {
    const base = { name: '@mui/material', version: '7.0.0', resolved: 'https://registry.npmjs.org/x.tgz' }
    const a = namespaceKey({ ...base, integrity: 'sha512-a' })
    expect(a).toMatch(/^@mui\+material@7\.0\.0-[0-9a-f]{12}$/)
    expect(namespaceKey({ ...base, integrity: 'sha512-b' })).not.toBe(a)
    expect(namespaceKey({ ...base, integrity: 'sha512-a', resolved: 'https://npm.example/x.tgz' })).not.toBe(a)
    expect(namespaceKey({ ...base, integrity: 'sha512-a' })).toBe(a)
  })
})

describe('integrity', () => {
  it('accepts matching bytes and refuses a tampered tarball', () => {
    const tgz = makeTarball({ 'index.d.ts': 'export declare function a(): void\n' })
    const integrity = integrityOf(tgz)
    expect(() => verifyIntegrity(tgz, integrity, 'pkg@1.0.0')).not.toThrow()
    const tampered = Buffer.from(tgz)
    tampered[tampered.length - 9] = (tampered[tampered.length - 9] ?? 0) ^ 1
    expect(() => verifyIntegrity(tampered, integrity, 'pkg@1.0.0')).toThrow(/integrity mismatch/)
  })

  it('refuses a lockfile entry that pins no sha512', () => {
    expect(sha512Of('sha1-abc')).toBeNull()
    expect(sha512Of('sha1-abc sha512-def')).toBe('def')
    expect(() => verifyIntegrity(Buffer.from('x'), 'sha1-abc', 'pkg@1.0.0')).toThrow(/no sha512/)
  })
})

describe('readTarball', () => {
  it('reads kept files under the top folder, pax long names included', () => {
    const long = `dist/${'deep/'.repeat(25)}types.d.ts`
    const tgz = makeTarball({ 'index.d.ts': 'a', 'README.md': '# R', 'lib/code.js': 'x', [long]: 'b' })
    const files = readTarball(tgz, (p) => !p.endsWith('.js'), { maxBytes: 1 << 20, maxFileBytes: 1 << 20 })
    expect(files.map((f) => f.path).sort()).toEqual(['README.md', long, 'index.d.ts'].sort())
    expect(files.find((f) => f.path === long)?.content.toString()).toBe('b')
  })

  it('refuses a tarball that unpacks beyond the limit and skips files over the file limit', () => {
    const tgz = makeTarball({ 'a.d.ts': 'x'.repeat(5000), 'b.d.ts': 'y' })
    expect(() => readTarball(tgz, () => true, { maxBytes: 4096, maxFileBytes: 1 << 20 })).toThrow(/larger than/)
    const files = readTarball(tgz, () => true, { maxBytes: 1 << 20, maxFileBytes: 1000 })
    expect(files.map((f) => f.path)).toEqual(['b.d.ts'])
  })

  it('skips paths that climb out of the package', () => {
    const tgz = makeTarball({ '../evil.d.ts': 'x', 'ok.d.ts': 'y' })
    expect(readTarball(tgz, () => true, { maxBytes: 1 << 20, maxFileBytes: 1 << 20 }).map((f) => f.path)).toEqual([
      'ok.d.ts',
    ])
  })
})

const DTS = `import type { Locale } from './locale'
/**
 * Formats a date.
 * @param date the date
 */
export declare function format(date: Date, pattern: string): string
export declare function format(date: number, pattern: string): string
export declare const version: string, build: number
export interface Options { locale?: Locale }
declare namespace util {
  function helper(): void
}
export {}
`

describe('extractDeclarations', () => {
  it('chunks one declaration at a time with its JSDoc, namespaces included', () => {
    const { decls, chunks } = extractDeclarations('index.d.ts', DTS)
    expect(decls.map((d) => `${d.kind}:${d.name}`)).toEqual([
      'function:format',
      'function:format',
      'variable:version',
      'variable:build',
      'interface:Options',
      'function:helper',
    ])
    expect(chunks[0]?.text.startsWith('/**\n * Formats a date.')).toBe(true)
    expect(chunks[0]?.line).toBe(2)
    expect(chunks.map((c) => c.name)).toContain('util.helper')
  })

  it('hashes declarations without comments or whitespace', () => {
    const a = extractDeclarations('a.d.ts', 'export declare function f(a: string): void')
    const b = extractDeclarations('b.d.ts', '/** doc */\nexport declare function f(a: string):\n    void // trailing')
    const c = extractDeclarations('c.d.ts', 'export declare function f(a: number): void')
    expect(b.decls[0]?.hash).toBe(a.decls[0]?.hash)
    expect(c.decls[0]?.hash).not.toBe(a.decls[0]?.hash)
  })

  it('also chunks a large interface one member at a time', () => {
    const members = Array.from({ length: 80 }, (_, i) => `  /** Member ${i}. */\n  member${i}: string`).join('\n')
    const { decls, chunks } = extractDeclarations('t.d.ts', `export interface Theme {\n${members}\n}`)
    expect(`interface Theme {\n${members}\n}`.length).toBeGreaterThan(LARGE_DECLARATION_CHARS)
    expect(decls).toHaveLength(1)
    expect(chunks[0]?.name).toBe('Theme')
    expect(chunks).toHaveLength(81)
    expect(chunks[5]).toMatchObject({ name: 'Theme.member4', kind: 'member' })
    expect(chunks[5]?.text).toContain('/** Member 4. */')
  })
})

const meta = (version: string) => ({ name: 'lib', version, registry: 'r', integrity: 'sha512-x' })

function pkg(version: string, files: Record<string, string>) {
  return indexPackage(
    meta(version),
    Object.entries(files).map(([path, c]) => ({ path, content: Buffer.from(c) }))
  )
}

describe('indexPackage', () => {
  it('keeps a text shipped twice once, at the shorter path, and says when there are no types', () => {
    const p = pkg('1.0.0', { 'esm/index.d.mts': DTS, 'index.d.ts': DTS, 'README.md': '# lib\n\nUse it.\n' })
    expect(p.types).toBe('own')
    expect(p.files).toEqual({ declarations: 2, docs: 1 })
    expect(p.chunks.filter((c) => c.name === 'Options').map((c) => c.path)).toEqual(['index.d.ts'])
    expect(pkg('1.0.0', { 'README.md': '# lib\n\nNo types.\n' }).types).toBe('none')
  })
})

describe('diffApi', () => {
  it('lists added, removed and changed declarations, and the ones the new changelog lines name', () => {
    const before = pkg('1.0.0', {
      'index.d.ts': `export declare function format(d: Date): string
export declare function parse(s: string): Date
export declare function keep(): void
export declare function gone(): void
export declare function quietlyChanged(a: string): void`,
      'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- First release with format.\n',
    })
    const after = pkg('2.0.0', {
      'index.d.ts': `export declare function format(d: Date, o?: object): string
export declare function parse(s: string, ref: Date): Date
export declare function keep(): void
export declare function added(): void
export declare function quietlyChanged(a: number): void`,
      'CHANGELOG.md':
        '# Changelog\n\n## 2.0.0\n\n- BREAKING: parse needs a reference date; gone is removed.\n\n## 1.0.0\n\n- First release with format.\n',
    })
    expect(diffApi(before, after)).toEqual({
      added: ['added'],
      removed: ['gone'],
      changed: ['format', 'parse', 'quietlyChanged'],
      mentioned: ['gone', 'parse'],
    })
  })
})

describe('rankImpact', () => {
  const diff = { added: [], removed: ['gone'], changed: ['parse', 'format'], mentioned: ['parse'] }
  const bumped = [
    { name: 'lib', modules: ['lib'], diff },
    { name: '@types/other', modules: ['other'], diff: { added: [], removed: [], changed: [], mentioned: [] } },
  ]
  const fn = (name: string, uses: string[]) => ({ path: `src/${name}.ts`, line: 1, name, uses })

  it('puts changelog-named symbols first, then changed or removed ones, then any use; removed first in a tier', () => {
    const impacts = rankImpact(
      [
        fn('usesKeep', ['lib:keep']),
        fn('usesFormat', ['lib/sub:format']),
        fn('usesParse', ['lib:parse']),
        fn('usesGone', ['lib:gone']),
        fn('usesOther', ['other:thing']),
        fn('usesUnrelated', ['react:useState']),
        fn('usesWhole', ['lib:*']),
      ],
      bumped
    )
    expect(impacts.map((i) => `${i.tier}:${i.name}`)).toEqual([
      '1:usesParse',
      '2:usesGone',
      '2:usesFormat',
      '2:usesWhole',
      '3:usesKeep',
      '3:usesOther',
    ])
    expect(impacts[1]).toMatchObject({
      usesRemoved: true,
      symbols: [{ package: 'lib', symbol: 'gone', status: 'removed' }],
    })
  })

  it('without an API diff, a use is tier 3', () => {
    const impacts = rankImpact([fn('a', ['lib:parse'])], [{ name: 'lib', modules: ['lib'], diff: null }])
    expect(impacts.map((i) => i.tier)).toEqual([3])
  })
})
