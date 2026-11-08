export interface Chunk {
  kind: 'function' | 'doc'
  /** Function name, or the heading path of a doc section ("Install > macOS"). */
  name: string
  /** 1-based first and last line in the file. */
  line: number
  endLine: number
  /** AST tokens for a function (identifiers and literals counted once each), words for a doc section. */
  n: number
  /** Hash of the AST token stream with identifiers and literals normalized; empty for docs. */
  astHash: string
  /** Hash of the text that gets embedded. */
  textHash: string
  /** Names this function calls or renders (JSX), for the caller/callee filter. */
  calls: string[]
  exported: boolean
  text: string
}
