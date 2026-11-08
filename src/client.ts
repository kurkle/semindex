import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { socketPath } from './server.js'

function attempt(
  path: string,
  method: string,
  params: Record<string, unknown>,
  onLog: (m: string) => void
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path)
    let buf = ''
    let settled = false
    sock.setEncoding('utf8')
    sock.once('connect', () => sock.write(`${JSON.stringify({ method, params })}\n`))
    sock.on('data', (d: string) => {
      buf += d
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)) as { log?: string; result?: unknown; error?: string }
        buf = buf.slice(nl + 1)
        if (msg.log !== undefined) onLog(msg.log)
        else if (msg.error !== undefined) {
          settled = true
          reject(new Error(msg.error))
        } else {
          settled = true
          resolve(msg.result)
        }
        nl = buf.indexOf('\n')
      }
    })
    sock.once('error', (e) => {
      if (!settled) reject(Object.assign(e, { connect: true }))
    })
    sock.once('close', () => {
      if (!settled) reject(new Error('server closed the connection'))
    })
  })
}

/** Starts `semindex serve` detached; its output goes to serve.log in the cache dir. */
function startServer(cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true })
  const log = openSync(join(cacheDir, 'serve.log'), 'a')
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
  const child = spawn(process.execPath, [cli, 'serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, SEMINDEX_CACHE: cacheDir },
  })
  child.unref()
}

/** Calls the resident server, starting it on the first call. */
export async function call(
  cacheDir: string,
  method: string,
  params: Record<string, unknown>,
  onLog: (m: string) => void = () => {},
  start = true
): Promise<unknown> {
  const path = socketPath(cacheDir)
  try {
    return await attempt(path, method, params, onLog)
  } catch (e) {
    if (!(e as { connect?: boolean }).connect || !start) throw e
  }
  startServer(cacheDir)
  const deadline = Date.now() + 30_000
  for (;;) {
    await new Promise((r) => setTimeout(r, 100))
    try {
      return await attempt(path, method, params, onLog)
    } catch (e) {
      if (!(e as { connect?: boolean }).connect || Date.now() > deadline) throw e
    }
  }
}
