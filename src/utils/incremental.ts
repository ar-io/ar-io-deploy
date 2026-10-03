/**
 * Content-hash based incremental uploads.
 *
 * Arweave storage is permanent, so paying twice for byte-identical files buys
 * nothing. Build tools content-hash their output, so between two deploys of a
 * real site only a couple of entry chunks change — everything else is already
 * on chain and can be referenced by its existing transaction id in the path
 * manifest.
 *
 * The local dedupe cache (`src/utils/cache.ts`) already does this for a
 * developer machine. This module adds the two pieces that machine does not
 * have:
 *
 *   1. a per-file `File-SHA256` tag, so an upload stays findable from nothing
 *      but the bytes on disk;
 *   2. a chain-backed index that recovers a transaction id by sweeping the
 *      uploader's own past items over GraphQL, which is the only layer that
 *      survives a fresh CI checkout.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT MAKES THIS WORK
 *
 * Identical bytes must produce identical per-file tags. A data item's id
 * covers its tags, so tagging each file with anything that varies per deploy —
 * a commit SHA above all — moves every id and defeats deduplication. The
 * failure is silent: the upload succeeds, the manifest is correct, and the
 * bill doubles. `assertDeployInvariantTags` refuses those tags on files;
 * `provenanceTags()` still stamps them on the manifest, which is rewritten
 * every deploy regardless.
 */

import crypto from 'node:crypto'

import {
  CHAIN_INDEX_HASH_BATCH,
  CHAIN_INDEX_MAX_PAGES,
  CHAIN_INDEX_PAGE_SIZE,
  CHAIN_INDEX_RETRY_DELAYS_MS,
  CHAIN_INDEX_TIMEOUT_MS,
  DEPLOY_VARYING_TAG_NAMES,
  FILE_HASH_TAG,
} from '../constants/incremental.js'
import { ARWEAVE_TX_ID_REGEX } from './constants.js'

export type DataItemTag = { name: string; value: string }

/** A file's identity for reuse purposes: its bytes *and* how it is served. */
export interface FileIdentity {
  contentType: string
  /** Content-Encoding the upload carries, when it was compressed. */
  encoding?: string
  /** SHA-256 of the file as it is on disk, before any compression. */
  hash: string
}

const SHA256 = /^[\da-f]{64}$/

/** A base64url transaction id, as a gateway and a manifest both expect it. */
export function isArweaveId(value: string | undefined): value is string {
  return typeof value === 'string' && ARWEAVE_TX_ID_REGEX.test(value)
}

/** A lowercase hex SHA-256, as `hashFile` produces. */
export function isContentHash(value: string | undefined): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

/**
 * The wallet address a gateway indexes a data item's owner as.
 *
 * Deliberately not `signer.getNativeAddress()`. That returns a base58 public
 * key for Solana and a `0x…` address for Ethereum and Polygon, neither of
 * which a gateway's `owners` filter matches.
 * The query answers HTTP 200 with an empty edge list, so filtering on the
 * native address would cost a round trip per deploy and reuse nothing, with
 * no error to warn on.
 *
 * Gateways index the owner of every signature type as
 * base64url(sha256(publicKey)). Verified against live arweave.net for RSA
 * (Arweave), ed25519 (Solana) and secp256k1 (Ethereum) data items. For an
 * Arweave signer this happens to equal `getNativeAddress()`, which is why the
 * bug would only ever have shown up for the other four signer types.
 *
 * The same derivation as `ownerToAddress` inside `@ardrive/turbo-sdk`
 * (`sha256B64Url(fromB64Url(owner))`), which is not reachable from that
 * package's public exports — hence the three lines here rather than an import
 * of a deep internal path.
 *
 * @param publicKey - The signer's raw public key.
 * @returns The 43-character base64url address the `owners` filter matches.
 */
export function ownerAddressFromPublicKey(publicKey: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(publicKey).digest('base64url')
}

/**
 * Reject an owner a gateway cannot possibly match.
 *
 * A gateway answers a query for an unknown owner with HTTP 200 and an empty
 * edge list, so a chain-native address here would look exactly like "this
 * wallet has never uploaded anything" on every deploy, forever, with nothing
 * to warn on. Naming the mistake is the only way it gets noticed.
 *
 * @param owner - The value about to be used as the GraphQL `owners` filter.
 * @throws If it is not a 43-character base64url address.
 */
export function assertOwnerAddress(owner: string): void {
  // Not isArweaveId(): its type predicate narrows the parameter to never here.
  if (ARWEAVE_TX_ID_REGEX.test(owner)) {
    return
  }

  const looksNative = owner.startsWith('0x')
    ? 'an Ethereum-style address'
    : 'a chain-native address or public key'

  throw new Error(
    `Incremental uploads need the 43-character base64url address a gateway indexes an owner ` +
      `as, but got ${looksNative}: ${owner}. Derive it from the signer public key with ` +
      `ownerAddressFromPublicKey(), not from signer.getNativeAddress().`,
  )
}

/**
 * Cache and index key for one file.
 *
 * Content hash alone is not enough. Byte-identical files served under
 * different types — `a.json` and `b.txt` holding the same bytes — would
 * collapse onto a single upload, and whichever `Content-Type` reached the
 * network first would then be served for both. Including the type keeps them
 * distinct in the local cache, in the in-run dedupe, and on chain.
 *
 * The encoding is part of the key for the same reason: a gzip upload and an
 * uncompressed one of the same file are different data items, and handing a
 * deploy that asked for one the other would serve bytes the gateway labels
 * differently from what the deploy intended.
 *
 * @param hash - SHA-256 of the file contents, before any compression.
 * @param contentType - MIME type the file is served as.
 * @param encoding - Content-Encoding of the upload, if compressed.
 * @returns A key safe to use in the transaction cache and the chain index.
 */
export function incrementalCacheKey(hash: string, contentType: string, encoding?: string): string {
  return encoding ? `${hash}|${contentType}|${encoding}` : `${hash}|${contentType}`
}

/**
 * Refuse per-file tags that change between deploys of identical bytes.
 *
 * Called before the first upload so a mistake costs nothing, and phrased to
 * name the fix — the tag is not wrong, it is on the wrong data item.
 *
 * @param tags - The tags that would be stamped on every uploaded file.
 * @throws If any tag name is known to vary per deploy.
 */
export function assertDeployInvariantTags(tags: DataItemTag[]): void {
  for (const tag of tags) {
    if (DEPLOY_VARYING_TAG_NAMES.has(tag.name.toLowerCase())) {
      throw new Error(
        `Incremental uploads cannot stamp "${tag.name}" on a file: its value changes between ` +
          `deploys, which changes every file's data item id and defeats deduplication. ` +
          `Deploy-varying tags belong on the manifest.`,
      )
    }
  }
}

export interface ChainIndexOptions {
  /** Value of the `App-Name` tag past uploads carry. */
  appName: string
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Gateway whose `/graphql` endpoint is swept. */
  gatewayUrl: string
  /**
   * Content hashes sent per request. Gateways cap the size of a query (an
   * ar.io gateway refuses ~1,100 hashes with "Max query size exceeded"), so a
   * large site is looked up in batches.
   */
  hashBatchSize?: number
  /** Bound on pages walked per batch before giving up on it. */
  maxPages?: number
  /** Reports answers that had to be discarded. */
  onWarning?: (message: string) => void
  /**
   * base64url(sha256(publicKey)) of the uploading wallet — see
   * `ownerAddressFromPublicKey`. Only this wallet's own items are trusted.
   */
  owner: string
  /** Transactions requested per page. */
  pageSize?: number
  /**
   * Waits before each retry of a request that failed transiently (HTTP 429 or
   * 5xx, a timeout, a network error). One retry per entry.
   */
  retryDelaysMs?: number[]
  /** Abort a request that has not answered in this long. */
  timeoutMs?: number
}

export interface ChainIndex {
  /**
   * Look up transaction ids among the owner's past uploads.
   *
   * @param files - Hash and content type of everything still needed after the
   *   local cache.
   * @returns A map from `incrementalCacheKey` to transaction id, holding only
   *   what was found and verified.
   */
  resolve(files: Iterable<FileIdentity>): Promise<Record<string, string>>
}

interface GraphQlEdge {
  cursor?: string
  node?: {
    id?: string
    owner?: { address?: string }
    tags?: DataItemTag[]
  }
}

interface GraphQlResponse {
  data?: {
    transactions?: {
      edges?: GraphQlEdge[]
      pageInfo?: { hasNextPage?: boolean }
    }
  }
  errors?: unknown
}

/**
 * An index of hash + content type -> transaction id, rebuilt from the chain.
 *
 * This is the layer that matters in CI: a fresh checkout has no
 * `.ario-deploy/transaction-cache.json`, so without it every redeploy pays for
 * the whole bundle again.
 *
 * Every answer is verified against what the gateway itself returns before it
 * is believed. The `owners` argument is applied server-side by whichever host
 * `--incremental-gateway` names, and a wrong id here does not merely break one
 * deploy — it is written into the local cache and poisons every later one. So
 * an edge must carry the expected owner, `Content-Type` and `Content-Encoding`
 * or it is discarded. A `File-SHA256` tag is a claim, not a proof; anyone can stamp
 * your hash on their own bytes.
 *
 * Gateway GraphQL indexing lags an upload by minutes, so two machines
 * deploying the same *new* file at the same moment can each pay for it. That
 * is the accepted failure mode: it costs a fraction of a cent and never
 * produces a wrong manifest.
 *
 * @param options - Owner, gateway, app name and paging bounds.
 * @returns An index whose `resolve` answers in bulk.
 */
export function createChainIndex(options: ChainIndexOptions): ChainIndex {
  const {
    appName,
    fetchImpl = fetch,
    gatewayUrl,
    hashBatchSize = CHAIN_INDEX_HASH_BATCH,
    maxPages = CHAIN_INDEX_MAX_PAGES,
    onWarning,
    owner,
    pageSize = CHAIN_INDEX_PAGE_SIZE,
    retryDelaysMs = CHAIN_INDEX_RETRY_DELAYS_MS,
    timeoutMs = CHAIN_INDEX_TIMEOUT_MS,
  } = options

  assertOwnerAddress(owner)

  const endpoint = `${gatewayUrl.replace(/\/+$/, '')}/graphql`

  /*
   * Filtering on the hash tag itself means the sweep only ever sees items this
   * run cares about, so a long deployment history costs nothing to page past.
   * `owner{address}` is selected so the server-side filter can be re-checked
   * here rather than trusted.
   */
  const query = `query($owner:String!,$hashes:[String!]!,$after:String){
  transactions(
    owners:[$owner]
    tags:[
      {name:"App-Name",values:[${JSON.stringify(appName)}]}
      {name:${JSON.stringify(FILE_HASH_TAG)},values:$hashes}
    ]
    sort:HEIGHT_DESC
    first:${pageSize}
    after:$after
  ){
    pageInfo{hasNextPage}
    edges{cursor node{id owner{address} tags{name value}}}
  }
}`

  return {
    async resolve(files: Iterable<FileIdentity>): Promise<Record<string, string>> {
      const wanted = new Map<string, FileIdentity>()
      for (const file of files) {
        if (isContentHash(file.hash)) {
          wanted.set(incrementalCacheKey(file.hash, file.contentType, file.encoding), file)
        }
      }

      if (wanted.size === 0) {
        return {}
      }

      const found: Record<string, string> = {}
      const hashes = [...new Set([...wanted.values()].map((file) => file.hash))]
      let rejected = 0
      let failedBatches = 0
      let lastError: unknown

      type Transactions = NonNullable<NonNullable<GraphQlResponse['data']>['transactions']>

      /** One page of one batch, retried on transient failures. */
      const fetchPage = async (batch: string[], after: null | string): Promise<Transactions> => {
        for (let attempt = 0; ; attempt++) {
          let transient: Error
          try {
            const response = await fetchImpl(endpoint, {
              body: JSON.stringify({ query, variables: { after, hashes: batch, owner } }),
              headers: { 'content-type': 'application/json' },
              method: 'POST',
              signal: AbortSignal.timeout(timeoutMs),
            })

            if (response.ok) {
              const body = (await response.json()) as GraphQlResponse
              const transactions = body?.data?.transactions
              if (!transactions) {
                throw new Error(
                  `GraphQL request to ${endpoint} returned no transactions: ${JSON.stringify(
                    body?.errors ?? body,
                  )}`,
                )
              }

              return transactions
            }

            const error = new Error(
              `GraphQL request to ${endpoint} failed with status ${response.status}`,
            )
            // A 4xx other than 429 will not get better by asking again.
            if (response.status !== 429 && response.status < 500) throw error
            transient = error
          } catch (error) {
            // A GraphQL-level error is deterministic for this query; only
            // network failures and timeouts are worth another attempt.
            const isNetwork =
              error instanceof TypeError ||
              (error instanceof Error &&
                (error.name === 'TimeoutError' || error.name === 'AbortError'))
            if (!isNetwork) throw error
            transient = error as Error
          }

          if (attempt >= retryDelaysMs.length) throw transient
          await new Promise((resolve) => {
            setTimeout(resolve, retryDelaysMs[attempt])
          })
        }
      }

      /*
       * Batches bound the size of each query; paging within a batch covers a
       * hash uploaded more than once. A batch that still fails after retries
       * costs only its own files -- the others are still reused.
       */
      for (let start = 0; start < hashes.length; start += hashBatchSize) {
        const batch = new Set(hashes.slice(start, start + hashBatchSize))
        const batchKeys = [...wanted.entries()]
          .filter(([, file]) => batch.has(file.hash))
          .map(([key]) => key)
        let cursor: null | string = null

        try {
          for (let page = 0; page < maxPages; page++) {
            if (batchKeys.every((key) => found[key])) break

            const transactions = await fetchPage([...batch], cursor)
            const edges = transactions.edges ?? []
            for (const edge of edges) {
              cursor = edge.cursor ?? cursor

              const id = edge.node?.id
              const tags = edge.node?.tags ?? []
              const hash = tags.find((tag) => tag.name === FILE_HASH_TAG)?.value
              const contentType = tags.find((tag) => tag.name === 'Content-Type')?.value
              // Absent on uncompressed uploads, which is exactly what the key needs.
              const encoding = tags.find((tag) => tag.name === 'Content-Encoding')?.value

              if (!isArweaveId(id) || !isContentHash(hash) || contentType === undefined) {
                continue
              }

              /*
               * Never take the server's word for its own filter. A hostile or
               * buggy gateway returning somebody else's id would put it in the
               * manifest and in the cache, breaking every future deploy too.
               */
              if (edge.node?.owner?.address !== owner) {
                rejected++
                continue
              }

              const key = incrementalCacheKey(hash, contentType, encoding)
              /*
               * Newest first, and any upload of these exact bytes under this
               * exact type and encoding is equally valid, so the first
               * sighting wins and there is nothing to reconcile.
               */
              if (wanted.has(key) && !found[key]) {
                found[key] = id
              }
            }

            if (!transactions.pageInfo?.hasNextPage || edges.length === 0) break
          }
        } catch (error) {
          failedBatches++
          lastError = error
        }
      }

      if (rejected > 0) {
        onWarning?.(`Ignored ${rejected} result(s) from ${endpoint} not owned by ${owner}`)
      }

      const batches = Math.ceil(hashes.length / hashBatchSize)
      if (failedBatches === batches) {
        // Nothing could be asked at all: fail loudly rather than report "no
        // matches", which would look exactly like a wallet with no history.
        throw lastError
      }

      if (failedBatches > 0) {
        const message = lastError instanceof Error ? lastError.message : String(lastError)
        onWarning?.(
          `Could not look up ${failedBatches} of ${batches} batch(es) of past uploads ` +
            `(${message}); those files will be uploaded again`,
        )
      }

      return found
    },
  }
}
