import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IDLE_TIMEOUT_MS } from './constants.js'
import type { Service } from './service.js'

/** Unix socket paths are limited to about 104 bytes; a long cache path gets a socket in the temp dir instead. */
export function socketPath(cacheDir: string): string {
  const p = join(cacheDir, 'serve.sock')
  if (Buffer.byteLength(p) < 100) return p
  const h = createHash('sha1').update(cacheDir).digest('hex').slice(0, 12)
  return join(tmpdir(), `semindex-${h}.sock`)
}

export interface Request {
  method: string
  params: Record<string, unknown>
}

export type Handler = (req: Request, log: (msg: string) => void) => Promise<unknown>

function canConnect(path: string): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection(path)
    s.once('connect', () => {
      s.end()
      res(true)
    })
    s.once('error', () => res(false))
  })
}

/**
 * Serves one JSON request per connection over a unix socket: the client writes one line, the server answers
 * with zero or more {"log"} lines and one {"result"} or {"error"} line. Exits after IDLE_TIMEOUT_MS idle.
 */
export async function serve(service: Service, handler: Handler, idleMs = IDLE_TIMEOUT_MS): Promise<void> {
  mkdirSync(service.cacheDir, { recursive: true })
  const path = socketPath(service.cacheDir)
  if (existsSync(path)) {
    if (await canConnect(path)) return // another server is already running
    unlinkSync(path)
  }
  let active = 0
  let timer: NodeJS.Timeout | undefined
  const server = createServer((sock: Socket) => {
    active++
    clearTimeout(timer)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', async (d: string) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      buf = ''
      const send = (o: unknown) => {
        if (!sock.destroyed) sock.write(`${JSON.stringify(o)}\n`)
      }
      try {
        const req = JSON.parse(line) as Request
        if (req.method === 'stop') {
          send({ result: 'stopping' })
          sock.end()
          shutdown()
          return
        }
        const result = await handler(req, (msg) => send({ log: msg }))
        send({ result })
      } catch (e) {
        send({ error: e instanceof Error ? e.message : String(e) })
      }
      sock.end()
    })
    sock.on('close', () => {
      active--
      arm()
    })
    sock.on('error', () => {})
  })
  const arm = () => {
    clearTimeout(timer)
    if (active === 0) timer = setTimeout(shutdown, idleMs)
  }
  const shutdown = () => {
    server.close()
    try {
      unlinkSync(path)
    } catch {}
    setTimeout(() => process.exit(0), 50).unref()
  }
  await new Promise<void>((res, rej) => {
    server.once('error', rej)
    server.listen(path, () => res())
  })
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  arm()
}
