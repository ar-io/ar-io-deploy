import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FILE_HASH_TAG } from '../../src/constants/incremental.js'
import type { TransactionCache } from '../../src/utils/cache.js'
import type { ChainIndex } from '../../src/utils/incremental.js'
import type { UploadClient, UploadFileArgs } from '../../src/utils/upload-types.js'
import { incrementalFileTags, uploadFolder } from '../../src/utils/uploader.js'

/**
 * Arweave storage is permanent, so paying twice for byte-identical files buys
 * nothing. These pin the three things that make a redeploy cheap: the hash tag
 * that keeps a past upload findable, the reuse of ids the run already knows,
 * and the manifest assembled from old and new ids together.
 */

interface ArweaveManifest {
  fallback?: { id: string }
  index?: { path: string }
  manifest: string
  paths: Record<string, { id: string }>
  version: string
}

const MANIFEST_CONTENT_TYPE = 'application/x.arweave-manifest+json'

let folder: string

/** Deterministic 43-character ids so a manifest entry traces to its upload. */
function idFor(index: number): string {
  return `tx${String(index).padStart(41, '0')}`
}

interface Recorded {
  path?: string
  tags: Array<{ name: string; value: string }>
}

/**
 * Records every upload with its tags, and exposes the manifest — the only item
 * sent as a stream and the only one tagged as a manifest.
 */
function stubClient(address: string | undefined = 'owner-address'): {
  client: UploadClient
  files: () => Recorded[]
  manifest: () => ArweaveManifest
  manifestTags: () => Array<{ name: string; value: string }>
} {
  let counter = 0
  let manifestJson: string | undefined
  let manifestTags: Array<{ name: string; value: string }> = []
  const files: Recorded[] = []

  const client: UploadClient = {
    ...(address === undefined
      ? {}
      : {
          signer: {
            async getNativeAddress() {
              return address
            },
          },
        }),
    async uploadFile(args: UploadFileArgs) {
      const tags = args.dataItemOpts?.tags ?? []
      const isManifest = tags.some(
        (t) => t.name === 'Content-Type' && t.value === MANIFEST_CONTENT_TYPE,
      )

      if (isManifest && args.fileStreamFactory) {
        const stream = args.fileStreamFactory() as AsyncIterable<Buffer>
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(Buffer.from(chunk))
        manifestJson = Buffer.concat(chunks).toString('utf8')
        manifestTags = tags
      } else {
        files.push({ path: typeof args.file === 'string' ? args.file : undefined, tags })
      }

      counter += 1
      return { id: idFor(counter) }
    },
  }

  return {
    client,
    files: () => files,
    manifest() {
      if (!manifestJson) throw new Error('no manifest was uploaded')
      return JSON.parse(manifestJson) as ArweaveManifest
    },
    manifestTags: () => manifestTags,
  }
}

function write(name: string, body: string): void {
  const full = path.join(folder, name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

/** The `File-SHA256` value the run published for a given uploaded file. */
function hashTags(files: Recorded[]): string[] {
  return files.map((f) => f.tags.find((t) => t.name === FILE_HASH_TAG)?.value ?? '')
}

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-incremental-'))
})

afterEach(() => {
  fs.rmSync(folder, { force: true, recursive: true })
})

describe('incremental folder uploads', () => {
  it('uploads nothing when nothing changed', async () => {
    write('index.html', '<html>index</html>')
    write('assets/app.js', 'console.log(1)')
    write('assets/app.css', 'body{}')

    const first = stubClient()
    let cache: TransactionCache = {}
    const run1 = await uploadFolder(first.client, folder, {
      cache,
      incremental: {
        onCacheUpdate(updated) {
          cache = updated
        },
      },
    })

    expect(run1.uploaded).toBe(3)
    expect(run1.cacheHits).toBe(0)

    // Redeploying the same bytes must cost nothing but the manifest.
    const second = stubClient()
    const run2 = await uploadFolder(second.client, folder, {
      cache,
      incremental: {
        onCacheUpdate(updated) {
          cache = updated
        },
      },
    })

    expect(second.files()).toHaveLength(0)
    expect(run2.uploaded).toBe(0)
    expect(run2.cacheHits).toBe(3)
    expect(run2.totalFiles).toBe(3)
  })

  it('uploads exactly the one file that changed', async () => {
    write('index.html', '<html>index</html>')
    write('assets/app.js', 'console.log(1)')
    write('assets/app.css', 'body{}')

    let cache: TransactionCache = {}
    await uploadFolder(stubClient().client, folder, {
      cache,
      incremental: {
        onCacheUpdate(updated) {
          cache = updated
        },
      },
    })

    write('index.html', '<html>index </html>')

    const second = stubClient()
    const run2 = await uploadFolder(second.client, folder, {
      cache,
      incremental: {
        onCacheUpdate(updated) {
          cache = updated
        },
      },
    })

    expect(run2.uploaded).toBe(1)
    expect(run2.cacheHits).toBe(2)
    expect(second.files().map((f) => f.path)).toEqual([path.join(folder, 'index.html')])
  })

  it('builds the manifest from remembered ids alongside the new one', async () => {
    write('index.html', '<html>index</html>')
    write('assets/app.js', 'console.log(1)')

    let cache: TransactionCache = {}
    const first = stubClient()
    await uploadFolder(first.client, folder, {
      cache,
      incremental: {
        onCacheUpdate(updated) {
          cache = updated
        },
      },
    })
    const before = first.manifest()

    write('index.html', '<html>index v2</html>')

    const second = stubClient()
    await uploadFolder(second.client, folder, {
      cache,
      incremental: {
        onCacheUpdate(updated) {
          cache = updated
        },
      },
    })
    const after = second.manifest()

    // The untouched file keeps the id it already has on chain; the edited one
    // gets the id this run paid for. A manifest missing either is a broken site.
    expect(after.paths['assets/app.js'].id).toBe(before.paths['assets/app.js'].id)
    expect(after.paths['index.html'].id).not.toBe(before.paths['index.html'].id)
    expect(Object.keys(after.paths).sort()).toEqual(['assets/app.js', 'index.html'])
  })

  it('pays once for two files with identical bytes', async () => {
    write('a.txt', 'same bytes')
    write('nested/b.txt', 'same bytes')

    const client = stubClient()
    const result = await uploadFolder(client.client, folder, { cache: {}, incremental: {} })

    expect(client.files()).toHaveLength(1)
    expect(result.uploaded).toBe(1)

    // Both paths still resolve, to the single transaction that was paid for.
    const manifest = client.manifest()
    expect(manifest.paths['a.txt'].id).toBe(manifest.paths['nested/b.txt'].id)
  })

  it('records every id the moment it lands, not at the end of the run', async () => {
    write('a.txt', 'a')
    write('b.txt', 'b')
    write('c.txt', 'c')

    const snapshots: number[] = []

    // A deploy killed part-way through is the normal case; anything not yet
    // written down has to be paid for again.
    await uploadFolder(stubClient().client, folder, {
      cache: {},
      concurrency: 1,
      incremental: { onCacheUpdate: (cache) => snapshots.push(Object.keys(cache).length) },
    })

    expect(snapshots).toEqual([1, 2, 3])
  })
})

/** An index that knows about hashes uploaded by some earlier, other machine. */
function indexOf(known: Record<string, string>, calls: string[][] = []): ChainIndex {
  return {
    async resolve(hashes) {
      const wanted = [...hashes]
      calls.push(wanted)
      return Object.fromEntries(wanted.filter((h) => known[h]).map((h) => [h, known[h]]))
    },
  }
}

describe('incremental chain-backed index', () => {
  it('reuses transaction ids found on chain when there is no local cache', async () => {
    write('index.html', '<html>index</html>')
    write('assets/app.js', 'console.log(1)')

    // Learn the hashes the way a first deploy publishes them.
    const first = stubClient()
    await uploadFolder(first.client, folder, { cache: {}, incremental: {} })
    const hashes = hashTags(first.files())
    const knownIds = Object.fromEntries(hashes.map((h, i) => [h, idFor(100 + i)]))

    // CI starts from a fresh checkout: no cache file, only the chain.
    const second = stubClient()
    const result = await uploadFolder(second.client, folder, {
      cache: {},
      incremental: { index: indexOf(knownIds) },
    })

    expect(second.files()).toHaveLength(0)
    expect(result.cacheHits).toBe(2)
    expect(
      Object.values(second.manifest().paths)
        .map((p) => p.id)
        .sort(),
    ).toEqual(Object.values(knownIds).sort())
  })

  it('only asks the chain about hashes the local cache could not answer', async () => {
    write('index.html', '<html>index</html>')
    write('assets/app.js', 'console.log(1)')

    let cache: TransactionCache = {}
    const first = stubClient()
    await uploadFolder(first.client, folder, {
      cache,
      incremental: {
        onCacheUpdate(updated) {
          cache = updated
        },
      },
    })

    write('assets/app.js', 'console.log(2)')

    const calls: string[][] = []
    await uploadFolder(stubClient().client, folder, {
      cache,
      incremental: { index: indexOf({}, calls) },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(1)
  })

  it('uploads everything when the gateway cannot be reached', async () => {
    write('index.html', '<html>index</html>')

    const warnings: string[] = []
    const failing: ChainIndex = {
      async resolve() {
        throw new Error('502 Bad Gateway')
      },
    }

    const client = stubClient()
    // A gateway that is down costs reuse, never correctness.
    const result = await uploadFolder(client.client, folder, {
      cache: {},
      incremental: { index: failing, onWarning: (m) => warnings.push(m) },
    })

    expect(result.uploaded).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(client.manifest().paths['index.html'].id).toBeDefined()
  })
})

describe('incremental tag invariant', () => {
  const originalSha = process.env.GITHUB_SHA

  afterEach(() => {
    if (originalSha === undefined) {
      delete process.env.GITHUB_SHA
    } else {
      process.env.GITHUB_SHA = originalSha
    }
  })

  it('publishes the content hash on every uploaded file', async () => {
    write('index.html', '<html>index</html>')

    const client = stubClient()
    await uploadFolder(client.client, folder, { cache: {}, incremental: {} })

    // Without this tag a later run with no local state cannot recognise the
    // file it already paid for.
    expect(hashTags(client.files())[0]).toMatch(/^[\da-f]{64}$/)
  })

  it('keeps the commit SHA off files, because it would move every id', async () => {
    process.env.GITHUB_SHA = 'abc123def'
    write('index.html', '<html>index</html>')

    const client = stubClient()
    await uploadFolder(client.client, folder, { cache: {}, incremental: {} })

    // A data item's id covers its tags. A per-deploy tag on a file changes
    // every id on every deploy and doubles the bill in silence.
    expect(client.files()[0].tags.some((t) => t.name === 'GIT-HASH')).toBe(false)
    expect(incrementalFileTags('a'.repeat(64), 'text/html')).not.toContainEqual({
      name: 'GIT-HASH',
      value: 'abc123def',
    })
  })

  it('still stamps provenance on the manifest, which is rewritten anyway', async () => {
    process.env.GITHUB_SHA = 'abc123def'
    write('index.html', '<html>index</html>')

    const client = stubClient()
    await uploadFolder(client.client, folder, { cache: {}, incremental: {} })

    expect(client.manifestTags()).toContainEqual({ name: 'GIT-HASH', value: 'abc123def' })
  })

  it('leaves non-incremental uploads exactly as they were', async () => {
    process.env.GITHUB_SHA = 'abc123def'
    write('index.html', '<html>index</html>')

    const client = stubClient()
    await uploadFolder(client.client, folder, { cache: {} })

    // Off by default: no new tag, and the historic provenance tags intact.
    expect(client.files()[0].tags.some((t) => t.name === FILE_HASH_TAG)).toBe(false)
    expect(client.files()[0].tags).toContainEqual({ name: 'GIT-HASH', value: 'abc123def' })
  })
})
