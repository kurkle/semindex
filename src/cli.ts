#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { absoluteDirs, parseFileSpec } from './args.js'
import { call } from './client.js'
import { defaultConfigPath } from './config.js'
import type { DepHit, DepsStats, UpgradeReport } from './deps/deps.js'
import type { HookFinding, IndexStats, Match } from './engine.js'
import { appendEvent, eventsPath, type HookEvent, readEvents, runHook } from './events.js'
import { findingLines, type HookInput, matchPlace } from './hook.js'
import { buildReport, printReport } from './report.js'
import { forget, groupAdd, groupList, groupRemove, type Member } from './repos.js'
import { type Request, serve } from './server.js'
import { type PairRow, type SearchHit, Service } from './service.js'
import { defaultCacheDir } from './store.js'

const HELP = `semindex: local semantic index of code and docs

  semindex index [dir...]            index working trees (default: the current one); the hook acts only in these
  semindex forget [dir]              the hook stops acting in this repository (cached data stays until gc)
  semindex group add <name> <dir...> search these repositories together in the hook, diff and similar
  semindex group remove <name> [dir...]  remove repositories from a group, or the whole group
  semindex group list                groups and their members
  semindex query <text> [-k N]       hybrid search (BM25 + embeddings) for a description
  semindex similar <file>[:line]     functions nearest to the function at that line
  semindex pairs [dir...]            likely copies across one or more repos, cross-folder first
  semindex diff [base]               functions added or changed since the branch left base (default origin/HEAD)
  semindex index --deps [dir...]     parse and embed the locked direct dependencies (--parse-only: no embedding)
  semindex query --deps <text>       hybrid search over the locked dependency versions' declarations and docs
  semindex upgrade [base]            dependency versions changed since base, and the functions to review first
  semindex gc                        remove dependency versions no indexed repo's lockfile references
  semindex serve                     run the resident server (started on demand by the other commands)
  semindex stop                      stop the resident server
  semindex hook                      Claude Code PostToolUse hook: reads the hook JSON on stdin
  semindex report [--since DATE]     what the hook runs logged in events.jsonl did, and what became of each finding
  semindex status                    cache location and size

Options: --package NAME limits --deps to one dependency (repeatable); --json prints JSON.
--local runs in this process instead of the server; --cache DIR (or SEMINDEX_CACHE) sets the cache.
Groups are kept in $XDG_CONFIG_HOME/semindex/config.json (default ~/.config/semindex/config.json).`

const NOT_PROOF = 'No match is not proof that no duplicate exists: the index finds leads, it does not rule copies out.'

async function handle(service: Service, req: Request): Promise<unknown> {
  const p = req.params
  switch (req.method) {
    case 'ping':
      return 'pong'
    case 'index':
      return Promise.all(
        (p.dirs as string[]).map((d) => {
          service.register(d)
          return service.index(d)
        })
      )
    case 'query':
      return service.query(p.dir as string, p.text as string, p.k as number, p.tests as boolean)
    case 'similar':
      return service.similar(p.file as string, p.line as number | undefined, p.k as number, p.config as string)
    case 'diff':
      return service.diff(p.dir as string, p.base as string, p.config as string)
    case 'pairs':
      return service.pairs(p.dirs as string[], p.threshold as number | undefined)
    case 'hook':
      return service.hookFindings(p.input as HookInput, p.config as string)
    case 'index-deps':
      return Promise.all(
        (p.dirs as string[]).map((d) =>
          service.indexDeps(d, { embed: p.embed as boolean, packages: p.packages as string[] | undefined })
        )
      )
    case 'query-deps':
      return service.queryDeps(p.dir as string, p.text as string, p.k as number, p.packages as string[] | undefined)
    case 'upgrade':
      return service.upgrade(p.dir as string, p.base as string)
    case 'gc':
      return service.gc()
    case 'status':
      return service.status()
    default:
      throw new Error(`unknown method ${req.method}`)
  }
}

function printIndex(stats: IndexStats[]): void {
  for (const s of stats) {
    console.log(
      `${s.root}: ${s.files} files, ${s.chunks} chunks; parsed ${s.parsed} blobs, embedded ${s.embedded} chunks, ` +
        `reused ${s.reusedVectors} vectors; ${s.seconds.toFixed(1)} s`
    )
  }
}

function printHits(hits: SearchHit[]): void {
  for (const h of hits)
    console.log(`${h.cosine.toFixed(2)}  ${h.path}:${h.line}  ${h.name}${h.kind === 'doc' ? '  (doc)' : ''}`)
  if (hits.length === 0) console.log('no matches')
  console.log(NOT_PROOF)
}

function printDepsIndex(stats: DepsStats[]): void {
  for (const s of stats) {
    console.log(
      `${s.root}: ${s.packages} direct dependencies, ${s.chunks} chunks; ${s.cached} from the cache, parsed ` +
        `${s.parsed}, embedded ${s.embedded} chunks, reused ${s.reusedVectors} vectors; ${s.seconds.toFixed(1)} s`
    )
    if (s.missingVectors) console.log(`  ${s.missingVectors} packages not embedded yet (index --deps embeds them)`)
    for (const n of s.noTypes) {
      console.log(`  no types of its own: ${n.name}@${n.version}${n.typesFrom ? ` (types from ${n.typesFrom})` : ''}`)
    }
    for (const k of s.skipped) console.log(`  skipped: ${k.reason}`)
  }
}

/** A declaration without its JSDoc, on one line, for a one-line hit. */
function signatureLine(text: string, kind: string): string {
  // A member chunk repeats its type's header; the member is what was found.
  const body = kind === 'member' ? text.slice(text.indexOf('{') + 1).replace(/\}\s*$/, '') : text
  const line = body
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}

function printDepHits(r: { hits: DepHit[]; stats: DepsStats }): void {
  for (const h of r.hits) {
    console.log(
      `${h.cosine === null ? ' bm25' : h.cosine.toFixed(2)}  ${h.package}@${h.version}  ${h.path}:${h.line}  ${h.name}  (${h.kind})`
    )
    if (h.kind !== 'doc') console.log(`      ${signatureLine(h.text, h.kind)}`)
  }
  if (r.hits.length === 0) console.log('no matches')
  if (r.stats.embeddingInBackground) {
    console.log(
      `${r.stats.embeddingInBackground} packages are being embedded in the background; until then their hits ` +
        'come from keyword search alone (marked bm25). index --deps embeds them up front.'
    )
  }
  for (const k of r.stats.skipped) console.log(`skipped: ${k.reason}`)
}

const TIER_TITLE: Record<number, string> = {
  1: 'tier 1: uses a changed or removed declaration that the changelog or docs of the new version name',
  2: 'tier 2: uses a declaration whose type changed or that was removed',
  3: 'tier 3: uses the package',
}

const STATUS_LABEL: Record<string, string> = {
  removed: ' (removed)',
  changed: ' (changed)',
  mentioned: ' (changed, named in the docs)',
  used: '',
}

function printUpgrade(r: UpgradeReport, base: string, limit: number): void {
  const bumps = r.changes.filter((c) => c.from && c.to)
  console.log(`${bumps.length} direct dependencies changed version since ${base} (${r.base.slice(0, 9)})`)
  for (const c of r.changes) {
    if (!c.from || !c.to) {
      console.log(`  ${c.name}: ${c.from ? `${c.from} removed` : `${c.to} added`}`)
      continue
    }
    if (c.error) {
      console.log(`  ${c.name} ${c.from} -> ${c.to}: declarations not compared (${c.error})`)
      continue
    }
    const removed = c.removed ?? []
    const types = c.types?.after === 'none' ? '; no types of its own' : ''
    console.log(
      `  ${c.name} ${c.from} -> ${c.to}: ${c.added} declarations added, ${removed.length} removed, ${c.changed} changed${types}`
    )
    if (removed.length)
      console.log(`    removed: ${removed.slice(0, 20).join(', ')}${removed.length > 20 ? ', ...' : ''}`)
    if (c.mentioned?.length) console.log(`    named in the new docs: ${c.mentioned.slice(0, 20).join(', ')}`)
  }
  console.log(`\n${r.impacts.length} of ${r.functions} production functions use a bumped package.`)
  for (const tier of [1, 2, 3]) {
    const list = r.impacts.filter((i) => i.tier === tier)
    if (list.length === 0) continue
    console.log(`\n${TIER_TITLE[tier]} (${list.length}):`)
    for (const i of list.slice(0, limit)) {
      const syms = i.symbols
        .filter((s) => s.status !== 'used' || tier === 3)
        .map((s) => `${s.package}:${s.symbol}${STATUS_LABEL[s.status]}`)
      console.log(`  ${i.path}:${i.line}  ${i.name}  ${[...new Set(syms)].join(', ')}`)
    }
    if (list.length > limit) console.log(`  ... ${list.length - limit} more (--limit N, or --json)`)
  }
  console.log(
    "\nThis is a ranking of what to review, not a list of what breaks. Type-level breaks are the compiler's job: " +
      'run tsc against the new types.'
  )
}

function printPending(pending: string[]): void {
  if (pending.length === 0) return
  console.log(
    `still being embedded in the background: ${pending.join(', ')}; their functions without vectors are not ` +
      'compared yet (semindex index <dir> embeds them up front)'
  )
}

function printSimilar(r: {
  target: { path: string; line: number; name: string }
  matches: Match[]
  pending: string[]
}): void {
  console.log(`nearest to ${r.target.name} (${r.target.path}:${r.target.line}):`)
  for (const m of r.matches) console.log(`${m.exact ? 'copy' : m.score.toFixed(2)}  ${matchPlace(m)}`)
  printPending(r.pending)
  console.log(NOT_PROOF)
}

function printDiff(
  r: { base: string; checked: number; findings: HookFinding[]; pending: string[] },
  base: string
): void {
  console.log(
    `${r.checked} functions added or changed since ${base} (${r.base.slice(0, 9)}); ${r.findings.length} resemble existing ones`
  )
  for (const line of findingLines(r.findings)) console.log(line)
  printPending(r.pending)
  console.log(`A score is a lead, not a verdict. ${NOT_PROOF}`)
}

function printMembers(members: Member[]): void {
  for (const m of members) {
    const where = m.root ?? `${m.commonDir} (no working tree found)`
    console.log(`  ${m.name}  ${where}${m.indexed ? '' : '  (not indexed: the hook does not act in it)'}`)
  }
}

function side(s: PairRow['a'], multi: boolean): string {
  return `${multi ? `${s.repo}/` : ''}${s.path}:${s.line} ${s.name}`
}

function printPairs(r: { pairs: PairRow[]; exact: PairRow[]; functions: number }, limit: number): void {
  const multi =
    [...r.pairs, ...r.exact].some((p) => p.a.repo !== p.b.repo) || new Set(r.pairs.map((p) => p.a.repo)).size > 1
  console.log(`${r.functions} production functions; ${r.pairs.length} similar pairs, ${r.exact.length} exact copies`)
  if (r.exact.length) {
    console.log('\nexact copies (same code up to names and literals):')
    for (const p of r.exact.slice(0, limit)) console.log(`  ${p.scope}  ${side(p.a, multi)}  <->  ${side(p.b, multi)}`)
  }
  console.log('\nsimilar pairs:')
  for (const p of r.pairs.slice(0, limit)) {
    console.log(`  ${p.score.toFixed(3)} ${p.scope}  ${side(p.a, multi)}  <->  ${side(p.b, multi)}`)
  }
  console.log(`\nA score is a lead, not a verdict. ${NOT_PROOF}`)
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      local: { type: 'boolean' },
      cache: { type: 'string' },
      k: { type: 'string', short: 'k' },
      tests: { type: 'boolean' },
      threshold: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
      deps: { type: 'boolean' },
      'parse-only': { type: 'boolean' },
      since: { type: 'string' },
      package: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [cmd, ...args] = positionals
  const cacheDir = values.cache ?? defaultCacheDir()
  const config = defaultConfigPath()
  if (!cmd || values.help) {
    console.log(HELP)
    return
  }
  if (cmd === 'serve') {
    const service = new Service(cacheDir, (m) => console.error(m))
    await serve(service, (req) => handle(service, req))
    return
  }
  let local: Service | null = null
  const run = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const log = (m: string) => console.error(m)
    if (values.local) {
      local ??= new Service(cacheDir, log)
      return handle(local, { method, params })
    }
    return call(cacheDir, method, params, log)
  }
  const k = values.k ? Number(values.k) : 10
  const out = (v: unknown, print: () => void) => (values.json ? console.log(JSON.stringify(v, null, 1)) : print())
  switch (cmd) {
    case 'hook': {
      // A hook must never get in the way: any failure ends silently with exit 0, and is logged in events.jsonl.
      let pending: { event: HookEvent; started: number } | null = null
      process.once('SIGTERM', () => {
        if (pending) {
          const { event, started } = pending
          event.outcome = 'error'
          event.message = 'killed by SIGTERM'
          event.duration_ms = Math.round(performance.now() - started)
          appendEvent(cacheDir, event)
        }
        process.exit(0)
      })
      let raw = ''
      try {
        raw = readFileSync(0, 'utf8')
      } catch {}
      const { stdout, event } = await runHook(
        raw,
        cacheDir,
        (input) => run('hook', { input, config }),
        (event, started) => {
          pending = { event, started }
        }
      )
      pending = null
      if (event.outcome === 'error') console.error(`semindex hook: ${event.message}`)
      if (stdout) process.stdout.write(`${stdout}\n`)
      return
    }
    case 'report': {
      const since = values.since ? Date.parse(values.since) : undefined
      if (since !== undefined && Number.isNaN(since)) throw new Error(`--since: not a date: ${values.since}`)
      const r = buildReport(readEvents(cacheDir), since)
      out(r, () => printReport(r, eventsPath(cacheDir)))
      return
    }
    case 'index': {
      const dirs = absoluteDirs(args)
      if (values.deps) {
        const r = (await run('index-deps', {
          dirs,
          embed: !values['parse-only'],
          packages: values.package,
        })) as DepsStats[]
        out(r, () => printDepsIndex(r))
        return
      }
      const r = (await run('index', { dirs })) as IndexStats[]
      out(r, () => printIndex(r))
      return
    }
    case 'query': {
      if (values.deps) {
        const r = (await run('query-deps', {
          dir: process.cwd(),
          text: args.join(' '),
          k,
          packages: values.package,
        })) as Parameters<typeof printDepHits>[0]
        out(r, () => printDepHits(r))
        return
      }
      const r = (await run('query', {
        dir: process.cwd(),
        text: args.join(' '),
        k,
        tests: !!values.tests,
      })) as SearchHit[]
      out(r, () => printHits(r))
      return
    }
    case 'similar': {
      const spec = args[0]
      if (!spec) throw new Error('usage: semindex similar <file>[:line]')
      const r = (await run('similar', { ...parseFileSpec(spec), k, config })) as Parameters<typeof printSimilar>[0]
      out(r, () => printSimilar(r))
      return
    }
    case 'diff': {
      const base = args[0] ?? 'origin/HEAD'
      const r = (await run('diff', { dir: process.cwd(), base, config })) as Parameters<typeof printDiff>[0]
      out(r, () => printDiff(r, base))
      return
    }
    case 'upgrade': {
      const base = args[0] ?? 'origin/HEAD'
      const r = (await run('upgrade', { dir: process.cwd(), base })) as UpgradeReport
      out(r, () => printUpgrade(r, base, values.limit ? Number(values.limit) : 25))
      return
    }
    case 'gc': {
      const r = (await run('gc', {})) as { removed: string[]; kept: number; bytes: number; repos: number }
      out(r, () => {
        for (const key of r.removed) console.log(`removed ${key}`)
        console.log(
          `${r.removed.length} package versions removed (${(r.bytes / 1e6).toFixed(1)} MB), ${r.kept} kept; ` +
            `${r.repos} repositories registered`
        )
      })
      return
    }
    case 'pairs': {
      const dirs = absoluteDirs(args)
      const threshold = values.threshold ? Number(values.threshold) : undefined
      const r = (await run('pairs', { dirs, threshold })) as Parameters<typeof printPairs>[0]
      out(r, () => printPairs(r, values.limit ? Number(values.limit) : 40))
      return
    }
    case 'forget': {
      const [dir] = absoluteDirs(args.slice(0, 1))
      const r = forget(cacheDir, config, dir as string)
      out(r, () => {
        console.log(
          r.wasIndexed
            ? `${r.root}: the hook no longer acts in this repository; its cached data stays until gc`
            : `${r.root}: was not indexed`
        )
        if (r.groups.length) console.log(`removed from groups: ${r.groups.join(', ')}`)
      })
      return
    }
    case 'group': {
      const [sub, name = '', ...dirs] = args
      if (sub === 'add') {
        const r = groupAdd(cacheDir, config, name, absoluteDirs(dirs))
        out(r, () => {
          console.log(`group ${name}:`)
          printMembers(r)
        })
      } else if (sub === 'remove') {
        const r = groupRemove(config, name, dirs.length ? absoluteDirs(dirs) : [])
        out(r, () =>
          console.log(r.left ? `group ${name}: ${r.removed.length} removed, ${r.left} left` : `group ${name} removed`)
        )
      } else if (sub === 'list') {
        const r = groupList(cacheDir, config)
        out(r, () => {
          for (const g of r) {
            console.log(`${g.name}:`)
            printMembers(g.members)
          }
          if (r.length === 0) console.log(`no groups in ${config}`)
        })
      } else {
        throw new Error('usage: semindex group add <name> <dir...> | group remove <name> [dir...] | group list')
      }
      return
    }
    case 'status': {
      const r = await run('status', {})
      console.log(JSON.stringify(r, null, 1))
      return
    }
    case 'stop': {
      if (values.local) return
      try {
        await call(cacheDir, 'stop', {}, () => {}, false)
      } catch {}
      return
    }
    default:
      console.error(HELP)
      process.exitCode = 2
  }
}

/** Exits once stdout has drained: a pipe is written asynchronously, and exiting at once cuts long output short. */
function exit(code: number): void {
  process.stdout.write('', () => process.exit(code))
}

main().then(
  () => {
    if (process.argv[2] !== 'serve') exit(Number(process.exitCode ?? 0))
  },
  (e: unknown) => {
    console.error(`semindex: ${e instanceof Error ? e.message : String(e)}`)
    exit(1)
  }
)
