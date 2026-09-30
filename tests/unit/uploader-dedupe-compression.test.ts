import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hashFile, type TransactionCache } from '../../src/utils/cache.js'
import { parseCompressionConfig } from '../../src/utils/compression.js'
import type { UploadClient, UploadFileArgs } from '../../src/utils/upload-types.js'
import { planFolderUpload, uploadFile, uploadFolder } from '../../src/utils/uploader.js'

interface Upload {
  body: Buffer
  id: string
  tags: Record<string, string>
}

let folder: string

/** Records every upload (bytes and tags) and returns a deterministic id for each. */
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
      const id = `tx${String(uploads.length + 1).padStart(41, '0')}`
      uploads.push({ body, id, tags })
      return { id }
    },
  }

  return { client, uploads }
}

const isManifest = (u: Upload) => u.tags['Content-Type'] === 'application/x.arweave-manifest+json'

function manifestOf(uploads: Upload[]): { paths: Record<string, { id: string }> } {
  const upload = uploads.find((u) => isManifest(u))
  if (!upload) throw new Error('no manifest was uploaded')
  return JSON.parse(upload.body.toString('utf8'))
}

/** The first non-manifest upload; fails the test when there is none. */
function fileUpload(uploads: Upload[]): Upload {
  const upload = uploads.find((u) => !isManifest(u))
  if (!upload) throw new Error('no file was uploaded')
  return upload
}

function write(name: string, body: string | Buffer): void {
  const full = path.join(folder, name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

const PAGE = '<div class="flex items-center gap-2">hello</div>'.repeat(200)

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-dedupe-'))
})

afterEach(() => {
  fs.rmSync(folder, { force: true, recursive: true })
})

describe('in-run deduplication', () => {
  it('uploads identical files once and points every path at that upload', async () => {
    // Next's static export writes the same RSC payload as index.txt and __next._full.txt.
    write('index.html', '<html>home</html>')
    write('page/index.txt', PAGE)
    write('page/__next._full.txt', PAGE)

    const { client, uploads } = stubClient()
    const result = await uploadFolder(client, folder, { cache: {} })
    const { paths } = manifestOf(uploads)

    expect(uploads.filter((u) => !isManifest(u))).toHaveLength(2)
    expect(paths['page/index.txt'].id).toBe(paths['page/__next._full.txt'].id)
    expect(result.duplicates).toBe(1)
    expect(result.uploaded).toBe(2)
  })

  it('does not count a duplicate as a cache hit', async () => {
    write('a.txt', PAGE)
    write('b.txt', PAGE)

    const plan = await planFolderUpload(folder, { cache: {} })

    expect(plan.cacheHits).toBe(0)
    expect(plan.duplicates).toBe(1)
    expect(plan.uploadBytes).toBe(Buffer.byteLength(PAGE))
  })
})

describe('planFolderUpload', () => {
  it('prices only what misses the cache', async () => {
    write('cached.html', 'x'.repeat(5000))
    write('new.html', 'y'.repeat(3000))

    const cache: TransactionCache = {
      [await hashFile(path.join(folder, 'cached.html'))]: {
        createdAtTimestamp: 1,
        lastUsedTimestamp: 1,
        transactionId: `tx${'0'.repeat(41)}`,
      },
    }

    const plan = await planFolderUpload(folder, { cache })

    expect(plan.cacheHits).toBe(1)
    expect(plan.uploadBytes).toBe(3000)
    expect(plan.manifestBytes).toBeGreaterThan(0)
  })

  it('prices compressed bytes when compressing', async () => {
    write('index.html', PAGE)

    const plan = await planFolderUpload(folder, {
      cache: {},
      compression: parseCompressionConfig('gzip'),
    })

    expect(plan.uploadBytes).toBeLessThan(Buffer.byteLength(PAGE) / 5)
  })
})

describe('compressed uploads', () => {
  it('uploads gzip bytes tagged Content-Encoding and keeps Content-Type', async () => {
    write('index.html', PAGE)

    const { client, uploads } = stubClient()
    await uploadFolder(client, folder, {
      cache: {},
      compression: parseCompressionConfig('gzip'),
    })
    const page = fileUpload(uploads)

    expect(page.tags['Content-Encoding']).toBe('gzip')
    expect(page.tags['Content-Type']).toBe('text/html')
    expect(zlib.gunzipSync(page.body).toString('utf8')).toBe(PAGE)
  })

  it('never compresses the manifest', async () => {
    write('index.html', PAGE)

    const { client, uploads } = stubClient()
    await uploadFolder(client, folder, {
      cache: {},
      compression: parseCompressionConfig('br'),
    })

    expect(uploads.find((u) => isManifest(u))?.tags['Content-Encoding']).toBeUndefined()
  })

  it('uploads images and excluded files as-is, without the tag', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: 64 }, () => 7)])
    write('logo.png', png)
    write('llms.txt', PAGE)

    const { client, uploads } = stubClient()
    await uploadFolder(client, folder, {
      cache: {},
      compression: parseCompressionConfig('gzip', 'llms*.txt'),
    })

    for (const upload of uploads.filter((u) => !isManifest(u))) {
      expect(upload.tags['Content-Encoding']).toBeUndefined()
    }
  })

  it('uploads a file as-is when compressing would make it bigger', async () => {
    write('tiny.js', 'a')

    const { client, uploads } = stubClient()
    await uploadFolder(client, folder, {
      cache: {},
      compression: parseCompressionConfig('gzip'),
    })
    const file = fileUpload(uploads)

    expect(file.tags['Content-Encoding']).toBeUndefined()
    expect(file.body.toString('utf8')).toBe('a')
  })

  it('keys compressed uploads separately, so turning compression on re-uploads', async () => {
    write('index.html', PAGE)

    // First deploy, uncompressed: populates the cache with the plain upload.
    const first = stubClient()
    const plain = await uploadFolder(first.client, folder, { cache: {} })

    // Reusing that transaction would serve uncompressed bytes without the tag,
    // which is valid but silently defeats the flag.
    const second = stubClient()
    const compressed = await uploadFolder(second.client, folder, {
      cache: plain.updatedCache,
      compression: parseCompressionConfig('gzip'),
    })

    expect(compressed.cacheHits).toBe(0)
    expect(fileUpload(second.uploads).tags['Content-Encoding']).toBe('gzip')

    // ...and a repeat compressed deploy is a full cache hit.
    const third = stubClient()
    const again = await uploadFolder(third.client, folder, {
      cache: compressed.updatedCache,
      compression: parseCompressionConfig('gzip'),
    })
    expect(again.cacheHit).toBe(true)
    expect(third.uploads.filter((u) => !isManifest(u))).toHaveLength(0)
  })

  it('compresses single-file uploads too', async () => {
    write('bundle.js', PAGE)

    const { client, uploads } = stubClient()
    await uploadFile(client, path.join(folder, 'bundle.js'), {
      cache: {},
      compression: parseCompressionConfig('gzip'),
    })

    expect(uploads[0].tags['Content-Encoding']).toBe('gzip')
    expect(zlib.gunzipSync(uploads[0].body).toString('utf8')).toBe(PAGE)
  })
})
