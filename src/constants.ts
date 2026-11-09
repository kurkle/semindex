/**
 * Measured constants. docs/thresholds.md has the tables behind each value; all of them were measured on
 * koekalenteri (2,208 production functions) with CodeRankEmbed, and nine replayed agent tasks.
 */

/** Pairing rule: lowest sweep value that keeps all three confirmed cross-folder pairs (seededEdit 0.766); docs/thresholds.md. */
export const PAIR_THRESHOLD = 0.76

/** Pairing rule: both functions need at least this many AST tokens (5 Nov rule, unchanged). */
export const PAIR_MIN_TOKENS = 60

/**
 * Hook: one bar for every folder and repository. At 0.80 in the same folder three of 22 known copies in
 * koekalenteri history were missed with the original ranked first or second (0.723 to 0.796); docs/thresholds.md.
 */
export const HOOK_THRESHOLD = 0.75

/** Hook: functions shorter than this are not checked or listed; the shortest flagged copy in the tasks had 46. */
export const HOOK_MIN_TOKENS = 30

/** Hook: at most this many matches per new function and new functions per message. */
export const HOOK_MAX_MATCHES = 3
export const HOOK_MAX_FUNCTIONS = 5

/** Hook event log: at this size events.jsonl is renamed to events.1.jsonl (replacing it) and a new one starts. */
export const EVENTS_MAX_BYTES = 8 * 1024 * 1024

/** Reciprocal rank fusion constant for BM25 + embedding. */
export const RRF_K = 60

/** Model input cap; longer chunks are split into parts of at most this many tokens. */
export const MAX_TOKENS = 512

export const QUERY_PREFIX = 'Represent this query for searching relevant code: '

/** Store layout version; a change starts a fresh cache folder. */
export const FORMAT_VERSION = 1

/**
 * Group members: a member's view (its main working tree) older than this is rebuilt in the background on the
 * next use, so commits and edits there show up without a hook ever waiting for them.
 */
export const PEER_REFRESH_MS = 60 * 1000

/** Server exits after this long without a request. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Dependency tarballs: the largest compressed tarball and unpacked size accepted, the largest single file kept,
 * and the download time limit. docs/dependencies.md has the sizes these were set against.
 */
export const DEP_TARBALL_MAX_BYTES = 64 * 1024 * 1024
export const DEP_UNPACKED_MAX_BYTES = 512 * 1024 * 1024
export const DEP_FILE_MAX_BYTES = 16 * 1024 * 1024
export const DEP_FETCH_TIMEOUT_MS = 120_000

/** Tarballs fetched and parsed at the same time. */
export const DEP_FETCH_CONCURRENCY = 6
