import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { UploadClient, UploadFileArgs } from '../../src/utils/upload-types.js'
import { uploadFolder } from '../../src/utils/uploader.js'

/**
 * The manifest's `fallback` is what a gateway serves for a path the manifest
 * does not list. Without it an `arweave/paths` manifest 404s every route of a
 * single-page app that is not a real file — the root loads, `/settings` does
 * not — so these pin the shape as well as the presence.
 */

interface ArweaveManifest {
  fallback?: { id: string }
  index?: { path: string }
  manifest: string
  paths: Record<string, { id: string }>
  version: string
}

let folder: string

/** Deterministic ids so a manifest entry can be traced back to its file. */
function idFor(index: number): string {
  return `tx${String(index).padStart(41, '0')}`
}

/**
 * Records every upload and exposes the manifest, which is the last file sent
 * and the only one tagged as a manifest.
 */
function stubClient(): { client: UploadClient; manifest: () => ArweaveManifest } {
  let counter = 0
  let manifestJson: string | undefined

  const client: UploadClient = {
    async uploadFile(args: UploadFileArgs) {
      const isManifest = args.dataItemOpts?.tags?.some(
        (t) => t.name === 'Content-Type' && t.value === 'application/x.arweave-manifest+json',
      )

      if (isManifest && args.fileStreamFactory) {
        const stream = args.fileStreamFactory() as AsyncIterable<Buffer>
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(Buffer.from(chunk))
        manifestJson = Buffer.concat(chunks).toString('utf8')
      }

      counter += 1
      return { id: idFor(counter) }
    },
  }

  return {
    client,
    manifest() {
      if (!manifestJson) throw new Error('no manifest was uploaded')
      return JSON.parse(manifestJson) as ArweaveManifest
    },
  }
}

function write(name: string, body: string): void {
  const full = path.join(folder, name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-fallback-'))
})

afterEach(() => {
  fs.rmSync(folder, { force: true, recursive: true })
})

describe('uploadFolder manifest fallback', () => {
  it('uses 404.html as the fallback when the build emits one', async () => {
    write('index.html', '<html>index</html>')
    write('404.html', '<html>fallback</html>')
    write('assets/app.js', 'console.log(1)')

    const { client, manifest } = stubClient()
    await uploadFolder(client, folder)
    const m = manifest()

    expect(m.fallback).toBeDefined()
    expect(m.fallback?.id).toBe(m.paths['404.html'].id)
  })

  it('carries an id, not a path — the v0.2.0 spec differs from `index`', async () => {
    write('index.html', '<html>index</html>')
    write('404.html', '<html>fallback</html>')

    const { client, manifest } = stubClient()
    await uploadFolder(client, folder)
    const m = manifest()

    // `index` takes { path }; `fallback` takes { id }. Getting this wrong
    // produces a manifest a gateway silently ignores.
    expect(m.index).toEqual({ path: 'index.html' })
    expect(Object.keys(m.fallback ?? {})).toEqual(['id'])
  })

  it('omits fallback entirely when there is no 404.html and no flag', async () => {
    write('index.html', '<html>index</html>')
    write('assets/app.js', 'console.log(1)')

    const { client, manifest } = stubClient()
    await uploadFolder(client, folder)

    expect(manifest().fallback).toBeUndefined()
  })

  it('honours an explicit fallbackFile over 404.html', async () => {
    write('index.html', '<html>index</html>')
    write('404.html', '<html>fallback</html>')

    const { client, manifest } = stubClient()
    await uploadFolder(client, folder, { fallbackFile: 'index.html' })
    const m = manifest()

    expect(m.fallback?.id).toBe(m.paths['index.html'].id)
    expect(m.fallback?.id).not.toBe(m.paths['404.html'].id)
  })

  it('lets a single-page app opt in without inventing a 404 file', async () => {
    write('index.html', '<html>index</html>')

    const { client, manifest } = stubClient()
    await uploadFolder(client, folder, { fallbackFile: 'index.html' })

    expect(manifest().fallback?.id).toBe(manifest().paths['index.html'].id)
  })

  it('fails loudly when the named fallback file is not in the folder', async () => {
    write('index.html', '<html>index</html>')

    const { client } = stubClient()

    // Silently skipping would ship a manifest whose deep links 404, which is
    // exactly the failure this option exists to prevent.
    await expect(uploadFolder(client, folder, { fallbackFile: 'missing.html' })).rejects.toThrow(
      /Fallback file not found in folder: missing\.html/,
    )
  })
})
