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

/**
 * Gateway whose GraphQL endpoint the chain-backed index sweeps by default.
 *
 * Turbo's own gateway: uploads made through Turbo (this CLI's default
 * uploader) are indexed there within minutes, before they are even bundled
 * into a block. arweave.net rate-limits GraphQL bursts with HTTP 429.
 * Point `--incremental-gateway` elsewhere when uploading through another
 * bundler.
 */
export const DEFAULT_INCREMENTAL_GATEWAY = 'https://turbo-gateway.com'

/** Transactions requested per GraphQL page. */
export const CHAIN_INDEX_PAGE_SIZE = 100

/**
 * Content hashes sent per GraphQL request. Gateways cap the size of a query:
 * an ar.io gateway answers ~1,100 hashes with "Max query size exceeded", so a
 * large site is looked up in batches. 100 keeps each query small and each
 * batch usually to one page.
 */
export const CHAIN_INDEX_HASH_BATCH = 100

/**
 * Pages walked per batch before giving up on it. A batch needs more than one
 * page only when its files were uploaded several times, so this bounds a
 * pathological response, not a normal one.
 */
export const CHAIN_INDEX_MAX_PAGES = 20

/**
 * Waits before retrying a request that failed transiently (HTTP 429 or 5xx, a
 * timeout, a network error): three attempts in all.
 */
export const CHAIN_INDEX_RETRY_DELAYS_MS = [500, 1500]

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

/** How often the transaction cache may be rewritten during a folder upload. */
export const CACHE_FLUSH_INTERVAL_MS = 500
