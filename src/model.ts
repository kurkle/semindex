import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * CodeRankEmbed (nomic-ai/CodeRankEmbed at revision 3c4b608, MIT) exported to ONNX with torch.onnx (opset 17,
 * fp32, rotary tables built for 2,048 positions before export so any input length up to that traces right).
 * Published as release assets of kurkle/semindex; the download is checked against these hashes.
 */
export const MODEL = {
  id: 'nomic-ai/CodeRankEmbed@3c4b60807d71f79b43f3c4363786d9493691f8b1+onnx-fp32-1',
  slug: 'coderankembed-onnx-fp32-1',
  dims: 768,
  repo: 'kurkle/semindex',
  tag: 'model-coderankembed-onnx-fp32-1',
  files: {
    'model.onnx': 'ff226aa6578acc1ec80c8f5c5259dfe287ad465bd1b0395ea39bba3d557daa2c',
    'tokenizer.json': '91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854',
    'tokenizer_config.json': '7809f768ee3614618b3f1b91dcbfab4f6a9d4b79fb1ad5d17feb65a7c1bb5b7a',
  } as Record<string, string>,
}

export function modelDir(cacheDir: string): string {
  return process.env.SEMINDEX_MODEL_DIR ?? join(cacheDir, 'models', MODEL.slug)
}

export function isModelCached(cacheDir: string): boolean {
  const dir = modelDir(cacheDir)
  return Object.keys(MODEL.files).every((f) => existsSync(join(dir, f)))
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function githubToken(): string | undefined {
  const env = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (env) return env
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/**
 * Downloads the model files from the release once. The repository is private, so the download needs a GitHub
 * token: GH_TOKEN, GITHUB_TOKEN or the gh CLI's login.
 */
export async function ensureModel(cacheDir: string, log: (msg: string) => void = () => {}): Promise<string> {
  const dir = modelDir(cacheDir)
  if (isModelCached(cacheDir)) return dir
  if (process.env.SEMINDEX_MODEL_DIR) throw new Error(`SEMINDEX_MODEL_DIR=${dir} lacks the model files`)
  const token = githubToken()
  if (!token) throw new Error('The model download needs a GitHub token: set GH_TOKEN or log in with `gh auth login`.')
  const headers = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
  const rel = await fetch(`https://api.github.com/repos/${MODEL.repo}/releases/tags/${MODEL.tag}`, { headers })
  if (!rel.ok) throw new Error(`Release ${MODEL.tag} of ${MODEL.repo}: HTTP ${rel.status}`)
  const assets = ((await rel.json()) as { assets: { name: string; url: string }[] }).assets
  mkdirSync(dir, { recursive: true })
  for (const [name, sha] of Object.entries(MODEL.files)) {
    const target = join(dir, name)
    if (existsSync(target)) continue
    const asset = assets.find((a) => a.name === name)
    if (!asset) throw new Error(`Release ${MODEL.tag} has no asset ${name}`)
    log(`semindex: downloading ${name}`)
    const res = await fetch(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' } })
    if (!res.ok || !res.body) throw new Error(`Download of ${name}: HTTP ${res.status}`)
    const part = `${target}.part`
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
    const got = sha256File(part)
    if (got !== sha) {
      rmSync(part)
      throw new Error(`${name}: sha256 ${got} does not match the pinned ${sha}`)
    }
    renameSync(part, target)
  }
  return dir
}
