import { appendFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine.js'
import { Store } from '../src/store.js'
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

function setup() {
  const repo = makeRepo({
    'src/lib/places.ts': PLACES,
    'src/lambda/email.ts': EMAIL,
    'src/lib/places.test.ts': `export function testHelper() { return 1 }\n`,
    'docs/guide.md': '# Places\n\nHow places are split among classes.\n',
  })
  const embedder = new FakeEmbedder()
  const engine = new Engine(new Store(tempDir('semindex-cache-'), 'fake'), async () => embedder)
  return { repo: realpathSync(repo), embedder, engine }
}

describe('Engine.index', () => {
  it('parses and embeds each blob once, and nothing on a second run', async () => {
    const { repo, embedder, engine } = setup()
    const first = await engine.index(repo)
    expect(first.files).toBe(4)
    expect(first.parsed).toBe(4)
    expect(first.embedded).toBe(4)
    const second = await engine.index(repo)
    expect(second.parsed).toBe(0)
    expect(second.embedded).toBe(0)
    expect(embedder.texts).toBe(4)
  })

  it('re-parses only the touched file and re-embeds only its changed function', async () => {
    const { repo, embedder, engine } = setup()
    await engine.index(repo)
    appendFileSync(join(repo, 'src/lib/places.ts'), '\nexport function extra(n: number) { return n * 2 }\n')
    const stats = await engine.index(repo)
    expect(stats.parsed).toBe(1)
    expect(stats.embedded).toBe(1)
    expect(stats.reusedVectors).toBe(1)
    expect(embedder.texts).toBe(5)
  })

  it('reuses the cache from a second worktree of the same repository', async () => {
    const { repo, embedder, engine } = setup()
    await engine.index(repo)
    const wt = join(tempDir('semindex-wt-'), 'second')
    git(repo, 'worktree', 'add', '-q', '-b', 'task', wt)
    // a fresh engine over the same cache dir: only the store is shared, as with a restarted server
    const fresh = new Engine(engine.store, async () => embedder)
    const stats = await fresh.index(wt)
    expect(stats.root).toBe(realpathSync(wt))
    expect(stats.files).toBe(4)
    expect(stats.parsed).toBe(0)
    expect(stats.embedded).toBe(0)
    expect(embedder.texts).toBe(4)
  })

  it('never writes into the indexed working tree', async () => {
    const { repo, engine } = setup()
    await engine.index(repo)
    expect(git(repo, 'status', '--porcelain', '--ignored')).toBe('')
  })
})

describe('Engine.diffCheck', () => {
  it('checks the functions a branch adds and lists the existing one a copy resembles', async () => {
    const { repo, engine } = setup()
    git(repo, 'checkout', '-q', '-b', 'task')
    writeFiles(repo, { 'src/pages/day.ts': PLACES.replace('distributePlacesAmongClasses', 'splitPlacesPerDay') })
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'copy')
    await engine.index(repo)
    const r = engine.diffCheck(repo, 'main')
    expect(r.checked).toBe(1)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ path: 'src/pages/day.ts', name: 'splitPlacesPerDay' })
    expect(r.findings[0]?.matches[0]).toMatchObject({ name: 'distributePlacesAmongClasses', exact: true })
  })

  it('skips functions the base already had, also in a changed file, and counts dirty files', async () => {
    const { repo, engine } = setup()
    appendFileSync(join(repo, 'src/lib/places.ts'), '\nexport const unrelated = 1\n')
    writeFiles(repo, { 'src/pages/day.ts': PLACES.replace('distributePlacesAmongClasses', 'splitPlacesPerDay') })
    await engine.index(repo)
    const r = engine.diffCheck(repo, 'HEAD')
    expect(r.checked).toBe(1)
    expect(r.findings.map((f) => f.name)).toEqual(['splitPlacesPerDay'])
  })
})

describe('Engine.hookCheck', () => {
  it('lists the existing function a new copy resembles, and stays silent for an unrelated one', async () => {
    const { repo, engine } = setup()
    await engine.index(repo)
    const copy = PLACES.replace('distributePlacesAmongClasses', 'splitPlacesPerDay')
    writeFiles(repo, { 'src/pages/day.ts': copy })
    const findings = await engine.hookCheck(repo, 'src/pages/day.ts')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.name).toBe('splitPlacesPerDay')
    expect(findings[0]?.matches[0]).toMatchObject({
      path: 'src/lib/places.ts',
      name: 'distributePlacesAmongClasses',
      sameFolder: false,
      exact: true,
    })

    writeFiles(repo, {
      'src/pages/other.ts': `export function weatherForecast(city: string, days: number) {
  const url = 'https://weather.example/' + encodeURIComponent(city) + '?days=' + days
  return fetch(url).then((response) => response.json()).then((json) => json.forecast)
}
`,
    })
    expect(await engine.hookCheck(repo, 'src/pages/other.ts')).toEqual([])
  })

  it('reports only functions that are new or changed since the last look at the file', async () => {
    const { repo, engine } = setup()
    await engine.index(repo)
    const copy = PLACES.replace('distributePlacesAmongClasses', 'splitPlacesPerDay')
    writeFiles(repo, { 'src/pages/day.ts': copy })
    expect(await engine.hookCheck(repo, 'src/pages/day.ts')).toHaveLength(1)
    appendFileSync(join(repo, 'src/pages/day.ts'), '\nexport const unrelated = 1\n')
    expect(await engine.hookCheck(repo, 'src/pages/day.ts')).toEqual([])
  })

  it('does not match a function with the function that calls it', async () => {
    const { repo, engine } = setup()
    await engine.index(repo)
    const wrapper = PLACES.replace('distributePlacesAmongClasses', 'placesWrapper').replace(
      'const share',
      'distributePlacesAmongClasses(total, classes)\n  const share'
    )
    writeFiles(repo, { 'src/pages/wrap.ts': wrapper })
    expect(await engine.hookCheck(repo, 'src/pages/wrap.ts')).toEqual([])
  })

  it('skips test files', async () => {
    const { repo, engine } = setup()
    await engine.index(repo)
    writeFileSync(join(repo, 'src/lib/copy.test.ts'), PLACES.replace('distributePlacesAmongClasses', 'copy'))
    expect(await engine.hookCheck(repo, 'src/lib/copy.test.ts')).toEqual([])
  })
})
