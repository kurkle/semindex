#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { absoluteDirs, parseFileSpec } from './args.js'
import { call } from './client.js'
import type { IndexStats, Match } from './engine.js'
import type { HookInput } from './hook.js'
import { type Request, serve } from './server.js'
import { type PairRow, type SearchHit, Service } from './service.js'
import { defaultCacheDir } from './store.js'

const HELP = `semindex: local semantic index of code and docs

  semindex index [dir...]            index working trees (default: the current one)
  semindex query <text> [-k N]       hybrid search (BM25 + embeddings) for a description
  semindex similar <file>[:line]     functions nearest to the function at that line
  semindex pairs [dir...]            likely copies across one or more repos, cross-folder first
  semindex serve                     run the resident server (started on demand by the other commands)
  semindex stop                      stop the resident server
  semindex hook                      Claude Code PostToolUse hook: reads the hook JSON on stdin
  semindex status                    cache location and size

Options: --local runs in this process instead of the server; --cache DIR (or SEMINDEX_CACHE) sets the cache.`

const NOT_PROOF = 'No match is not proof that no duplicate exists: the index finds leads, it does not rule copies out.'

async function handle(service: Service, req: Request): Promise<unknown> {
  const p = req.params
  switch (req.method) {
    case 'ping':
      return 'pong'
    case 'index':
      return Promise.all((p.dirs as string[]).map((d) => service.index(d)))
    case 'query':
      return service.query(p.dir as string, p.text as string, p.k as number, p.tests as boolean)
    case 'similar':
      return service.similar(p.file as string, p.line as number | undefined, p.k as number)
    case 'pairs':
      return service.pairs(p.dirs as string[], p.threshold as number | undefined)
    case 'hook':
      return service.hook(p.input as HookInput)
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

function printSimilar(r: { target: { path: string; line: number; name: string }; matches: Match[] }): void {
  console.log(`nearest to ${r.target.name} (${r.target.path}:${r.target.line}):`)
  for (const m of r.matches) {
    const tag = m.exact ? 'copy' : m.score.toFixed(2)
    console.log(`${tag}  ${m.path}:${m.line}  ${m.name}  (${m.sameFolder ? 'same folder' : 'other folder'})`)
  }
  console.log(NOT_PROOF)
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
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [cmd, ...args] = positionals
  const cacheDir = values.cache ?? defaultCacheDir()
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
      // A hook must never get in the way: any failure ends silently with exit 0.
      try {
        const input = JSON.parse(readFileSync(0, 'utf8')) as HookInput
        const text = (await run('hook', { input })) as string
        if (text) process.stdout.write(`${text}\n`)
      } catch (e) {
        console.error(`semindex hook: ${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    case 'index': {
      const dirs = absoluteDirs(args)
      const r = (await run('index', { dirs })) as IndexStats[]
      out(r, () => printIndex(r))
      return
    }
    case 'query': {
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
      const r = (await run('similar', { ...parseFileSpec(spec), k })) as Parameters<typeof printSimilar>[0]
      out(r, () => printSimilar(r))
      return
    }
    case 'pairs': {
      const dirs = absoluteDirs(args)
      const threshold = values.threshold ? Number(values.threshold) : undefined
      const r = (await run('pairs', { dirs, threshold })) as Parameters<typeof printPairs>[0]
      out(r, () => printPairs(r, values.limit ? Number(values.limit) : 40))
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

main().then(
  () => {
    if (process.argv[2] !== 'serve') process.exit(process.exitCode ?? 0)
  },
  (e: unknown) => {
    console.error(`semindex: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
)
