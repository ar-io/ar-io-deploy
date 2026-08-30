import crypto from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { deployFlagConfigs, globalFlags, uploadFlagConfigs } from '../../src/constants/flags.js'
import { DEFAULT_INCREMENTAL_GATEWAY, FILE_HASH_TAG } from '../../src/constants/incremental.js'
import {
  assertDeployInvariantTags,
  createChainIndex,
  incrementalCacheKey,
  isArweaveId,
  isContentHash,
  ownerAddressFromPublicKey,
} from '../../src/utils/incremental.js'

/**
 * The chain-backed index is the half that matters in CI: a fresh checkout has
 * no `.ario-deploy/transaction-cache.json`, so without it every redeploy pays
 * for the whole bundle again. Every answer it accepts ends up both in a
 * permanent manifest and in the local cache, so these pin what it refuses as
 * hard as what it accepts.
 */

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const ID_A = `tx${'0'.repeat(41)}`
const ID_B = `tx${'1'.repeat(41)}`
const OWNER = `ow${'2'.repeat(41)}`
const HTML = 'text/html'

function node(id: string, hash: string, contentType = HTML, owner = OWNER) {
  return {
    cursor: `cursor-${id}`,
    node: {
      id,
      owner: { address: owner },
      tags: [
        { name: FILE_HASH_TAG, value: hash },
        { name: 'Content-Type', value: contentType },
      ],
    },
  }
}

/** A fetch that replays the given GraphQL pages in order. */
function fetchReturning(...pages: Array<{ edges: unknown[]; hasNextPage?: boolean }>) {
  let call = 0
  return vi.fn(async () => {
    const page = pages[Math.min(call, pages.length - 1)]
    call += 1
    return {
      json: async () => ({
        data: {
          transactions: { edges: page.edges, pageInfo: { hasNextPage: page.hasNextPage ?? false } },
        },
      }),
      ok: true,
      status: 200,
    } as unknown as Response
  })
}

function indexWith(fetchImpl: typeof fetch, onWarning?: (message: string) => void) {
  return createChainIndex({
    appName: 'ARIO-Deploy',
    fetchImpl,
    gatewayUrl: 'https://arweave.net',
    onWarning,
    owner: OWNER,
  })
}

const asFetch = (mock: unknown) => mock as unknown as typeof fetch
const want = (hash: string, contentType = HTML) => ({ contentType, hash })

describe('createChainIndex', () => {
  it('recovers transaction ids for content hashes', async () => {
    const fetchImpl = fetchReturning({ edges: [node(ID_A, HASH_A), node(ID_B, HASH_B)] })

    await expect(
      indexWith(asFetch(fetchImpl)).resolve([want(HASH_A), want(HASH_B)]),
    ).resolves.toEqual({
      [incrementalCacheKey(HASH_A, HTML)]: ID_A,
      [incrementalCacheKey(HASH_B, HTML)]: ID_B,
    })
  })

  it('queries the gateway GraphQL endpoint, scoped to the wallet and the hashes', async () => {
    const fetchImpl = fetchReturning({ edges: [] })
    await indexWith(asFetch(fetchImpl)).resolve([want(HASH_A)])

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }]
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }

    expect(url).toBe('https://arweave.net/graphql')
    expect(body.variables.owner).toBe(OWNER)
    expect(body.variables.hashes).toEqual([HASH_A])
    expect(body.query).toContain(FILE_HASH_TAG)
    expect(body.query).toContain('owners:[$owner]')
    // The owner has to come back too, or it cannot be re-checked here.
    expect(body.query).toContain('owner{address}')
  })

  it('refuses an id that belongs to somebody else', async () => {
    // The owners filter is applied by whichever host --incremental-gateway
    // names. A wrong id would go into the manifest AND into the local cache,
    // so a hostile or buggy gateway would poison every future deploy.
    const warnings: string[] = []
    const fetchImpl = fetchReturning({
      edges: [node(ID_A, HASH_A, HTML, `zz${'9'.repeat(41)}`)],
    })

    await expect(
      indexWith(asFetch(fetchImpl), (m) => warnings.push(m)).resolve([want(HASH_A)]),
    ).resolves.toEqual({})
    expect(warnings.join(' ')).toMatch(/not owned by/)
  })

  it('refuses a hit whose content type is not the one being asked for', async () => {
    // Same bytes, different type: reusing this id would serve the file as
    // text/html to every visitor.
    const fetchImpl = fetchReturning({ edges: [node(ID_A, HASH_A, 'text/html')] })

    await expect(
      indexWith(asFetch(fetchImpl)).resolve([want(HASH_A, 'application/json')]),
    ).resolves.toEqual({})
  })

  it('distinguishes two types sharing one hash', async () => {
    const fetchImpl = fetchReturning({
      edges: [node(ID_A, HASH_A, 'application/json'), node(ID_B, HASH_A, 'text/plain')],
    })

    await expect(
      indexWith(asFetch(fetchImpl)).resolve([
        want(HASH_A, 'application/json'),
        want(HASH_A, 'text/plain'),
      ]),
    ).resolves.toEqual({
      [incrementalCacheKey(HASH_A, 'application/json')]: ID_A,
      [incrementalCacheKey(HASH_A, 'text/plain')]: ID_B,
    })
  })

  it('keeps the newest sighting and ignores the rest', async () => {
    // Sorted HEIGHT_DESC, and any upload of these exact bytes under this exact
    // type is equally valid, so the first one wins.
    const fetchImpl = fetchReturning({ edges: [node(ID_A, HASH_A), node(ID_B, HASH_A)] })

    await expect(indexWith(asFetch(fetchImpl)).resolve([want(HASH_A)])).resolves.toEqual({
      [incrementalCacheKey(HASH_A, HTML)]: ID_A,
    })
  })

  it('pages until every file is accounted for', async () => {
    const fetchImpl = fetchReturning(
      { edges: [node(ID_A, HASH_A)], hasNextPage: true },
      { edges: [node(ID_B, HASH_B)] },
    )

    await expect(
      indexWith(asFetch(fetchImpl)).resolve([want(HASH_A), want(HASH_B)]),
    ).resolves.toEqual({
      [incrementalCacheKey(HASH_A, HTML)]: ID_A,
      [incrementalCacheKey(HASH_B, HTML)]: ID_B,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('stops as soon as everything is found, however long the history is', async () => {
    const fetchImpl = fetchReturning({ edges: [node(ID_A, HASH_A)], hasNextPage: true })

    await indexWith(asFetch(fetchImpl)).resolve([want(HASH_A)])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never asks about anything that is not a content hash', async () => {
    const fetchImpl = fetchReturning({ edges: [] })

    await expect(
      indexWith(asFetch(fetchImpl)).resolve([want(''), want('not-a-hash')]),
    ).resolves.toEqual({})
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails loudly on a gateway error rather than reporting no matches', async () => {
    // Reporting "nothing found" would quietly re-upload and re-charge for the
    // whole bundle; the caller downgrades this to a warning deliberately.
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502 }) as unknown as Response)

    await expect(indexWith(asFetch(fetchImpl)).resolve([want(HASH_A)])).rejects.toThrow(/502/)
  })
})

describe('ownerAddressFromPublicKey', () => {
  it('derives base64url(sha256(publicKey))', () => {
    const key = Buffer.from('a public key')
    expect(ownerAddressFromPublicKey(key)).toBe(
      crypto.createHash('sha256').update(key).digest('base64url'),
    )
  })

  it('produces a 43-character base64url address for every key size', () => {
    // ed25519 (Solana) is 32 bytes, secp256k1 (Ethereum) 65, RSA (Arweave) 512.
    // A gateway matches owners on this shape and reports no error for anything
    // else, so getting it wrong looks exactly like "nothing was ever uploaded".
    for (const size of [32, 65, 512]) {
      expect(isArweaveId(ownerAddressFromPublicKey(crypto.randomBytes(size)))).toBe(true)
    }
  })

  it('matches the owner address arweave.net indexes for a real Solana data item', () => {
    // Captured from arweave.net: an ed25519-signed ANS-104 item. Its
    // getNativeAddress() form is a base58 public key, which the owners filter
    // does not match — this address is what does.
    const key = 'lv9gh6c_7gzrptq2ODU7niAICh8fJqzkSYyCZTTEMA0'
    expect(ownerAddressFromPublicKey(Buffer.from(key, 'base64url'))).toBe(
      'IA0nWimVbZiODFqdiMfKB4PjXbhLpud_raSqjw_5Yyc',
    )
  })

  it('matches the owner address arweave.net indexes for a real Ethereum data item', () => {
    const key =
      'BAaSQPnWBJke1UYglroR8dQUpLQy40zS5JXpQjJx8epzWlIHNmsmg9vdaNyNdiGENHXPiTzN_0bDL6vlJfrkB2Q'
    expect(ownerAddressFromPublicKey(Buffer.from(key, 'base64url'))).toBe(
      'bqQgrxMXYFJXTqS5EF_XgmHUYyLNPXUv5Ze_c0RlW18',
    )
  })
})

describe('assertDeployInvariantTags', () => {
  it('accepts tags whose value is the same for the same bytes', () => {
    expect(() =>
      assertDeployInvariantTags([
        { name: 'App-Name', value: 'ARIO-Deploy' },
        { name: 'Content-Type', value: 'text/html' },
        { name: FILE_HASH_TAG, value: HASH_A },
      ]),
    ).not.toThrow()
  })

  it.each(['GIT-HASH', 'Git-Commit', 'Build-Time', 'anchor', 'Version'])(
    'refuses %s on a file',
    (name) => {
      // A data item's id covers its tags, so a per-deploy tag moves every id
      // and doubles the bill without a single visible error.
      expect(() => assertDeployInvariantTags([{ name, value: 'anything' }])).toThrow(
        /changes between deploys/,
      )
    },
  )
})

describe('id and hash shapes', () => {
  it('recognises a 43-character base64url transaction id', () => {
    expect(isArweaveId(ID_A)).toBe(true)
    expect(isArweaveId('too-short')).toBe(false)
    expect(isArweaveId('')).toBe(false)
  })

  it('recognises a lowercase hex SHA-256', () => {
    expect(isContentHash(HASH_A)).toBe(true)
    expect(isContentHash(HASH_A.toUpperCase())).toBe(false)
    expect(isContentHash('deadbeef')).toBe(false)
  })

  it('keys reuse on the content type as well as the hash', () => {
    expect(incrementalCacheKey(HASH_A, 'text/plain')).not.toBe(
      incrementalCacheKey(HASH_A, 'application/json'),
    )
  })
})

describe('incremental flags', () => {
  it('is off by default, so no existing pipeline changes behaviour', () => {
    expect(globalFlags.incremental.flag.default).toBe(false)
  })

  it('defaults to sweeping arweave.net', () => {
    expect(globalFlags.incrementalGateway.flag.default).toBe(DEFAULT_INCREMENTAL_GATEWAY)
  })

  it('is offered on both deploy and upload', () => {
    for (const configs of [deployFlagConfigs, uploadFlagConfigs]) {
      expect(configs).toHaveProperty('incremental')
      expect(configs).toHaveProperty('incremental-gateway')
    }
  })
})
