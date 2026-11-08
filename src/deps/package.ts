import { extractDocs } from '../extract/docs.js'
import { sha1 } from '../hash.js'
import { type Declaration, extractDeclarations } from './declarations.js'
import type { TarFile } from './tar.js'

export interface DepChunk {
  kind: 'declaration' | 'doc'
  /** Declaration name (`Type.member`, `Namespace.name`) or the heading path of a doc section. */
  name: string
  /** function, class, interface, type, enum, namespace, variable, member; `doc` for a doc section. */
  declKind: string
  /** File inside the package. */
  path: string
  line: number
  text: string
  textHash: string
}

/** Bump when the index of the same tarball would come out different; a bump re-parses every package. */
export const DEPS_EXTRACTOR_VERSION = 1

export interface PackageIndex {
  name: string
  version: string
  registry: string
  integrity: string
  /** `own` when the tarball ships declaration files, `none` when it has no types of its own. */
  types: 'own' | 'none'
  files: { declarations: number; docs: number }
  decls: Declaration[]
  chunks: DepChunk[]
}

export const isDeclarationFile = (p: string): boolean => /\.d\.[cm]?ts$/.test(p)
export const isDocFile = (p: string): boolean => /\.(md|markdown)$/i.test(p)

/** The files of a tarball the index reads: declaration files and Markdown, nothing bundled under node_modules. */
export function keepFile(path: string): boolean {
  return !path.split('/').includes('node_modules') && (isDeclarationFile(path) || isDocFile(path))
}

/**
 * The index of one package version from its tarball's declaration files and Markdown: one chunk per
 * declaration with its JSDoc and one per doc heading section. A chunk text that occurs in several files (the
 * same types shipped as .d.ts and .d.mts, say) is kept once, at the shortest path.
 */
export function indexPackage(
  meta: { name: string; version: string; registry: string; integrity: string },
  files: TarFile[]
): PackageIndex {
  const sorted = [...files].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))
  const decls: Declaration[] = []
  const chunks: DepChunk[] = []
  const seen = new Set<string>()
  const add = (c: Omit<DepChunk, 'textHash'>) => {
    const textHash = sha1(c.kind === 'doc' ? `${c.name}\n\n${c.text}` : c.text).slice(0, 16)
    if (seen.has(textHash)) return
    seen.add(textHash)
    chunks.push({ ...c, textHash })
  }
  let declarationFiles = 0
  let docFiles = 0
  for (const f of sorted) {
    const text = f.content.toString('utf8')
    if (isDeclarationFile(f.path)) {
      declarationFiles++
      const r = extractDeclarations(f.path, text)
      decls.push(...r.decls)
      for (const c of r.chunks)
        add({ kind: 'declaration', name: c.name, declKind: c.kind, path: f.path, line: c.line, text: c.text })
    } else if (isDocFile(f.path)) {
      docFiles++
      for (const c of extractDocs(f.path, text))
        add({ kind: 'doc', name: c.name, declKind: 'doc', path: f.path, line: c.line, text: c.text })
    }
  }
  return {
    ...meta,
    types: declarationFiles > 0 ? 'own' : 'none',
    files: { declarations: declarationFiles, docs: docFiles },
    decls,
    chunks,
  }
}
