import { classifyPath, isGeneratedContent, type Lang } from './classify.js'
import { extractCode } from './code.js'
import { extractDocs } from './docs.js'
import type { Chunk } from './types.js'

export { classifyPath, isGeneratedContent, type Lang } from './classify.js'
export type { Chunk } from './types.js'

/**
 * Bump when extraction output changes for the same input. Chunks and vectors are stored under this version,
 * so a bump re-extracts and re-embeds everything, while a model change alone keeps the chunks.
 */
export const EXTRACTOR_VERSION = 3

export interface Extracted {
  /** Set when the content looks generated or minified; such a file has no chunks. */
  generated: boolean
  chunks: Chunk[]
}

export function extract(path: string, content: string, lang: Lang): Extracted {
  if (isGeneratedContent(content)) return { generated: true, chunks: [] }
  if (lang === 'md' || lang === 'mdx') return { generated: false, chunks: extractDocs(path, content) }
  return { generated: false, chunks: extractCode(path, content, lang) }
}
