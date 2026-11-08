# Dependency indexing: measurements

Measured on 8 November 2026 on an Apple M1 Pro (10 cores, 32 GB), Node 24.20. The repository measured is a
TypeScript web app with its backend in one repo: about 3,600 production functions, 119 direct dependencies
(dependencies and devDependencies; React, MUI, the AWS SDK v3, date-fns, webpack, TypeScript among them), npm
lockfile v3. The measurement scripts ran from a scratchpad and are not in this repository.

## Upgrade impact tiers

Replay of 13 upgrade commits from that repository's history. "Had to change" is the production functions
under `src/` that the upgrade commit edited (the innermost function around each changed line, at the parent
commit). Each run is `semindex upgrade <commit>^` in a detached worktree at the upgrade commit. Cells are
functions that had to change and were listed / functions listed, tiers counted cumulatively (tier 2 includes
tier 1), scored over `src/` production code. "5 Nov" is the first experiment of 5 November, a standalone
script with the same rules, run at the parent commit with the upgraded lockfile.

| Upgrade                              | Bumped | Had to change |       Tier 1 |          Tier 2 |          Tier 3 |     5 Nov: 1 |      5 Nov: 2 |        5 Nov: 3 |
| :----------------------------------- | -----: | ------------: | -----------: | --------------: | --------------: | -----------: | ------------: | --------------: |
| mdast-util-to-hast patch             |      1 |             1 |        0 / 0 |           1 / 3 |           1 / 3 |        0 / 0 |         1 / 4 |           1 / 4 |
| @types/hast patch                    |      1 |             1 |        0 / 0 |           0 / 1 |           1 / 6 |        0 / 0 |         0 / 0 |           0 / 0 |
| Dependabot group, 7 updates          |      7 |             1 |        0 / 0 |           0 / 1 |         0 / 134 |        0 / 0 |         0 / 1 |         0 / 134 |
| minor updates                        |     14 |             0 |        0 / 0 |         0 / 159 |         0 / 219 |        0 / 0 |       0 / 157 |         0 / 208 |
| Dependabot group, 34 updates         |     34 |             0 |        0 / 1 |           0 / 8 |         0 / 107 |        0 / 1 |         0 / 7 |          0 / 81 |
| date-fns 3 to 4                      |      1 |             6 |        3 / 9 |          5 / 40 |          5 / 41 |        2 / 8 |        6 / 40 |          6 / 41 |
| date-fns 2 to 3                      |      2 |             0 |       0 / 14 |          0 / 47 |          0 / 47 |       0 / 14 |        0 / 44 |          0 / 44 |
| @mui/material 5 to 6                 |      2 |             4 |       0 / 12 |         4 / 132 |         4 / 142 |       0 / 12 |       4 / 131 |         4 / 138 |
| major updates (testing-library, ...) |     16 |             3 |        0 / 0 |           0 / 0 |         3 / 116 |        0 / 0 |         0 / 3 |         3 / 112 |
| @mui/* packages                      |      4 |            13 |        1 / 8 |         8 / 132 |        12 / 152 |        1 / 8 |       8 / 129 |        12 / 147 |
| major updates                        |      5 |             7 |        0 / 0 |          3 / 13 |          3 / 36 |        0 / 0 |        3 / 13 |          3 / 29 |
| Jest 30, MUI 7                       |     14 |            37 |       1 / 14 |        33 / 165 |        33 / 195 |       3 / 16 |      33 / 162 |        33 / 186 |
| React 19, MUI 9                      |     14 |           124 |     91 / 200 |       120 / 306 |       122 / 380 |     91 / 200 |     115 / 284 |       122 / 372 |
| **All 13**                           |        |       **197** | **96 / 258** | **174 / 1,007** | **184 / 1,578** | **97 / 259** | **170 / 975** | **184 / 1,496** |

Pooled, `semindex upgrade` against the 5 November script:

| Tier                                     | Recall         | Precision        | 5 Nov recall | 5 Nov precision |
| :--------------------------------------- | :------------- | :--------------- | -----------: | --------------: |
| 1: changed symbol named in the new docs  | 96/197 = 49 %  | 96/258 = 37 %    |         49 % |            37 % |
| 2: uses a changed or removed declaration | 174/197 = 88 % | 174/1,007 = 17 % |         86 % |            17 % |
| 3: uses the package                      | 184/197 = 93 % | 184/1,578 = 12 % |         93 % |            12 % |

Where the two differ:

- The worktree is at the upgrade commit, so the functions are read after the upgrade's own fixes. A function
  the fix stopped importing the package from drops out (date-fns 3 to 4: one function fewer in tiers 2 and 3),
  and the changelog-named symbol the fix removed no longer puts two functions in tier 1 (Jest 30, MUI 7).
  Replayed the other way, at the parent commit with the upgraded `package.json` and lockfile (what a Dependabot
  branch looks like before anyone fixes it), tier 1 is 97/259 exactly as on 5 November, tier 2 175/1,007 and
  tier 3 185/1,578.
- Imports of `foo` count for `@types/foo`: the @types/hast patch now lists the six functions importing `hast`
  types (one of them the function that changed), and React 19 adds the functions whose `react` imports
  changed in `@types/react` (16 tier 2 functions are there through `@types/*` only). This is most of the extra
  tier 2 recall and of the larger lists.
- A default or namespace import used as `ns.Name` in a type position now resolves to `Name`, as `ns.name(...)`
  already did. On the major-updates commit this moves three functions using `S3.Body`-style types from tier 2
  to tier 3.
- Functions bound by property assignment (`{ onSave: () => ... }`) are indexed as functions, and identifiers
  that only name a property are no longer taken for an import; both move counts by a few.

Time per replayed commit: 0.5 to 1.4 s with both versions of every bumped package already cached, 0.5 to 7 s
when the tarballs were fetched in the same run (16 bumped packages, two versions each, on the slowest).

## Dependency cache build

All 119 direct dependencies, parse only (`semindex index --deps --parse-only`), empty cache: 6.7 s wall clock,
725 MB peak memory, 90,003 chunks, 52 MB on disk. The same command with everything cached: 0.2 s. 22 packages
ship no declaration files (Babel presets, loaders, Biome, `react` and `react-dom`, whose types come from
`@types/react` and `@types/react-dom`).

Largest packages by chunks: typescript 12,826, @mui/icons-material 10,848, @types/node 7,721,
@aws-sdk/client-ssm 6,027, @mui/material 5,723, @aws-sdk/client-s3 4,605, webpack 4,495,
@aws-sdk/client-lambda 3,085, @mui/x-data-grid 2,890, @mui/x-charts 2,650.

## Embedding

`semindex index --deps` for the ten largest of them (the list above), CodeRankEmbed fp32 on the CPU (ONNX
Runtime, 8 threads), empty vector cache: 60,870 chunks in 3,832 s (64 minutes, 15.9 chunks a second), 2.7 GB
peak memory, 89 MB of float16 vectors. Smaller packages with shorter chunks go faster: chart.js 4.5.1 (1,444
chunks) took 59 s, date-fns 4.4.0 (1,473 chunks, embedded by its first `query --deps --package date-fns`)
114 s including the query. At that rate all 90,003 chunks of the 119 dependencies take about an hour and a
half once, which is why embedding is separate from parsing and `--package` limits it.

A second repository locking the same version reuses the namespace whole: after one repo had parsed and
embedded chart.js 4.5.1, `index --deps --package chart.js` in another repo pinning the same tarball reported
1 package from the cache, 0 parsed, 0 embedded, in 0.3 s. For whole dependency trees, two chart plugin repos
of 36 and 30 direct dependencies shared 27 of the second one's namespaces.

The extractor version bump that added import uses to code chunks re-parsed all 1,584 files of the measured
repo in 8.8 s and embedded 19 chunks (the functions changed since the cache was filled); the other 6,418
vectors were reused by text.

## Tarball limits

The limits in `src/constants.ts` were set with headroom against the largest tarballs of the 119: pdfjs-dist
9.1 MB packed (38 MB unpacked), typescript 4.4 MB (24 MB), @mui/icons-material 2.1 MB (57 MB unpacked).
Accepted: 64 MB packed, 512 MB unpacked, 16 MB per kept file, 120 s per download.

## Chunk size

Dependency chunks are embedded from their first 512 tokens only (code chunks are split into several parts
instead). An interface or class longer than 2,000 characters is also chunked one member at a time, under a
chunk that lists the member names, so large types such as a theme interface stay findable member by member.
