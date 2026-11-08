import ts from 'typescript'
import { normalizeNewlines, sha1 } from '../hash.js'
import type { Lang } from './classify.js'
import type { Chunk } from './types.js'

const SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  ts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
}

/**
 * The AST as a token stream: identifiers become I, string and template parts S, numbers N, JSX text T,
 * and type annotations and JSDoc comments are dropped. A renamed copy of a function therefore hashes the same.
 */
function normTokens(node: ts.Node, sf: ts.SourceFile, out: string[]): void {
  if (ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node)) return
  if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
  const kids = node.getChildren(sf)
  if (kids.length === 0) {
    const k = node.kind
    if (k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.PrivateIdentifier) out.push('I')
    else if (k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral) out.push('S')
    else if (k >= ts.SyntaxKind.TemplateHead && k <= ts.SyntaxKind.TemplateTail) out.push('S')
    else if (k === ts.SyntaxKind.NumericLiteral || k === ts.SyntaxKind.BigIntLiteral) out.push('N')
    else if (k === ts.SyntaxKind.JsxText) {
      if (node.getText(sf).trim()) out.push('T')
    } else if (k !== ts.SyntaxKind.EndOfFileToken && k !== ts.SyntaxKind.SyntaxList) out.push(ts.SyntaxKind[k])
    return
  }
  for (const c of kids) normTokens(c, sf, out)
}

function propName(name: ts.PropertyName, sf: ts.SourceFile): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)
    ? name.text
    : name.getText(sf)
}

type FunctionLike = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression

/** The name a function is bound to, or null for an anonymous callback. */
function nameOf(node: FunctionLike, sf: ts.SourceFile): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return propName(node.name, sf)
  const p = node.parent
  if (!p) return null
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.initializer === node) return propName(p.name, sf)
  return null
}

function isNamedFunction(node: ts.Node): node is FunctionLike {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return true
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false
  const p = node.parent
  return !!p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))
}

/** The node whose text is the whole declaration: `const f = () => ...` rather than just the arrow. */
function declarationNode(node: FunctionLike): ts.Node {
  const p = node.parent
  if (p && ts.isVariableDeclaration(p)) {
    const list = p.parent
    if (ts.isVariableDeclarationList(list) && list.declarations.length === 1 && ts.isVariableStatement(list.parent)) {
      return list.parent
    }
    return p
  }
  if (p && ts.isPropertyDeclaration(p)) return p
  return node
}

function isExported(decl: ts.Node): boolean {
  const mods = ts.canHaveModifiers(decl) ? ts.getModifiers(decl) : undefined
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

function collectCalls(node: ts.Node, out: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const e = n.expression
      if (ts.isIdentifier(e)) out.add(e.text)
      else if (ts.isPropertyAccessExpression(e)) out.add(e.name.text)
    } else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const t = n.tagName
      if (ts.isIdentifier(t)) out.add(t.text)
      else if (ts.isPropertyAccessExpression(t)) out.add(t.name.text)
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)
}

/** Named functions, methods and arrow functions bound to a name, nested ones included. */
export function extractCode(path: string, source: string, lang: Lang): Chunk[] {
  const text = normalizeNewlines(source)
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, SCRIPT_KIND[lang] ?? ts.ScriptKind.TS)
  const chunks: Chunk[] = []
  const visit = (node: ts.Node): void => {
    if (isNamedFunction(node) && node.body) {
      const name = nameOf(node, sf)
      if (name) {
        const toks: string[] = []
        normTokens(node, sf, toks)
        const decl = declarationNode(node)
        const start = decl.getStart(sf)
        const body = text.slice(start, decl.getEnd())
        const calls = new Set<string>()
        collectCalls(node, calls)
        calls.delete(name)
        chunks.push({
          kind: 'function',
          name,
          line: sf.getLineAndCharacterOfPosition(start).line + 1,
          endLine: sf.getLineAndCharacterOfPosition(decl.getEnd()).line + 1,
          n: toks.length,
          astHash: sha1(toks.join(' ')).slice(0, 16),
          textHash: sha1(body).slice(0, 16),
          calls: [...calls].sort(),
          exported: isExported(decl),
          text: body,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return chunks
}
