import { describe, expect, it, vi } from 'vitest'

import { FILE_HASH_TAG } from '../../src/constants/incremental.js'
import { createChainIndex, incrementalCacheKey } from '../../src/utils/incremental.js'

/**
 * The chain index runs against public gateways that rate-limit (arweave.net
 * answers bursts with 429), cap query size (an ar.io gateway refuses ~1,100
 * hashes with "Max query size exceeded"), and occasionally fail. None of that
 * may cost more than the files it actually affects, and none of it may be
 * mistaken for "this wallet has no history".
 */

const OWNER = `ow${'2'.repeat(41)}`
const HTML = 'text/html'
const hashOf = (n: number) => n.toString(16).padStart(64, '0')
const idOf = (n: number) => `tx${String(n).padStart(41, '0')}`

interface Request {
  hashes: string[]
}

type Reply =
  | { kind: 'error'; message: string }
  | { kind: 'graphql-error' }
  | { kind: 'network' }
  | { kind: 'ok' }
  | { kind: 'status'; status: number }

/**
 * A fetch whose reply to each request is decided by `plan(requestIndex,
 * hashes)`. An `ok` reply returns an edge for every requested hash.
 */
function scriptedFetch(plan: (call: number, hashes: string[]) => Reply) {
  const requests: Request[] = []
  const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
    const { variables } = JSON.parse(init.body) as { variables: { hashes: string[] } }
    requests.push({ hashes: variables.hashes })
    const reply = plan(requests.length - 1, variables.hashes)

    if (reply.kind === 'network') throw new TypeError('fetch failed')
    if (reply.kind === 'status') return { ok: false, status: reply.status } as Response
    if (reply.kind === 'graphql-error') {
      return {
        json: async () => ({ errors: [{ message: 'Max query size exceeded' }] }),
        ok: true,
        status: 200,
      } as unknown as Response
    }

    const edges = variables.hashes.map((hash) => ({
      cursor: `c-${hash}`,
      node: {
        id: idOf(Number.parseInt(hash, 16)),
        owner: { address: OWNER },
        tags: [
          { name: FILE_HASH_TAG, value: hash },
          { name: 'Content-Type', value: HTML },
        ],
      },
    }))
    return {
      json: async () => ({ data: { transactions: { edges, pageInfo: { hasNextPage: false } } } }),
      ok: true,
      status: 200,
    } as unknown as Response
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests }
}

function index(fetchImpl: typeof fetch, onWarning?: (message: string) => void) {
  return createChainIndex({
    appName: 'ARIO-Deploy',
    fetchImpl,
    gatewayUrl: 'https://gateway.example',
    onWarning,
    owner: OWNER,
    retryDelaysMs: [0, 0],
  })
}

const files = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ contentType: HTML, hash: hashOf(i + 1) }))

describe('chain index batching', () => {
  it('splits a large site into batches no bigger than 100 hashes', async () => {
    const { fetchImpl, requests } = scriptedFetch(() => ({ kind: 'ok' }))

    const found = await index(fetchImpl).resolve(files(250))

    expect(requests.map((r) => r.hashes.length)).toEqual([100, 100, 50])
    expect(Object.keys(found)).toHaveLength(250)
  })

  it('asks about each hash in exactly one batch', async () => {
    const { fetchImpl, requests } = scriptedFetch(() => ({ kind: 'ok' }))

    await index(fetchImpl).resolve(files(250))

    const asked = requests.flatMap((r) => r.hashes)
    expect(new Set(asked).size).toBe(250)
    expect(asked).toHaveLength(250)
  })
})

describe('chain index retries', () => {
  it('retries a rate-limited request and uses the answer', async () => {
    const { fetchImpl, requests } = scriptedFetch((call) =>
      call === 0 ? { kind: 'status', status: 429 } : { kind: 'ok' },
    )

    const found = await index(fetchImpl).resolve(files(1))

    expect(requests).toHaveLength(2)
    expect(found).toEqual({ [incrementalCacheKey(hashOf(1), HTML)]: idOf(1) })
  })

  it('retries server errors and network failures', async () => {
    const { fetchImpl, requests } = scriptedFetch((call) =>
      call === 0
        ? { kind: 'status', status: 503 }
        : call === 1
          ? { kind: 'network' }
          : { kind: 'ok' },
    )

    const found = await index(fetchImpl).resolve(files(1))

    expect(requests).toHaveLength(3)
    expect(Object.keys(found)).toHaveLength(1)
  })

  it('does not retry a request the gateway refused as invalid', async () => {
    const { fetchImpl, requests } = scriptedFetch(() => ({ kind: 'status', status: 400 }))

    await expect(index(fetchImpl).resolve(files(1))).rejects.toThrow(/400/)
    expect(requests).toHaveLength(1)
  })

  it('does not retry a GraphQL error, which would only repeat', async () => {
    const { fetchImpl, requests } = scriptedFetch(() => ({ kind: 'graphql-error' }))

    await expect(index(fetchImpl).resolve(files(1))).rejects.toThrow(/Max query size exceeded/)
    expect(requests).toHaveLength(1)
  })

  it('gives up after the configured attempts', async () => {
    const { fetchImpl, requests } = scriptedFetch(() => ({ kind: 'status', status: 502 }))

    await expect(index(fetchImpl).resolve(files(1))).rejects.toThrow(/502/)
    // One attempt plus one retry per configured delay.
    expect(requests).toHaveLength(3)
  })
})

describe('chain index partial failure', () => {
  it('keeps what the healthy batches found and warns about the rest', async () => {
    // Batch 2 of 3 fails on every attempt; batches 1 and 3 answer.
    const { fetchImpl } = scriptedFetch((_call, hashes) =>
      hashes.includes(hashOf(150)) ? { kind: 'status', status: 500 } : { kind: 'ok' },
    )
    const onWarning = vi.fn()

    const found = await index(fetchImpl, onWarning).resolve(files(250))

    expect(Object.keys(found)).toHaveLength(150)
    expect(found[incrementalCacheKey(hashOf(150), HTML)]).toBeUndefined()
    expect(onWarning).toHaveBeenCalledWith(expect.stringMatching(/1 of 3 batch/))
  })

  it('fails loudly when no batch could be asked at all', async () => {
    // Otherwise a dead gateway would look exactly like a wallet with no history.
    const { fetchImpl } = scriptedFetch(() => ({ kind: 'status', status: 500 }))

    await expect(index(fetchImpl).resolve(files(250))).rejects.toThrow(/500/)
  })
})
