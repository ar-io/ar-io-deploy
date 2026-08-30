import crypto from 'node:crypto'
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
import { mockInsufficientBalance } from '../mocks/turbo-handlers.js'
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

/**
 * Build a gateway responder that knows about every file in `dir` except those
 * whose contents appear in `except` — a previous deploy, minus what changed.
 */
function everyHashUnderEveryTypeIn(
  dir: string,
  except: Buffer[] = [],
): (request: GraphQlRequest) => unknown[] {
  const excluded = new Set(
    except.map((body) => crypto.createHash('sha256').update(body).digest('hex')),
  )

  return (request: GraphQlRequest) => {
    const edges: unknown[] = []
    for (const [i, hash] of request.variables.hashes.entries()) {
      if (excluded.has(hash)) continue
      for (const [j, contentType] of ['text/html', 'text/javascript', 'text/plain'].entries()) {
        edges.push({
          cursor: `k${i}-${j}`,
          node: {
            id: `rr${String(i * 3 + j).padStart(41, '0')}`,
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

/** Bytes each quote asked about, so the pre-flight can be pinned. */
function capturePriceRequests(): string[] {
  const seen: string[] = []
  server.use(
    http.get('https://payment.ardrive.io/v1/price/bytes/:byteCount', ({ params }) => {
      seen.push(String(params.byteCount))
      return HttpResponse.json({ adjustments: [], winc: '100000000' })
    }),
  )
  return seen
}

/** Six distinct 60 KB chunks: the folder and any pair clear the free tier. */
function writeBigFolder(): void {
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(folder, `chunk-${i}.txt`), String(i).repeat(60_000))
  }
}

describe('the credits pre-flight prices what will actually be sent', () => {
  it('does not quote the whole bundle when nothing changed', async () => {
    writeBigFolder()
    const quoted = capturePriceRequests()
    const seen: GraphQlRequest[] = []
    server.use(graphqlHandler(seen, everyHashUnderEveryTypeIn(folder)), uploadHandler())

    await runUploadWorkflow(DEPLOY_KEY, config(), io)

    /*
     * The headline promise is that a redeploy pays only for what changed.
     * Pricing the folder would refuse exactly that deploy for want of credits
     * for the whole bundle, and the first user to hit it concludes the flag
     * does not work.
     */
    expect(quoted).toEqual([])
  })

  it('still quotes the whole folder without --incremental', async () => {
    writeBigFolder()
    const quoted = capturePriceRequests()
    server.use(uploadHandler())

    await runUploadWorkflow(DEPLOY_KEY, config({ incremental: false }), io)

    // Unchanged behaviour for anyone who did not opt in.
    expect(quoted).toHaveLength(1)
    expect(Number(quoted[0])).toBeGreaterThan(350_000)
  })

  it('quotes only the chunks that changed, not the folder', async () => {
    writeBigFolder()
    const quoted = capturePriceRequests()
    const seen: GraphQlRequest[] = []

    // Everything resolves except two chunks: a real redeploy after a rebuild.
    const changed = [
      fs.readFileSync(path.join(folder, 'chunk-0.txt')),
      fs.readFileSync(path.join(folder, 'chunk-1.txt')),
    ]
    server.use(graphqlHandler(seen, everyHashUnderEveryTypeIn(folder, changed)), uploadHandler())

    await runUploadWorkflow(DEPLOY_KEY, config(), io)

    expect(quoted).toHaveLength(1)
    // Two 60,000-byte chunks, not the ~360 KB folder.
    expect(Number(quoted[0])).toBe(120_000)
  })
})

/** Signal listeners currently registered, so a leak shows up as a delta. */
function counts(): { int: number; term: number } {
  return { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }
}

describe('signal handlers do not outlive a failed run', () => {
  it('cleans up when the credits check refuses the deploy', async () => {
    writeBigFolder()
    const before = counts()

    server.use(
      ...mockInsufficientBalance('100', '99999999999999'),
      graphqlHandler([]),
      uploadHandler(),
    )

    // io.error throws, so every path out of the pre-flight is an exception —
    // and each leaked one handler per run until MaxListenersExceededWarning.
    await expect(runUploadWorkflow(DEPLOY_KEY, config(), io)).rejects.toThrow()

    expect(counts()).toEqual(before)
  })

  it('cleans up after a successful run', async () => {
    const before = counts()
    server.use(graphqlHandler([]), uploadHandler())

    await runUploadWorkflow(DEPLOY_KEY, config(), io)

    expect(counts()).toEqual(before)
  })

  it('registers none at all for a single file', async () => {
    const before = counts()
    server.use(uploadHandler())

    await runUploadWorkflow(
      DEPLOY_KEY,
      config({ 'deploy-file': path.join(folder, 'index.html') }),
      io,
    )

    expect(counts()).toEqual(before)
  })
})

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
