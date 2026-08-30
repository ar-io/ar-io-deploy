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
  CHAIN_INDEX_MAX_PAGES,
  CHAIN_INDEX_PAGE_SIZE,
  CHAIN_INDEX_TIMEOUT_MS,
  DEPLOY_VARYING_TAG_NAMES,
  FILE_HASH_TAG,
} from '../constants/incremental.js'

export type DataItemTag = { name: string; value: string }

/** A file's identity for reuse purposes: its bytes *and* how it is served. */
export interface FileIdentity {
  contentType: string
  hash: string
}

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
 * The wallet address a gateway indexes a data item's owner as.
 *
 * Deliberately not `signer.getNativeAddress()`. That returns a base58 public
 * key for Solana, a `0x…` address for Ethereum and Polygon, and a `kyve1…`
 * bech32 address for KYVE, none of which a gateway's `owners` filter matches.
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
  if (ARWEAVE_ID.test(owner)) {
    return
  }

  const looksNative = owner.startsWith('0x')
    ? 'an Ethereum-style address'
    : owner.startsWith('kyve1')
      ? 'a KYVE bech32 address'
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
 * @param hash - SHA-256 of the file contents.
 * @param contentType - MIME type the file is served as.
 * @returns A key safe to use in the transaction cache and the chain index.
 */
export function incrementalCacheKey(hash: string, contentType: string): string {
  return `${hash}|${contentType}`
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
  /** Reports answers that had to be discarded. */
  onWarning?: (message: string) => void
  /**
   * base64url(sha256(publicKey)) of the uploading wallet — see
   * `ownerAddressFromPublicKey`. Only this wallet's own items are trusted.
   */
  owner: string
  /** Transactions requested per page. */
  pageSize?: number
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
 * an edge must carry the expected owner and the expected `Content-Type` or it
 * is discarded. A `File-SHA256` tag is a claim, not a proof; anyone can stamp
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
    maxPages = CHAIN_INDEX_MAX_PAGES,
    onWarning,
    owner,
    pageSize = CHAIN_INDEX_PAGE_SIZE,
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
          wanted.set(incrementalCacheKey(file.hash, file.contentType), file)
        }
      }

      if (wanted.size === 0) {
        return {}
      }

      const found: Record<string, string> = {}
      const hashes = [...new Set([...wanted.values()].map((file) => file.hash))]
      let cursor: null | string = null
      let rejected = 0

      for (let page = 0; page < maxPages && Object.keys(found).length < wanted.size; page++) {
        const response = await fetchImpl(endpoint, {
          body: JSON.stringify({ query, variables: { after: cursor, hashes, owner } }),
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

          const id = edge.node?.id
          const tags = edge.node?.tags ?? []
          const hash = tags.find((tag) => tag.name === FILE_HASH_TAG)?.value
          const contentType = tags.find((tag) => tag.name === 'Content-Type')?.value

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

          const key = incrementalCacheKey(hash, contentType)
          /*
           * Newest first, and any upload of these exact bytes under this exact
           * type is equally valid, so the first sighting wins and there is
           * nothing to reconcile.
           */
          if (wanted.has(key) && !found[key]) {
            found[key] = id
          }
        }

        if (!transactions.pageInfo?.hasNextPage || edges.length === 0) {
          break
        }
      }

      if (rejected > 0) {
        onWarning?.(`Ignored ${rejected} result(s) from ${endpoint} not owned by ${owner}`)
      }

      return found
    },
  }
}
