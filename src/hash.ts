import { createHash } from 'node:crypto'

/** The git blob id of some content, computed the way `git hash-object` does without filters. */
export function gitBlobId(content: Buffer | string): string {
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex')
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** Line endings normalized to LF, so a CRLF checkout hashes the same as an LF one. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}
