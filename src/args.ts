import { resolve } from 'node:path'

// Paths go to the server as absolute ones: the server resolves against its own working directory,
// which is wherever the first client started it, often another worktree of the same repo.

/** The directories a command names, or the current one, as absolute paths. */
export function absoluteDirs(args: string[], cwd = process.cwd()): string[] {
  return (args.length ? args : ['.']).map((d) => resolve(cwd, d))
}

/** `<file>[:line]` with the file as an absolute path. */
export function parseFileSpec(spec: string, cwd = process.cwd()): { file: string; line?: number } {
  const m = /^(.*?)(?::(\d+))?$/.exec(spec)
  const file = resolve(cwd, m?.[1] ?? spec)
  return m?.[2] ? { file, line: Number(m[2]) } : { file }
}
