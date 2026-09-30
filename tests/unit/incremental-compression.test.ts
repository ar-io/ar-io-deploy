import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FILE_HASH_TAG } from '../../src/constants/incremental.js'
import { parseCompressionConfig } from '../../src/utils/compression.js'
import {
  type ChainIndex,
  createChainIndex,
  type FileIdentity,
  incrementalCacheKey,
} from '../../src/utils/incremental.js'
import type { UploadClient, UploadFileArgs } from '../../src/utils/upload-types.js'
import { incrementalFileTags, planFolderUpload, uploadFolder } from '../../src/utils/uploader.js'

/**
 * Incremental uploads (reuse found on chain) and compression (gzip/br with a
 * Content-Encoding tag) were built separately. These pin how they combine: a
 * compressed upload and an uncompressed one of the same file are different
 * data items, served differently, and must never be substituted for each other
 * -- on chain, in the local cache, or within one run.
 */

const OWNER = `ow${'2'.repeat(41)}`
const PAGE = '<div class="flex items-center gap-2">hello</div>'.repeat(200)
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex')

interface Upload {
  body: Buffer
  tags: Record<string, string>
}

let folder: string

function write(name: string, body: string): void {
  const full = path.join(folder, name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

function stubClient(): { client: UploadClient; uploads: Upload[] } {
  const uploads: Upload[] = []
  const client: UploadClient = {
    async uploadFile(args: UploadFileArgs) {
      let body: Buffer
      if (args.fileStreamFactory) {
        const chunks: Buffer[] = []
        for await (const chunk of args.fileStreamFactory() as AsyncIterable<Buffer>) {
          chunks.push(Buffer.from(chunk))
        }

        body = Buffer.concat(chunks)
      } else {
        body = fs.readFileSync(args.file as string)
      }

      const tags = Object.fromEntries((args.dataItemOpts?.tags ?? []).map((t) => [t.name, t.value]))
      uploads.push({ body, tags })
      return { id: `tx${String(uploads.length).padStart(41, '0')}` }
    },
  }
  return { client, uploads }
}

const isManifest = (u: Upload) => u.tags['Content-Type'] === 'application/x.arweave-manifest+json'
const fileUploads = (uploads: Upload[]) => uploads.filter((u) => !isManifest(u))

/** A GraphQL edge for one of OWNER's past uploads. */
function edge(id: string, hash: string, contentType: string, encoding?: string) {
  return {
    cursor: `c-${id}`,
    node: {
      id,
      owner: { address: OWNER },
      tags: [
        { name: 'App-Name', value: 'ARIO-Deploy' },
        { name: FILE_HASH_TAG, value: hash },
        { name: 'Content-Type', value: contentType },
        ...(encoding ? [{ name: 'Content-Encoding', value: encoding }] : []),
      ],
    },
  }
}

function indexReturning(edges: unknown[]) {
  const fetchImpl = vi.fn(async () => ({
    json: async () => ({
      data: { transactions: { edges, pageInfo: { hasNextPage: false } } },
    }),
    ok: true,
    status: 200,
  }))
  return createChainIndex({
    appName: 'ARIO-Deploy',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    gatewayUrl: 'https://gateway.example',
    owner: OWNER,
  })
}

const gzip = parseCompressionConfig('gzip')

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-inc-comp-'))
})

afterEach(() => {
  fs.rmSync(folder, { force: true, recursive: true })
  delete process.env.GITHUB_SHA
})

describe('incrementalCacheKey with an encoding', () => {
  it('keeps the historic key for uncompressed files and extends it for compressed ones', () => {
    expect(incrementalCacheKey('h', 'text/html')).toBe('h|text/html')
    expect(incrementalCacheKey('h', 'text/html', 'gzip')).toBe('h|text/html|gzip')
    expect(incrementalCacheKey('h', 'text/html', 'gzip')).not.toBe(
      incrementalCacheKey('h', 'text/html', 'br'),
    )
  })
})

describe('chain index matches on encoding', () => {
  const hash = sha256(PAGE)
  const plain = `tx${'a'.repeat(41)}`
  const gzipped = `tx${'b'.repeat(41)}`

  it('returns the gzip upload for a gzip request and the plain one for a plain request', async () => {
    const index = indexReturning([
      edge(plain, hash, 'text/html'),
      edge(gzipped, hash, 'text/html', 'gzip'),
    ])
    const wantGzip: FileIdentity = { contentType: 'text/html', encoding: 'gzip', hash }
    const wantPlain: FileIdentity = { contentType: 'text/html', hash }

    expect(await index.resolve([wantGzip])).toEqual({
      [incrementalCacheKey(hash, 'text/html', 'gzip')]: gzipped,
    })
    expect(await index.resolve([wantPlain])).toEqual({
      [incrementalCacheKey(hash, 'text/html')]: plain,
    })
  })

  it('never hands an uncompressed upload to a compressed request', async () => {
    const index = indexReturning([edge(plain, hash, 'text/html')])
    expect(await index.resolve([{ contentType: 'text/html', encoding: 'gzip', hash }])).toEqual({})
  })

  it('never hands a compressed upload to an uncompressed request', async () => {
    const index = indexReturning([edge(gzipped, hash, 'text/html', 'gzip')])
    expect(await index.resolve([{ contentType: 'text/html', hash }])).toEqual({})
  })

  it('does not treat br as gzip', async () => {
    const index = indexReturning([edge(gzipped, hash, 'text/html', 'br')])
    expect(await index.resolve([{ contentType: 'text/html', encoding: 'gzip', hash }])).toEqual({})
  })
})

describe('incremental + compressed uploads', () => {
  it('tags compressed files with Content-Encoding and the hash of the original bytes', async () => {
    process.env.GITHUB_SHA = 'deadbeef'
    write('index.html', PAGE)

    const { client, uploads } = stubClient()
    await uploadFolder(client, folder, { cache: {}, compression: gzip, incremental: {} })
    const [file] = fileUploads(uploads)

    expect(file.tags).toEqual({
      'App-Name': 'ARIO-Deploy',
      'Content-Encoding': 'gzip',
      'Content-Type': 'text/html',
      [FILE_HASH_TAG]: sha256(PAGE),
    })
    // The hash identifies the file on disk, the body is what gets served.
    expect(zlib.gunzipSync(file.body).toString('utf8')).toBe(PAGE)
    // Provenance stays on the manifest only.
    expect(uploads.find((u) => isManifest(u))?.tags['GIT-HASH']).toBe('deadbeef')
  })

  it('leaves skipped formats and excluded files uncompressed and untagged', async () => {
    write('llms.txt', PAGE)
    write('logo.png', 'not really a png')

    const { client, uploads } = stubClient()
    await uploadFolder(client, folder, {
      cache: {},
      compression: parseCompressionConfig('gzip', 'llms*.txt'),
      incremental: {},
    })

    for (const upload of fileUploads(uploads)) {
      expect(upload.tags['Content-Encoding']).toBeUndefined()
      expect(upload.tags[FILE_HASH_TAG]).toBeDefined()
    }
  })

  it('reuses a compressed upload found on chain, with nothing to upload or price', async () => {
    write('index.html', PAGE)
    const found = `tx${'c'.repeat(41)}`
    const index = indexReturning([edge(found, sha256(PAGE), 'text/html', 'gzip')])

    const onCacheUpdate = vi.fn()
    const plan = await planFolderUpload(folder, {
      cache: {},
      compression: gzip,
      incremental: { index, onCacheUpdate },
    })

    expect(plan.recovered).toBe(1)
    expect(plan.cacheHits).toBe(1)
    expect(plan.uploadBytes).toBe(0)
    expect(plan.files[0].cached?.transactionId).toBe(found)
    // Recovered ids reach the cache immediately, keyed with the encoding.
    expect(onCacheUpdate).toHaveBeenCalledTimes(1)
    expect(Object.keys(plan.cache ?? {})).toEqual([
      incrementalCacheKey(sha256(PAGE), 'text/html', 'gzip'),
    ])
  })

  it('uploads again when the chain only has an uncompressed copy', async () => {
    write('index.html', PAGE)
    const index = indexReturning([edge(`tx${'d'.repeat(41)}`, sha256(PAGE), 'text/html')])

    const plan = await planFolderUpload(folder, {
      cache: {},
      compression: gzip,
      incremental: { index },
    })

    expect(plan.recovered).toBe(0)
    expect(plan.uploadBytes).toBeGreaterThan(0)
    expect(plan.uploadBytes).toBeLessThan(Buffer.byteLength(PAGE) / 5)
  })

  it('shares one upload between identical files of the same type', async () => {
    write('a/index.txt', PAGE)
    write('a/__next._full.txt', PAGE)

    const { client, uploads } = stubClient()
    const result = await uploadFolder(client, folder, {
      cache: {},
      compression: gzip,
      incremental: {},
    })

    expect(fileUploads(uploads)).toHaveLength(1)
    expect(result.duplicates).toBe(1)
  })

  it('still uploads everything when the chain index fails', async () => {
    write('index.html', PAGE)
    const failing: ChainIndex = {
      async resolve() {
        throw new Error('gateway unreachable')
      },
    }
    const onWarning = vi.fn()

    const { client, uploads } = stubClient()
    await uploadFolder(client, folder, {
      cache: {},
      compression: gzip,
      incremental: { index: failing, onWarning },
    })

    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('gateway unreachable'))
    expect(fileUploads(uploads)).toHaveLength(1)
  })

  it('records every compressed upload in the cache as it lands', async () => {
    write('a.html', PAGE)
    write('b.html', `${PAGE}!`)
    const snapshots: number[] = []

    await uploadFolder(stubClient().client, folder, {
      cache: {},
      compression: gzip,
      incremental: { onCacheUpdate: (cache) => snapshots.push(Object.keys(cache).length) },
    })

    expect(snapshots).toEqual([1, 2])
  })
})

describe('incrementalFileTags', () => {
  it('accepts Content-Encoding, which is set by configuration, not by the deploy', () => {
    expect(() => incrementalFileTags(sha256('x'), 'text/html', 'gzip')).not.toThrow()
  })
})
