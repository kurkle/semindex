import { readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addToGroup,
  defaultConfigPath,
  groupPeers,
  readConfig,
  removeEverywhere,
  removeFromGroup,
  writeConfig,
} from '../src/config.js'
import type { Embedder } from '../src/embed.js'
import { Engine } from '../src/engine.js'
import { repoOf } from '../src/git.js'
import { formatFindings } from '../src/hook.js'
import { Registry } from '../src/registry.js'
import { forget, groupAdd, groupList, groupRemove } from '../src/repos.js'
import { hookApplies, Service } from '../src/service.js'
import { Store, writeAtomic } from '../src/store.js'
import { FakeEmbedder, git, makeRepo, tempDir, writeFiles } from './helpers.js'

const PLACES = `export function distributePlacesAmongClasses(total: number, classes: { name: string; places: number }[]) {
  const share = Math.floor(total / classes.length)
  let left = total - share * classes.length
  return classes.map((c) => {
    const extra = left > 0 ? 1 : 0
    left -= extra
    return { name: c.name, places: share + extra }
  })
}
`

const EMAIL = `export function registrationEmails(registration: { owner: { email: string }; handler: { email: string } }) {
  const emails = new Set([registration.owner.email, registration.handler.email])
  return [...emails].filter((email) => email.includes('@')).map((email) => email.toLowerCase())
}
`

const copyOf = (name: string) => PLACES.replace('distributePlacesAmongClasses', name)

/** Every file under a directory with its size and mtime, to show that nothing was written. */
function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(`${p} ${statSync(p).size} ${statSync(p).mtimeMs}`)
    }
  }
  walk(dir)
  return out.sort()
}

const edit = (file: string) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Write',
  tool_input: { file_path: file },
})

function common(dir: string): string {
  const r = repoOf(dir)
  if (!r) throw new Error('no repo')
  return r.commonDir
}

async function idle(service: Service): Promise<void> {
  while (service.busy()) await new Promise((r) => setTimeout(r, 10))
}

function setup() {
  const cache = tempDir('semindex-cache-')
  const config = join(tempDir('semindex-config-'), 'semindex', 'config.json')
  const embedder = new FakeEmbedder()
  const service = new Service(
    cache,
    () => {},
    async () => embedder
  )
  return { cache, config, embedder, service }
}

describe('Registry', () => {
  it('opts a repository in, keeps its roots, and forgets it again', () => {
    const reg = new Registry(tempDir('semindex-cache-'))
    expect(reg.isIndexed('/r/.git')).toBe(false)
    reg.add('/r/.git', '/r')
    expect(reg.isIndexed('/r/.git')).toBe(false)
    reg.add('/r/.git', '/wt', { indexed: true })
    reg.add('/r/.git', '/r')
    expect(reg.read()).toEqual({ '/r/.git': { roots: ['/r', '/wt'], indexed: true } })
    expect(reg.forget('/r/.git')).toBe(true)
    expect(reg.forget('/r/.git')).toBe(false)
    expect(reg.read()).toEqual({ '/r/.git': { roots: ['/r', '/wt'] } })
  })

  it('reads the dependency registry it replaced', () => {
    const cache = tempDir('semindex-cache-')
    writeAtomic(join(cache, 'v1', 'deps', 'repos.json'), JSON.stringify({ repos: { '/r/.git': ['/r'] } }))
    const reg = new Registry(cache)
    expect(reg.read()).toEqual({ '/r/.git': { roots: ['/r'] } })
    reg.add('/s/.git', '/s', { indexed: true })
    expect(readdirSync(join(cache, 'v1', 'deps'))).toEqual([])
    expect(Object.keys(reg.read()).sort()).toEqual(['/r/.git', '/s/.git'])
  })
})

describe('hook opt-in', () => {
  it('does nothing in a repository never indexed, and writes nothing to the cache', async () => {
    const { cache, embedder, service } = setup()
    const repo = realpathSync(makeRepo({ 'src/lib/places.ts': PLACES }))
    writeFiles(repo, { 'src/pages/day.ts': copyOf('splitPlacesPerDay') })
    const before = snapshot(cache)
    expect(hookApplies(edit(join(repo, 'src/pages/day.ts')), cache)).toBe(false)
    expect(await service.hook(edit(join(repo, 'src/pages/day.ts')))).toBe('')
    await idle(service)
    expect(snapshot(cache)).toEqual(before)
    expect(embedder.texts).toBe(0)
    expect(service.engine.hasView(repo)).toBe(false)
  })

  it('acts after the repository is indexed, in every worktree of it, until it is forgotten', async () => {
    const { cache, config, service } = setup()
    const repo = realpathSync(makeRepo({ 'src/lib/places.ts': PLACES }))
    service.register(repo)
    await service.index(repo)
    writeFiles(repo, { 'src/pages/day.ts': copyOf('splitPlacesPerDay') })
    expect(hookApplies(edit(join(repo, 'src/pages/day.ts')), cache)).toBe(true)
    expect(await service.hook(edit(join(repo, 'src/pages/day.ts')), config)).toContain('distributePlacesAmongClasses')

    const wt = join(tempDir('semindex-wt-'), 'second')
    git(repo, 'worktree', 'add', '-q', '-b', 'task', wt)
    writeFiles(wt, { 'src/pages/week.ts': copyOf('splitPlacesPerWeek') })
    const inWorktree = edit(join(realpathSync(wt), 'src/pages/week.ts'))
    expect(hookApplies(inWorktree, cache)).toBe(true)
    expect(await service.hook(inWorktree, config)).toContain('distributePlacesAmongClasses')
    await idle(service)

    expect(forget(cache, config, wt)).toEqual({ root: realpathSync(wt), wasIndexed: true, groups: [] })
    writeFiles(wt, { 'src/pages/month.ts': copyOf('splitPlacesPerMonth') })
    expect(hookApplies(edit(join(realpathSync(wt), 'src/pages/month.ts')), cache)).toBe(false)
    expect(await service.hook(edit(join(realpathSync(wt), 'src/pages/month.ts')), config)).toBe('')
  })
})

describe('group config', () => {
  it('adds, removes and resolves members by git common dir', () => {
    let c = addToGroup({ groups: {} }, 'charts', ['/b/.git', '/a/.git'])
    c = addToGroup(c, 'charts', ['/a/.git', '/c/.git'])
    c = addToGroup(c, 'colors', ['/c/.git', '/d/.git'])
    expect(c.groups).toEqual({ charts: ['/a/.git', '/b/.git', '/c/.git'], colors: ['/c/.git', '/d/.git'] })
    expect(groupPeers(c, '/c/.git')).toEqual(['/a/.git', '/b/.git', '/d/.git'])
    expect(groupPeers(c, '/x/.git')).toEqual([])
    expect(removeFromGroup(c, 'charts', ['/a/.git']).groups.charts).toEqual(['/b/.git', '/c/.git'])
    expect(removeFromGroup(c, 'charts').groups.charts).toBeUndefined()
    const { config, left } = removeEverywhere(c, '/c/.git')
    expect(left).toEqual(['charts', 'colors'])
    expect(config.groups).toEqual({ charts: ['/a/.git', '/b/.git'], colors: ['/d/.git'] })
  })

  it('lives in $XDG_CONFIG_HOME/semindex/config.json', () => {
    const saved = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-test'
    try {
      expect(defaultConfigPath()).toBe('/tmp/xdg-test/semindex/config.json')
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = saved
    }
  })

  it('stores a worktree as its repository, registers members as indexed, and keeps other keys', () => {
    const { cache, config } = setup()
    const a = realpathSync(makeRepo({ 'a.ts': EMAIL }))
    const b = realpathSync(makeRepo({ 'b.ts': PLACES }))
    const wt = join(tempDir('semindex-wt-'), 'second')
    git(a, 'worktree', 'add', '-q', '-b', 'task', wt)
    writeConfig(config, { groups: {}, other: true } as never)
    const members = groupAdd(cache, config, 'pair', [wt, b])
    expect(members.map((m) => m.root).sort()).toEqual([a, b].sort())
    expect(members.every((m) => m.indexed)).toBe(true)
    expect(readConfig(config)).toEqual({ other: true, groups: { pair: [common(a), common(b)].sort() } })
    expect(new Registry(cache).isIndexed(common(wt))).toBe(true)
    expect(groupList(cache, config)).toEqual([{ name: 'pair', members }])

    expect(groupRemove(config, 'pair', [b])).toEqual({ removed: [common(b)], left: 1 })
    expect(forget(cache, config, a).groups).toEqual(['pair'])
    expect(readConfig(config).groups).toEqual({})
  })
})

/** Vectors chosen by a marker word in the text: `alpha` along one axis, `beta` at cosine 0.77 to it. */
class MarkerEmbedder implements Embedder {
  readonly dims = 768
  async embed(texts: string[]): Promise<Float32Array[][]> {
    return texts.map((t) => {
      const v = new Float32Array(768)
      if (t.includes('alpha')) v[0] = 1
      else if (t.includes('beta')) {
        v[0] = 0.77
        v[1] = Math.sqrt(1 - 0.77 * 0.77)
      } else v[2] = 1
      return [v]
    })
  }
}

const marked = (name: string, marker: string, extra = '') => `export function ${name}(items: number[], limit: number) {
  const ${marker} = items.filter((item) => item > limit)${extra}
  const total = ${marker}.reduce((sum, item) => sum + item, 0)
  return { count: ${marker}.length, total, average: ${marker}.length ? total / ${marker}.length : 0 }
}
`

describe('cross-repo matches', () => {
  it('names the other repository and holds it to the other-folder threshold', async () => {
    const engine = new Engine(new Store(tempDir('semindex-cache-'), 'fake'), async () => new MarkerEmbedder())
    const own = realpathSync(
      makeRepo({
        'src/lib/near.ts': marked('nearSameFolder', 'beta', '.map((x) => x * 2)'),
        'src/other/near.ts': marked('nearOtherFolder', 'beta', '.map((x) => x * 3)'),
      })
    )
    const peer = realpathSync(
      makeRepo({
        'src/lib/near.ts': marked('nearInPeer', 'beta', '.map((x) => x * 4)'),
        'src/lib/copy.ts': marked('copyInPeer', 'alpha', '.map((x) => x + 1).map((x) => x - 1)'),
      })
    )
    await engine.index(own)
    await engine.index(peer)
    writeFiles(own, { 'src/lib/new.ts': marked('written', 'alpha', '.map((x) => x + 1).map((x) => x - 1)') })
    const peers = [{ root: peer, label: basename(peer) }]
    const findings = await engine.hookCheck(own, 'src/lib/new.ts', peers)
    expect(findings).toHaveLength(1)
    const matches = findings[0]?.matches ?? []
    // 0.77 passes the other-folder threshold (0.75) but not the same-folder one (0.80): the peer's function in
    // a folder of the same name counts as another folder; the own repo's same-folder one does not pass.
    const rows = matches.map((m) => [m.name, m.repo, m.sameFolder, m.exact])
    expect(rows.sort()).toEqual([
      ['copyInPeer', basename(peer), false, true],
      ['nearInPeer', basename(peer), false, false],
      ['nearOtherFolder', undefined, false, false],
    ])
    expect(matches.find((m) => m.name === 'nearInPeer')?.score).toBeCloseTo(0.77, 2)
    const text = formatFindings(findings)
    expect(text).toContain(`  exact copy  ${basename(peer)}/src/lib/copy.ts:1  copyInPeer  (other repo)`)
    expect(text).toContain('  0.77  src/other/near.ts:1  nearOtherFolder  (other folder)')
  })

  it('does not take a function in another repo with the same path and name for the function itself', async () => {
    const engine = new Engine(new Store(tempDir('semindex-cache-'), 'fake'), async () => new FakeEmbedder())
    const own = realpathSync(makeRepo({ 'src/lib/places.ts': PLACES }))
    const peer = realpathSync(makeRepo({ 'src/lib/places.ts': PLACES }))
    await engine.index(own)
    await engine.index(peer)
    const target = engine.functionAt(own, 'src/lib/places.ts')
    if (!target) throw new Error('no function')
    const matches = engine.nearest(own, target, 5, [{ root: peer, label: 'peer' }])
    expect(matches).toMatchObject([{ repo: 'peer', name: 'distributePlacesAmongClasses', exact: true }])
  })

  it('the hook and diff search the other members of a group, loaded from the cache without waiting', async () => {
    const { cache, config } = setup()
    // Embeds the function just written at once and everything else only after `open()`.
    const fake = new FakeEmbedder()
    let open = () => {}
    const gate = new Promise<void>((r) => {
      open = r
    })
    const service = new Service(
      cache,
      () => {},
      async () => ({
        dims: 768,
        embed: async (texts: string[]) => {
          if (!texts.every((t) => t.includes('splitPlaces'))) await gate
          return fake.embed(texts)
        },
      })
    )
    const a = realpathSync(makeRepo({ 'src/lib/places.ts': PLACES }))
    const b = realpathSync(makeRepo({ 'src/mail/email.ts': EMAIL }))
    groupAdd(cache, config, 'pair', [a, b])
    // Never embedded: the first hook call answers while both repositories wait for embedding.
    writeFiles(b, { 'src/pages/day.ts': copyOf('splitPlacesPerDay') })
    expect(await service.hook(edit(join(b, 'src/pages/day.ts')), config)).toBe('')
    expect(service.busy()).toBe(true)
    open()
    await idle(service)
    writeFiles(b, { 'src/pages/week.ts': copyOf('splitPlacesPerWeek') })
    const out = await service.hook(edit(join(b, 'src/pages/week.ts')), config)
    expect(out).toContain(`exact copy  ${basename(a)}/src/lib/places.ts:1  distributePlacesAmongClasses  (other repo)`)

    git(b, 'checkout', '-q', '-b', 'task')
    git(b, 'add', '-A')
    git(b, 'commit', '-q', '-m', 'copies')
    const diff = await service.diff(b, 'main', config)
    expect(diff.checked).toBe(2)
    for (const f of diff.findings) expect(f.matches.map((m) => m.repo)).toContain(basename(a))
    expect(diff.findings).toHaveLength(2)
    expect(diff.pending).toEqual([])

    const sim = await service.similar(join(b, 'src/pages/day.ts'), undefined, 3, config)
    expect(sim.matches.map((m) => [m.repo, m.name])).toContainEqual([basename(a), 'distributePlacesAmongClasses'])
    await idle(service)
  })

  it('pairs without arguments stays within the repository', async () => {
    const { cache, config, service } = setup()
    const a = realpathSync(makeRepo({ 'src/lib/places.ts': PLACES }))
    const b = realpathSync(makeRepo({ 'src/mail/email.ts': EMAIL, 'src/pages/day.ts': copyOf('splitPlacesPerDay') }))
    groupAdd(cache, config, 'pair', [a, b])
    const r = await service.pairs([b])
    expect(r.exact).toEqual([])
    expect(r.functions).toBe(2)
  })
})
