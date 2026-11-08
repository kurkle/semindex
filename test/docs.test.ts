import { describe, expect, it } from 'vitest'
import { extractDocs } from '../src/extract/docs.js'

const MD = `---
title: Guide
---
Intro text before any heading.

# Install

Run the installer.

## macOS

Use brew.

\`\`\`sh
# not a heading
brew install x
\`\`\`

## Linux
## Windows

Use winget.

# Usage
Call it.
`

describe('extractDocs', () => {
  const chunks = extractDocs('docs/guide.md', MD)

  it('makes one chunk per heading section with the heading path as name', () => {
    expect(chunks.map((c) => c.name)).toEqual(['guide.md', 'Install', 'Install > macOS', 'Install > Windows', 'Usage'])
  })

  it('ignores headings inside fenced code and skips sections with only a heading', () => {
    const mac = chunks.find((c) => c.name === 'Install > macOS')
    expect(mac?.text).toContain('# not a heading')
    expect(chunks.some((c) => c.name.includes('Linux'))).toBe(false)
  })

  it('keeps line numbers of the original file, front matter included', () => {
    expect(chunks[0]?.line).toBe(4)
    const install = chunks.find((c) => c.name === 'Install')
    expect(install?.line).toBe(6)
    expect(install?.endLine).toBe(8)
  })

  it('hashes CRLF and LF alike', () => {
    const crlf = extractDocs('docs/guide.md', MD.replace(/\n/g, '\r\n'))
    expect(crlf.map((c) => c.textHash)).toEqual(chunks.map((c) => c.textHash))
  })
})
