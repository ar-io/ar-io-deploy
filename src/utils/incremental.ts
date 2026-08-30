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
 *   2. a chain-backed index that recovers hash -> transaction id by sweeping
 *      the uploader's own past items over GraphQL, which is the only layer
 *      that survives a fresh CI checkout.
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

import {
  CHAIN_INDEX_MAX_PAGES,
  CHAIN_INDEX_PAGE_SIZE,
  CHAIN_INDEX_TIMEOUT_MS,
  DEPLOY_VARYING_TAG_NAMES,
  FILE_HASH_TAG,
} from '../constants/incremental.js'

export type DataItemTag = { name: string; value: string }

const ARWEAVE_ID = /^[\w-]{43}$/
const SHA256 = /^[\da-f]{64}$/

/** A base64url transaction id, as a gateway and a manifest both expect it. */
export function isArweaveId(value: string | undefined): value is string {
  return typeof value === 'string' && ARWEAVE_ID.test(value)
}

/** A lowercase hex SHA-256, as `hashFile` produces. */
export function isContentHash(value: string | undefined): value is string {
  return typeof value === 'string' && SHA256.test(value)
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
  /** Bound on pages walked before giving up. */
  maxPages?: number
  /** Native address of the uploading wallet. Only its own items are trusted. */
  owner: string
  /** Transactions requested per page. */
  pageSize?: number
  /** Abort a request that has not answered in this long. */
  timeoutMs?: number
}

export interface ChainIndex {
  /**
   * Look up transaction ids for content hashes among the owner's past uploads.
   *
   * @param hashes - Content hashes still needed after the local cache.
   * @returns A hash -> transaction id map holding only what was found.
   */
  resolve(hashes: Iterable<string>): Promise<Record<string, string>>
}

interface GraphQlResponse {
  data?: {
    transactions?: {
      edges?: Array<{ cursor?: string; node?: { id?: string; tags?: DataItemTag[] } }>
      pageInfo?: { hasNextPage?: boolean }
    }
  }
  errors?: unknown
}

/**
 * An index of hash -> transaction id, rebuilt from the chain over GraphQL.
 *
 * This is the layer that matters in CI: a fresh checkout has no
 * `.ario-deploy/transaction-cache.json`, so without it every redeploy pays for
 * the whole bundle again.
 *
 * Only the uploader's own transactions are consulted. A `File-SHA256` tag is
 * a claim, not a proof — anyone can stamp your hash on their bytes — so the
 * `owners` filter is what makes the answer trustworthy.
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
    maxPages = CHAIN_INDEX_MAX_PAGES,
    owner,
    pageSize = CHAIN_INDEX_PAGE_SIZE,
    timeoutMs = CHAIN_INDEX_TIMEOUT_MS,
  } = options

  const endpoint = `${gatewayUrl.replace(/\/+$/, '')}/graphql`

  /*
   * Filtering on the hash tag itself means the sweep only ever sees items this
   * run cares about, so a long deployment history costs nothing to page past.
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
    edges{cursor node{id tags{name value}}}
  }
}`

  return {
    async resolve(hashes: Iterable<string>): Promise<Record<string, string>> {
      const wanted = new Set([...hashes].filter((hash) => isContentHash(hash)))
      if (wanted.size === 0) {
        return {}
      }

      const found: Record<string, string> = {}
      const values = [...wanted]
      let cursor: null | string = null

      for (let page = 0; page < maxPages && Object.keys(found).length < wanted.size; page++) {
        const response = await fetchImpl(endpoint, {
          body: JSON.stringify({ query, variables: { after: cursor, hashes: values, owner } }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
        })

        if (!response.ok) {
          throw new Error(`GraphQL request to ${endpoint} failed with status ${response.status}`)
        }

        const body = (await response.json()) as GraphQlResponse
        const transactions = body?.data?.transactions
        if (!transactions) {
          throw new Error(
            `GraphQL request to ${endpoint} returned no transactions: ${JSON.stringify(
              body?.errors ?? body,
            )}`,
          )
        }

        const edges = transactions.edges ?? []
        for (const edge of edges) {
          cursor = edge.cursor ?? cursor
          const hash = edge.node?.tags?.find((tag) => tag.name === FILE_HASH_TAG)?.value
          const id = edge.node?.id
          /*
           * Newest first, and any upload of these exact bytes is equally
           * valid, so the first sighting wins and there is nothing to
           * reconcile.
           */
          if (isContentHash(hash) && isArweaveId(id) && wanted.has(hash) && !found[hash]) {
            found[hash] = id
          }
        }

        if (!transactions.pageInfo?.hasNextPage || edges.length === 0) {
          break
        }
      }

      return found
    },
  }
}
