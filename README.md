# semindex

Local semantic index of code and docs in git repositories. It finds functions that do the same job as the one
you just wrote, likely copies across folders and repos, and code or docs matching a description. It also indexes
the npm dependencies a repo's lockfile pins, to look up a dependency's API at the exact locked version and to
rank the functions a dependency upgrade may touch. Indexing and queries run on the local machine.

- **Code**: functions, methods and arrow functions bound to a name, from `.ts`, `.tsx`, `.js`, `.jsx` (TypeScript
  compiler API), each with an AST hash that ignores names, literals, types and JSDoc. Tests and mocks are indexed
  but kept out of production comparisons; generated and vendored files are skipped.
- **Docs**: Markdown and MDX, one chunk per heading section.
- **Embeddings**: CodeRankEmbed (137M parameters, MIT) through ONNX Runtime on the CPU. Search is hybrid: BM25
  and embedding cosine fused by reciprocal rank.
- **Cache**: outside the working copy, in `~/.cache/semindex` (or `$SEMINDEX_CACHE`), keyed by git blob id. A
  commit's view is `git ls-tree` plus the dirty files, so another branch or another worktree of the same repo
  reuses everything already embedded, and an edit re-embeds only the functions whose text changed. The cache
  also keeps a registry of the repositories it has seen, keyed by git common dir, so every worktree of a
  repository shares one entry.
- **Groups**: named sets of related repositories, searched together by the hook, `diff` and `similar`, so a
  function copied from one repository into another is found. Groups live in the user's config, never in a
  repository.
- **Dependencies**: the direct dependencies, dev dependencies and peer dependencies in `package.json`, at the
  versions `package-lock.json` pins. Each package version is read from its registry tarball (never from
  `node_modules`), after checking the tarball against the lockfile's sha512 integrity; the package's code is
  parsed, never run. Its declaration files (`.d.ts`, `.d.mts`, `.d.cts`) become one chunk per declaration with
  its JSDoc, and its Markdown (README, CHANGELOG, docs) one chunk per heading section. A package that ships no
  declaration files is marked as having no types of its own; its `@types` package is indexed only when the repo
  depends on it directly. Each version is one namespace in the cache, keyed by registry, name, version,
  integrity, extractor version and model, so every repo and worktree that locks the same version shares it.

## Install

Node 24 or later.

```sh
git clone https://github.com/kurkle/semindex.git
cd semindex
npm ci            # also builds dist/
npm link          # puts `semindex` on PATH
```

The model (548 MB) downloads on first use from this repository's release `model-coderankembed-onnx-fp32-1` and
is checked against pinned sha256 hashes. `SEMINDEX_MODEL_DIR` points at an already downloaded copy instead.

The model is [nomic-ai/CodeRankEmbed](https://huggingface.co/nomic-ai/CodeRankEmbed) (MIT) exported to ONNX;
the release notes say how.

## Use

```sh
semindex index ~/code/myrepo           # first run embeds everything (6,000 chunks on an M1 Pro: about 10 minutes)
semindex forget ~/code/myrepo          # the hook stops acting in it; cached data stays until gc
semindex query "split places evenly among classes"
semindex similar src/lib/places.ts:73  # nearest functions to the one at that line
semindex pairs                         # likely copies in the current repo, cross-folder first
semindex pairs ../repo-a ../repo-b     # across repos, cross-repo first
semindex diff origin/main              # functions the branch added or changed, with existing ones they resemble
semindex status                        # cache location and size
semindex report --since 2026-11-01     # what the logged hook runs did, and what became of each finding

semindex group add web ../app ../ui-kit ../shared   # search these repositories together
semindex group remove web ../shared    # take one out (no directories: remove the whole group)
semindex group list                    # groups, their members' main working trees, and whether each is indexed

semindex index --deps --parse-only     # read the locked dependencies' declarations and docs (seconds)
semindex index --deps                  # ...and embed them, for query --deps
semindex query --deps "format a date as a relative time"   # search the locked dependency versions
semindex query --deps --package date-fns "add business days" # one dependency only (embeds just that one)
semindex upgrade origin/main           # dependencies bumped since the branch left base, functions to review first
semindex gc                            # drop dependency versions that no indexed repo's lockfile references
```

The commands talk to a resident server (`semindex serve`) that keeps the model and indexes in memory behind a
unix socket in the cache dir. The first command starts it; it exits after 30 minutes idle. `semindex stop` ends
it; `--local` runs a command in-process instead.

`diff` compares every function added or changed since the branch left the base (dirty files included) with
the rest of the repo, and with the other members of its groups, with the hook's thresholds; it suits a review
of a whole branch.

`semindex index` also registers the repository: from then on the hook acts in it, in every worktree.
`semindex forget [dir]` (default: the current directory) undoes that and takes the repository out of every
group; what it has in the cache stays until `gc`. `query`, `similar`, `pairs` and `diff` work in any
repository and index it on demand without registering it.

`query --deps` searches only the dependency versions the working tree's lockfile pins, BM25 and embeddings
fused as for code; each hit names `package@version`, the file inside the package and the declaration. Parsing
happens on first need. Embedding is separate: `index --deps` or the first `query --deps` embeds what is
missing. That takes a while once: about 16 chunks a second on an M1 Pro, so the ten largest dependencies of a
repo with 119 of them (61,000 chunks) took an hour; `--package` limits it to the packages you name. Vectors are reused by chunk text across versions, so an upgrade re-embeds only the declarations
and doc sections that changed.

`upgrade [base]` (default `origin/HEAD`, merge base as for `diff`) compares the lockfile at the merge base with
the working tree's. For each direct dependency whose version changed it diffs the two versions' declarations
(added, removed, changed by declaration hash) and lists the repo's production functions that import the
package, in three tiers:

1. uses a changed or removed declaration that the Markdown lines new in the later version (changelog, docs)
   name;
2. uses a changed or removed declaration (a default or namespace import used as a whole counts when anything
   changed);
3. uses the package at all.

Functions using a removed declaration come first within their tier. Imports from `foo` count for `@types/foo`,
and imports of Node builtins for `@types/node`. On replayed upgrades the tiers caught 49 %, 88 % and 93 % of
the functions that had to change, while 37 %, 17 % and 12 % of the functions they listed changed
(`docs/dependencies.md`). It is a ranking of what to review, not a list of what breaks: type-level breaks are
the compiler's job, so run `tsc` against the new types. `upgrade` needs only the parsed declarations and the
repo's parsed code, never embeddings. Tarballs come from the `resolved` URL without credentials, so a
dependency on a registry that needs a login is reported as skipped.

`gc` keeps every package version that a lockfile of a registered repo still pins (any of its worktrees) and
removes the rest; `index`, `index --deps` and `query --deps` register a repo, and a repo or worktree that no
longer exists drops out.

## Groups

Related repositories often copy code between each other, and a copy across repositories is the hardest kind to
see. A group is a named set of repositories that the hook, `diff` and `similar` search together: a function
written in one member is compared with the production functions of the other members too.

- Groups are kept in `$XDG_CONFIG_HOME/semindex/config.json` (default `~/.config/semindex/config.json`), keyed
  by each member's git common dir, so every worktree of a member belongs to its groups. A repository can be in
  several groups; it is then compared with the members of all of them.
- `group add` also registers each repository, as `semindex index` does, but embeds nothing. `group remove`
  leaves the repositories registered.
- Another member is compared as `semindex index <dir>` on its main working tree sees it: the current HEAD of
  that checkout plus its dirty files. Other worktrees and branches of a member are not searched.
- A match in another member names it (the directory name of its main working tree) before the path, is marked
  `(other repo)`, and is held to the other-folder threshold of 0.75. Exact copies are reported as exact.
- A member is loaded from the cache without embedding and without waiting; a member with missing vectors is
  embedded in the background (the server stays up for it), and until then its unembedded functions are not
  compared. `diff` and `similar` say which members are still being embedded. A member's view is rebuilt in
  the background when it is more than a minute old, after the request that noticed it has answered.
- `pairs` without arguments stays within the current repository; name several directories to pair across
  repositories.

A score is a lead, not a verdict, and no match is not proof that no duplicate exists. `skill/SKILL.md` explains
how to read the scores; the thresholds and the measurements behind them are in `docs/thresholds.md`.

## Claude Code hook

`semindex hook` reads a PostToolUse hook input on stdin. After an Edit or Write it re-indexes that file and, for
each function that is new or changed, lists existing functions scoring at least 0.80 in the same folder or 0.75
in another folder or another member of the repository's groups, and exact copies. The list goes back to the
model as `additionalContext`; when nothing passes, the hook prints nothing. A repo the server has not loaded
yet is read from the cache without waiting for missing embeddings, which are then filled in the background.

The hook acts only in repositories indexed with `semindex index` (or added to a group), in any of their
worktrees. In any other repository it prints nothing, writes nothing to the cache but its line in the event log
and starts no server, so it can be installed once for every repository, in `~/.claude/settings.json`:

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

The same block in a repository's `.claude/settings.json` installs it for that repository only. Measured on a
6,000-chunk TypeScript repo (M1 Pro): about 0.65 s for a hook call that starts the server, 0.2 s when nothing
changed and about 0.25 s when one new function is embedded with the server running. On a 100-chunk repository
in a group with six other repositories of 1,000 chunks in all (M1 Pro): about 2.1 s for the call that starts
the server and loads the group, against 1.0 s for the same repository without the group, and 0.4 s for later
calls with or without the group, of which starting the `semindex` process is 0.2 s.

### Event log and report

Every `semindex hook` run appends one JSON line to `events.jsonl` in the cache dir. A line has `ts`,
`session_id` and `transcript_path` from the hook input, `cwd`, `tool_name`, `file` as the tool named it,
`duration_ms` and `outcome`; for a file inside git also `repo` (the folder that holds the git common dir),
`root`, `gitDir`, `branch`, `head` and `path` relative to the root. `outcome` is one of:

- `finding`: the message named functions; `findings` lists each one's `name`, `path` and `line` with its
  `matches` (`repo` for another group member, `path`, `line`, `name`, `score`, `exact`, `sameFolder`).
- `none`: the file was checked and nothing passed the thresholds.
- `skipped`, with `reason`: `not a PostToolUse event`, `tool not handled`, `no file path`, `file not found`,
  `not in a git repository`, `repo not indexed`, `not a code file` or `test file`.
- `error`, with `message`: the check failed, the input was not JSON, or the run got SIGTERM (Claude Code's
  hook timeout) after it started; `killed by SIGTERM` is logged then. A run killed before Node has loaded the
  CLI, or by SIGKILL, logs nothing.

A failed write is ignored and the hook goes on. At 8 MB `events.jsonl` is renamed to `events.1.jsonl`,
replacing the older one, and a new file starts.

`semindex report [--since DATE] [--json]` reads both files and prints the runs per outcome with the median and
95th percentile duration, the count of each skip reason and error message, and, grouped by repository, the
fate of every flagged function, read from git at the time of the report:

- the commit judged is the tip of the event's branch, or when that tip is merged into `origin/main`, the commit
  on `origin/main`'s first-parent line that merged it. A branch whose ref is gone is looked up by a GitHub merge
  subject (`Merge pull request #N from owner/<branch>`) of a merge that contains the event's `head`.
- `kept`: a function of that name is in the file at that commit. This says only that it is still there, not
  that the match was a false lead.
- `replaced-by-match`: the function is gone and the file refers to the name of one of its matches (a match
  defined in the same file counts only where it is used, not where it is defined).
- `removed`: the function is gone and no match is referred to, or the file is gone.
- `unknown`: the branch, the commit or the repository is gone, or the event was on a detached HEAD.

Only commits are read: work not committed at the branch tip counts as not there.

## Development

```sh
npm run lint   # biome and tsc
npm test       # vitest; model tests skip unless the model is in the cache
```
