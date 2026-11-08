import { normalizeNewlines, sha1 } from '../hash.js'
import type { Chunk } from './types.js'

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * One chunk per heading section of a Markdown or MDX file. A section runs from its heading to the next heading
 * of any level; its name is the heading path ("Install > macOS"). Headings inside fenced code do not count.
 * Text before the first heading (front matter excluded) is a section named after the file.
 */
export function extractDocs(path: string, source: string): Chunk[] {
  const lines = normalizeNewlines(source).split('\n')
  let first = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end > 0) first = end + 1
  }
  const sections: { title: string[]; start: number; end: number }[] = []
  const stack: string[] = []
  let current = { title: [path.split('/').pop() ?? path], start: first, end: lines.length }
  let fence: string | null = null
  for (let i = first; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const f = FENCE.exec(line)
    if (f?.[1]) {
      if (fence === null) fence = f[1][0] ?? null
      else if (f[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const h = HEADING.exec(line)
    if (!h?.[1] || !h[2]) continue
    current.end = i
    sections.push(current)
    const level = h[1].length
    stack.length = Math.min(stack.length, level - 1)
    while (stack.length < level - 1) stack.push('')
    stack.push(h[2].trim())
    current = { title: stack.filter(Boolean), start: i, end: lines.length }
  }
  sections.push(current)

  const chunks: Chunk[] = []
  for (const s of sections) {
    const body = lines.slice(s.start, s.end).join('\n').trim()
    const words = body.split(/\s+/).filter(Boolean)
    // A section that is only its heading carries nothing to search for.
    if (words.length === 0 || (HEADING.test(lines[s.start] ?? '') && body.split('\n').length < 2)) continue
    const name = s.title.join(' > ')
    let endLine = s.end
    while (endLine > s.start + 1 && !(lines[endLine - 1] ?? '').trim()) endLine--
    chunks.push({
      kind: 'doc',
      name,
      line: s.start + 1,
      endLine,
      n: words.length,
      astHash: '',
      textHash: sha1(body).slice(0, 16),
      calls: [],
      exported: false,
      text: body,
    })
  }
  return chunks
}
