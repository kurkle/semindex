import ts from 'typescript'
import { normalizeNewlines, sha1 } from '../hash.js'

/** One declaration of a package's types, for API diffing: a name can have several (overloads, merged ones). */
export interface Declaration {
  name: string
  kind: string
  /** Hash of the declaration text with comments and whitespace runs removed. */
  hash: string
}

export interface DeclarationChunk {
  /** Declaration name; `Outer.name` inside a namespace or module, `Type.member` for a member of a large type. */
  name: string
  kind: string
  line: number
  /** The declaration with its JSDoc. */
  text: string
}

/** Declarations longer than this (characters) are also chunked one member at a time, to stay near 512 tokens. */
export const LARGE_DECLARATION_CHARS = 2000

const KIND: [(n: ts.Node) => boolean, string][] = [
  [ts.isFunctionDeclaration, 'function'],
  [ts.isClassDeclaration, 'class'],
  [ts.isInterfaceDeclaration, 'interface'],
  [ts.isTypeAliasDeclaration, 'type'],
  [ts.isEnumDeclaration, 'enum'],
  [ts.isModuleDeclaration, 'namespace'],
  [ts.isVariableStatement, 'variable'],
]

function kindOf(node: ts.Node): string | null {
  for (const [test, kind] of KIND) if (test(node)) return kind
  return null
}

/** The declaration text normalized the way API diffing compares it: no comments, single spaces. */
export function normalizeDeclaration(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Where a node's text starts when its JSDoc is included. */
function startWithJsDoc(node: ts.Node, text: string): number {
  const ranges = ts.getLeadingCommentRanges(text, node.pos) ?? []
  const doc = ranges.filter((r) => text.startsWith('/**', r.pos)).pop()
  return doc ? doc.pos : node.getStart()
}

type Membered = ts.InterfaceDeclaration | ts.ClassDeclaration

/**
 * The declarations of one .d.ts file: every named top-level statement and, recursively, those inside
 * `declare module` and `declare namespace` blocks. Parsed with the TypeScript compiler, never evaluated.
 */
export function extractDeclarations(
  path: string,
  source: string
): { decls: Declaration[]; chunks: DeclarationChunk[] } {
  const text = normalizeNewlines(source)
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const decls: Declaration[] = []
  const chunks: DeclarationChunk[] = []
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1

  const emit = (node: ts.Node, name: string, kind: string, label: string) => {
    const own = node.getText(sf)
    decls.push({ name, kind, hash: sha1(normalizeDeclaration(own)).slice(0, 16) })
    const start = startWithJsDoc(node, text)
    const full = text.slice(start, node.getEnd())
    const members = (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && (node as Membered).members
    if (full.length <= LARGE_DECLARATION_CHARS || !members || members.length < 2) {
      chunks.push({ name: label, kind, line: lineOf(start), text: full })
      return
    }
    const brace = own.indexOf('{')
    const head = brace >= 0 ? own.slice(0, brace + 1) : own
    const names = members.map((m) => (m.name ? m.name.getText(sf) : null)).filter((n): n is string => !!n)
    const summary = `${text.slice(start, node.getStart(sf))}${head}\n  ${names.join(', ')}\n}`
    chunks.push({ name: label, kind, line: lineOf(start), text: summary.slice(0, LARGE_DECLARATION_CHARS) })
    for (const m of members) {
      if (!m.name) continue
      const ms = startWithJsDoc(m, text)
      chunks.push({
        name: `${label}.${m.name.getText(sf)}`,
        kind: 'member',
        line: lineOf(ms),
        text: `${head}\n  ${text.slice(ms, m.getEnd()).trim()}\n}`,
      })
    }
  }

  const visit = (node: ts.Statement, container: string | null) => {
    const label = (n: string) => (container ? `${container}.${n}` : n)
    if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
      const inner = ts.isStringLiteral(node.name) ? node.name.text : node.name.text
      for (const st of node.body.statements) visit(st, label(inner))
      return
    }
    const kind = kindOf(node)
    if (!kind) return
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        const n = d.name.getText(sf)
        emit(node, n, kind, label(n))
      }
      return
    }
    const nameNode = (node as ts.DeclarationStatement).name
    if (nameNode && ts.isIdentifier(nameNode)) emit(node, nameNode.text, kind, label(nameNode.text))
  }
  for (const st of sf.statements) visit(st, null)
  return { decls, chunks }
}
