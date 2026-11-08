/**
 * Measured constants. docs/thresholds.md has the tables behind each value; all of them were measured on
 * koekalenteri (2,208 production functions) with CodeRankEmbed, and nine replayed agent tasks.
 */

/** Pairing rule: lowest sweep value that keeps all three confirmed cross-folder pairs (seededEdit 0.766); docs/thresholds.md. */
export const PAIR_THRESHOLD = 0.76

/** Pairing rule: both functions need at least this many AST tokens (5 Nov rule, unchanged). */
export const PAIR_MIN_TOKENS = 60

/** Hook, same folder: true copies in the tasks scored 0.81 to 0.91, a different-job match 0.68; fires for 8.6 % of functions. */
export const HOOK_SAME_FOLDER_THRESHOLD = 0.8

/** Hook, other folder: softer, fires for 4.6 % of functions; the tasks do not separate 0.70 to 0.85 (docs/thresholds.md). */
export const HOOK_OTHER_FOLDER_THRESHOLD = 0.75

/** Hook: functions shorter than this are not checked or listed; the shortest flagged copy in the tasks had 46. */
export const HOOK_MIN_TOKENS = 30

/** Hook: at most this many matches per new function and new functions per message. */
export const HOOK_MAX_MATCHES = 3
export const HOOK_MAX_FUNCTIONS = 5

/** Reciprocal rank fusion constant for BM25 + embedding. */
export const RRF_K = 60

/** Model input cap; longer chunks are split into parts of at most this many tokens. */
export const MAX_TOKENS = 512

export const QUERY_PREFIX = 'Represent this query for searching relevant code: '

/** Store layout version; a change starts a fresh cache folder. */
export const FORMAT_VERSION = 1

/** Server exits after this long without a request. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000
