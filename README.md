# semindex

Local semantic index of code and docs for my own repos. It finds functions that do the same job as the one you
just wrote, likely copies across folders and repos, and code or docs matching a description. Everything runs on
this machine; nothing is uploaded. Dependency versions are a later step.

- **Code**: functions, methods and arrow functions bound to a name, from `.ts`, `.tsx`, `.js`, `.jsx` (TypeScript
  compiler API), each with an AST hash that ignores names, literals, types and JSDoc. Tests and mocks are indexed
  but kept out of production comparisons; generated and vendored files are skipped.
- **Docs**: Markdown and MDX, one chunk per heading section.
- **Embeddings**: CodeRankEmbed (137M parameters, MIT) through ONNX Runtime on the CPU. Search is hybrid: BM25
  and embedding cosine fused by reciprocal rank.
- **Cache**: outside the working copy, in `~/.cache/semindex` (or `$SEMINDEX_CACHE`), keyed by git blob id. A
  commit's view is `git ls-tree` plus the dirty files, so another branch or another worktree of the same repo
  reuses everything already embedded, and an edit re-embeds only the functions whose text changed.

## Install

Node 24 or later.

```sh
git clone git@github.com:kurkle/semindex.git
cd semindex
npm ci            # also builds dist/
npm link          # puts `semindex` on PATH
```

The model (548 MB) downloads on first use from this repository's release
`model-coderankembed-onnx-fp32-1` and is checked against pinned sha256 hashes. The repository is private, so the
download needs a GitHub token: `GH_TOKEN`, `GITHUB_TOKEN` or a `gh auth login`. `SEMINDEX_MODEL_DIR` points at
an already downloaded copy instead.

## Use

```sh
semindex index ~/code/myrepo           # first run embeds everything (koekalenteri: about 10 minutes)
semindex query "split places evenly among classes"
semindex similar src/lib/places.ts:73  # nearest functions to the one at that line
semindex pairs                         # likely copies in the current repo, cross-folder first
semindex pairs ../repo-a ../repo-b     # across repos, cross-repo first
semindex status                        # cache location and size
```

The commands talk to a resident server (`semindex serve`) that keeps the model and indexes in memory behind a
unix socket in the cache dir. The first command starts it; it exits after 30 minutes idle. `semindex stop` ends
it; `--local` runs a command in-process instead.

A score is a lead, not a verdict, and no match is not proof that no duplicate exists. `skill/SKILL.md` explains
how to read the scores; the thresholds and the measurements behind them are in `docs/thresholds.md`.

## Claude Code hook

`semindex hook` reads a PostToolUse hook input on stdin. After an Edit or Write it re-indexes that file and, for
each function that is new or changed, lists existing functions scoring at least 0.80 in the same folder or 0.75
in another folder, and exact copies. The list goes back to the model as `additionalContext`; when nothing passes,
the hook prints nothing. A repo the server has not loaded yet is read from the cache without waiting for
missing embeddings, which are then filled in the background.

Add to a repo's `.claude/settings.json` (this is documentation; nothing here installs it):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "semindex hook", "timeout": 30 }]
      }
    ]
  }
}
```

Index the repo once with `semindex index` before relying on the hook. Measured on koekalenteri (M1 Pro): about
0.65 s for a hook call that starts the server, 0.2 s when nothing changed and about 0.25 s when one new function
is embedded with the server running.

## Development

```sh
npm run lint   # biome and tsc
npm test       # vitest; model tests skip unless the model is in the cache
```
