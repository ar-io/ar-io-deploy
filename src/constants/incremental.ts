/** Value of the `App-Name` tag on everything this CLI uploads. */
export const APP_NAME = 'ARIO-Deploy'

/**
 * Tag carrying a file's SHA-256 content hash.
 *
 * This is what makes a past upload findable again from nothing but the bytes
 * on disk: the chain-backed index queries for it, so a fresh CI checkout with
 * no local cache can still recognise a file it already paid for.
 */
export const FILE_HASH_TAG = 'File-SHA256'

/** Gateway whose GraphQL endpoint the chain-backed index sweeps by default. */
export const DEFAULT_INCREMENTAL_GATEWAY = 'https://arweave.net'

/** Transactions requested per GraphQL page. */
export const CHAIN_INDEX_PAGE_SIZE = 100

/**
 * Pages the sweep will walk before giving up. The query filters on the hashes
 * this run actually needs, so a long deploy history costs nothing — this is a
 * bound on a pathological response, not a normal one.
 */
export const CHAIN_INDEX_MAX_PAGES = 20

/** Abort a GraphQL request that has not answered in this long. */
export const CHAIN_INDEX_TIMEOUT_MS = 30_000

/**
 * Tag names whose value changes between two deploys of identical bytes.
 *
 * A data item's id covers its tags, so any of these on a *file* moves every
 * file's id on every deploy and silently defeats deduplication — the upload
 * still succeeds, the manifest is still correct, and the bill quietly doubles.
 * They belong on the manifest, which is rewritten every deploy anyway.
 */
export const DEPLOY_VARYING_TAG_NAMES = new Set([
  'anchor',
  'build-id',
  'build-number',
  'build-time',
  'bundle-sha256',
  'commit',
  'commit-sha',
  'date',
  'deployed-at',
  'git-commit',
  'git-hash',
  'revision',
  'run-id',
  'sha',
  'timestamp',
  'version',
])
