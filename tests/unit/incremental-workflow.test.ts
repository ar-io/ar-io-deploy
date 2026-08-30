import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runCommand } from '@oclif/test'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CACHE_DIR, CACHE_FILE } from '../../src/constants/cache.js'
import { FILE_HASH_TAG } from '../../src/constants/incremental.js'
import type { TransactionCache } from '../../src/utils/cache.js'
import { incrementalCacheKey, ownerAddressFromPublicKey } from '../../src/utils/incremental.js'
import { runUploadWorkflow } from '../../src/workflows/upload-workflow.js'
import { TEST_ARWEAVE_WALLET } from '../constants.js'
import { server } from '../setup.js'

/**
 * CI behaviour is the entire risk surface of this feature: a fresh checkout
 * has no cache, so everything depends on the chain lookup being wired up
 * correctly and on ids reaching disk. These drive the real workflow against
 * mocked Turbo and gateway HTTP rather than a stubbed client.
 */

const DEPLOY_KEY = Buffer.from(JSON.stringify(TEST_ARWEAVE_WALLET)).toString('base64')

/** The address a gateway indexes this wallet's data items under. */
const OWNER = ownerAddressFromPublicKey(Buffer.from(TEST_ARWEAVE_WALLET.n, 'base64url'))

let workdir: string
let folder: string
let cwdSpy: ReturnType<typeof vi.spyOn>

/** Every GraphQL request the run made, so the query itself can be asserted. */
interface GraphQlRequest {
  query: string
  variables: { hashes: string[]; owner: string }
}

function graphqlHandler(
  seen: GraphQlRequest[],
  edges: (request: GraphQlRequest) => unknown[] = () => [],
) {
  return http.post('https://arweave.net/graphql', async ({ request }) => {
    const body = (await request.json()) as GraphQlRequest
    seen.push(body)
    return HttpResponse.json({
      data: { transactions: { edges: edges(body), pageInfo: { hasNextPage: false } } },
    })
  })
}

function uploadedIds(): string[] {
  return ids
}

let ids: string[] = []

/** Turbo upload handler that hands back a distinct id per data item. */
function uploadHandler() {
  let counter = 0
  return http.post('https://upload.ardrive.io/v1/tx/:token', async () => {
    counter += 1
    const id = `tx${String(counter).padStart(41, '0')}`
    ids.push(id)
    return HttpResponse.json({
      dataCaches: ['https://turbo-gateway.com'],
      deadlineHeight: 1_000_000,
      fastFinalityIndexes: ['https://turbo-gateway.com'],
      id,
      owner: OWNER,
      timestamp: Date.now(),
      version: '1.0.0',
      winc: '0',
    })
  })
}

/**
 * Answer every requested hash under every content type the folder uses, as a
 * gateway holding a previous deploy would. Only the edge whose Content-Type
 * matches each file should be taken.
 */
function everyHashUnderEveryType(request: GraphQlRequest): unknown[] {
  const types = ['text/html', 'text/javascript']
  const edges: unknown[] = []

  for (const [i, hash] of request.variables.hashes.entries()) {
    for (const [j, contentType] of types.entries()) {
      edges.push({
        cursor: `c${i}-${j}`,
        node: {
          id: `re${String(i * 2 + j).padStart(41, '0')}`,
          owner: { address: OWNER },
          tags: [
            { name: FILE_HASH_TAG, value: hash },
            { name: 'Content-Type', value: contentType },
          ],
        },
      })
    }
  }

  return edges
}

function readCache(): TransactionCache {
  const file = path.join(workdir, CACHE_DIR, CACHE_FILE)
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TransactionCache
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    'dedupe-cache-max-entries': 10_000,
    'deploy-folder': folder,
    incremental: true,
    'incremental-gateway': 'https://arweave.net',
    'sig-type': 'arweave',
    ...overrides,
  }
}

const io = {
  error(message: string): never {
    throw new Error(message)
  },
}

beforeEach(() => {
  ids = []
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-wf-'))
  folder = path.join(workdir, 'dist')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'index.html'), '<html>index</html>')
  fs.writeFileSync(path.join(folder, 'app.js'), 'console.log(1)')

  // getCachePath() resolves against cwd; process.chdir is unavailable under
  // some vitest pools, and this is narrower anyway.
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workdir)
})

afterEach(() => {
  cwdSpy.mockRestore()
  try {
    fs.rmSync(workdir, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 })
  } catch {
    // Best effort. Windows can still hold a handle on a file the upload client
    // streamed, and losing a temp directory is not worth failing a run over.
  }
})

describe('runUploadWorkflow with --incremental', () => {
  it('asks the gateway for this wallet, and writes the ids it paid for to disk', async () => {
    const seen: GraphQlRequest[] = []
    server.use(graphqlHandler(seen), uploadHandler())

    const result = await runUploadWorkflow(DEPLOY_KEY, config(), io)

    expect(result.transactionId).toBeDefined()

    // The owner filter must be the derived address, not the native one: for
    // four of the five signer types they differ, and a gateway answers 200
    // with an empty list for the native form.
    expect(seen).toHaveLength(1)
    expect(seen[0].variables.owner).toBe(OWNER)
    expect(seen[0].variables.hashes).toHaveLength(2)
    expect(seen[0].query).toContain(FILE_HASH_TAG)

    // Two files, plus the manifest.
    expect(uploadedIds()).toHaveLength(3)

    const cache = readCache()
    expect(Object.keys(cache)).toHaveLength(2)
    for (const key of Object.keys(cache)) {
      expect(key).toMatch(/^[\da-f]{64}\|/)
    }
  })

  it('reuses ids the gateway already knows, uploading only the manifest', async () => {
    const seen: GraphQlRequest[] = []
    // Answer every requested hash with an id, as a previous deploy would have.
    server.use(graphqlHandler(seen, everyHashUnderEveryType), uploadHandler())

    await runUploadWorkflow(DEPLOY_KEY, config(), io)

    // Only the manifest was paid for; both files came back from the chain.
    expect(uploadedIds()).toHaveLength(1)

    // Each file took the id whose Content-Type matched its own, not merely
    // the first id carrying its hash.
    const cache = readCache()
    const byType = Object.fromEntries(
      Object.entries(cache).map(([key, entry]) => [key.split('|')[1], entry.transactionId]),
    )
    expect(Object.keys(byType).sort()).toEqual(['text/html', 'text/javascript'])
    for (const id of Object.values(byType)) {
      expect(id).toMatch(/^re0*\d$/)
    }
  })

  it('still deploys when the gateway is broken', async () => {
    server.use(
      http.post('https://arweave.net/graphql', async () =>
        HttpResponse.json({ error: 'nope' }, { status: 502 }),
      ),
      uploadHandler(),
    )

    const result = await runUploadWorkflow(DEPLOY_KEY, config(), io)

    expect(result.transactionId).toBeDefined()
    expect(uploadedIds()).toHaveLength(3)
  })

  it('writes a cache file that survives being read back', async () => {
    const seen: GraphQlRequest[] = []
    server.use(graphqlHandler(seen), uploadHandler())

    await runUploadWorkflow(DEPLOY_KEY, config(), io)

    // The write is a temp file plus a rename, so a reader never sees a partial
    // document — loadCache treats an unparseable one as empty, which would
    // discard every id already paid for.
    const raw = fs.readFileSync(path.join(workdir, CACHE_DIR, CACHE_FILE), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(fs.readdirSync(path.join(workdir, CACHE_DIR))).toEqual([CACHE_FILE])
  })

  it('keys the cache so identical bytes under two types stay two uploads', async () => {
    fs.writeFileSync(path.join(folder, 'a.json'), '{"x":1}')
    fs.writeFileSync(path.join(folder, 'b.txt'), '{"x":1}')

    const seen: GraphQlRequest[] = []
    server.use(graphqlHandler(seen), uploadHandler())

    await runUploadWorkflow(DEPLOY_KEY, config(), io)

    const cache = readCache()
    const keys = Object.keys(cache)
    expect(keys.some((k) => k.endsWith(`|${'application/json'}`))).toBe(true)
    expect(keys.some((k) => k.endsWith(`|${'text/plain'}`))).toBe(true)

    // Same hash, two entries, two different transaction ids.
    const jsonKey = keys.find((k) => k.endsWith('|application/json'))!
    const txtKey = keys.find((k) => k.endsWith('|text/plain'))!
    expect(jsonKey.split('|')[0]).toBe(txtKey.split('|')[0])
    expect(cache[jsonKey].transactionId).not.toBe(cache[txtKey].transactionId)
  })

  it('warns instead of pretending to honour --incremental for a single file', async () => {
    const seen: GraphQlRequest[] = []
    server.use(graphqlHandler(seen), uploadHandler())

    await runUploadWorkflow(
      DEPLOY_KEY,
      config({ 'deploy-file': path.join(folder, 'index.html') }),
      io,
    )

    // A single file has no manifest, so there is nothing to reuse into: no
    // gateway lookup, and the plain hash-keyed entry the file path has always
    // written rather than an incremental one.
    expect(seen).toHaveLength(0)
    expect(Object.keys(readCache()).every((key) => /^[\da-f]{64}$/.test(key))).toBe(true)
  })
})

/** A minimal, valid `upload` invocation plus whatever is being tested. */
function uploadArgs(extra: string[]): string[] {
  return [
    'upload',
    '--deploy-folder',
    './tests/fixtures/test-app',
    '--wallet',
    './tests/fixtures/test_wallet.json',
    ...extra,
  ]
}

describe('--incremental and turning dedupe off', () => {
  it('refuses --incremental --no-dedupe', async () => {
    // Asserting on the flag definition alone would stay green if an oclif
    // upgrade changed how exclusivity is enforced.
    const { error } = await runCommand(uploadArgs(['--incremental', '--no-dedupe']))

    expect(error).toBeDefined()
    expect(error?.message).toMatch(/cannot also be provided|no-dedupe/)
  })

  it('refuses --incremental --dedupe-cache-max-entries 0, the same thing said differently', async () => {
    const { error } = await runCommand(
      uploadArgs(['--incremental', '--dedupe-cache-max-entries', '0']),
    )

    expect(error).toBeDefined()
    expect(error?.message).toMatch(/deduplication turned off/)
  })

  it('accepts --incremental on its own', async () => {
    const { error } = await runCommand(uploadArgs(['--incremental', '--help']))

    expect(error).toBeUndefined()
  })
})

describe('incremental cache keys', () => {
  it('agrees with what the index produces', () => {
    expect(incrementalCacheKey('a'.repeat(64), 'text/html')).toBe(`${'a'.repeat(64)}|text/html`)
  })
})
