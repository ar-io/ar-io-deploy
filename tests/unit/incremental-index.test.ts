import { describe, expect, it, vi } from 'vitest'

import { deployFlagConfigs, globalFlags, uploadFlagConfigs } from '../../src/constants/flags.js'
import { DEFAULT_INCREMENTAL_GATEWAY, FILE_HASH_TAG } from '../../src/constants/incremental.js'
import {
  assertDeployInvariantTags,
  createChainIndex,
  isArweaveId,
  isContentHash,
} from '../../src/utils/incremental.js'

/**
 * The chain-backed index is the half that matters in CI: a fresh checkout has
 * no `.ario-deploy/transaction-cache.json`, so without it every redeploy pays
 * for the whole bundle again.
 */

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const ID_A = `tx${'0'.repeat(41)}`
const ID_B = `tx${'1'.repeat(41)}`

function node(id: string, hash: string) {
  return { cursor: `cursor-${id}`, node: { id, tags: [{ name: FILE_HASH_TAG, value: hash }] } }
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

function indexWith(fetchImpl: typeof fetch) {
  return createChainIndex({
    appName: 'ARIO-Deploy',
    fetchImpl,
    gatewayUrl: 'https://arweave.net',
    owner: 'owner-address',
  })
}

describe('createChainIndex', () => {
  it('recovers transaction ids for content hashes', async () => {
    const fetchImpl = fetchReturning({ edges: [node(ID_A, HASH_A), node(ID_B, HASH_B)] })

    await expect(
      indexWith(fetchImpl as unknown as typeof fetch).resolve([HASH_A, HASH_B]),
    ).resolves.toEqual({ [HASH_A]: ID_A, [HASH_B]: ID_B })
  })

  it('queries the gateway GraphQL endpoint, scoped to the wallet and the hashes', async () => {
    const fetchImpl = fetchReturning({ edges: [] })
    await indexWith(fetchImpl as unknown as typeof fetch).resolve([HASH_A])

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }]
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }

    expect(url).toBe('https://arweave.net/graphql')
    // A File-SHA256 tag is a claim anyone can stamp on any bytes. Scoping to
    // the uploader's own transactions is what makes the answer trustworthy.
    expect(body.variables.owner).toBe('owner-address')
    expect(body.variables.hashes).toEqual([HASH_A])
    expect(body.query).toContain(FILE_HASH_TAG)
    expect(body.query).toContain('owners:[$owner]')
  })

  it('keeps the newest sighting of a hash and ignores the rest', async () => {
    // Sorted HEIGHT_DESC, and any upload of these exact bytes is equally
    // valid, so the first one wins and there is nothing to reconcile.
    const fetchImpl = fetchReturning({ edges: [node(ID_A, HASH_A), node(ID_B, HASH_A)] })

    await expect(
      indexWith(fetchImpl as unknown as typeof fetch).resolve([HASH_A]),
    ).resolves.toEqual({
      [HASH_A]: ID_A,
    })
  })

  it('pages until every hash is accounted for', async () => {
    const fetchImpl = fetchReturning(
      { edges: [node(ID_A, HASH_A)], hasNextPage: true },
      { edges: [node(ID_B, HASH_B)] },
    )

    await expect(
      indexWith(fetchImpl as unknown as typeof fetch).resolve([HASH_A, HASH_B]),
    ).resolves.toEqual({ [HASH_A]: ID_A, [HASH_B]: ID_B })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('stops as soon as everything is found, however long the history is', async () => {
    const fetchImpl = fetchReturning({ edges: [node(ID_A, HASH_A)], hasNextPage: true })

    await indexWith(fetchImpl as unknown as typeof fetch).resolve([HASH_A])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never asks about anything that is not a content hash', async () => {
    const fetchImpl = fetchReturning({ edges: [] })

    await expect(
      indexWith(fetchImpl as unknown as typeof fetch).resolve(['', 'not-a-hash']),
    ).resolves.toEqual({})
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails loudly on a gateway error rather than reporting no matches', async () => {
    // Reporting "nothing found" would quietly re-upload and re-charge for the
    // whole bundle; the caller downgrades this to a warning deliberately.
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502 }) as unknown as Response)

    await expect(indexWith(fetchImpl as unknown as typeof fetch).resolve([HASH_A])).rejects.toThrow(
      /502/,
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
})

describe('incremental flags', () => {
  it('is off by default, so no existing pipeline changes behaviour', () => {
    expect(globalFlags.incremental.flag.default).toBe(false)
  })

  it('defaults to sweeping arweave.net', () => {
    expect(globalFlags.incrementalGateway.flag.default).toBe(DEFAULT_INCREMENTAL_GATEWAY)
  })

  it('cannot be combined with --no-dedupe, which means the opposite', () => {
    expect(globalFlags.incremental.flag.exclusive).toContain('no-dedupe')
  })

  it('is offered on both deploy and upload', () => {
    for (const configs of [deployFlagConfigs, uploadFlagConfigs]) {
      expect(configs).toHaveProperty('incremental')
      expect(configs).toHaveProperty('incremental-gateway')
    }
  })
})
