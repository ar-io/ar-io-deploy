import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAllFiles, loadCache } from '../../src/utils/cache.js'
import type { UploadClient } from '../../src/utils/upload-types.js'
import { uploadFolder } from '../../src/utils/uploader.js'

let dir: string
let cwdSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-fail-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(dir, { force: true, recursive: true })
})

function folderOf(count: number): string {
  const folder = path.join(dir, 'site')
  fs.mkdirSync(folder, { recursive: true })
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(folder, `f${i}.txt`), `file ${i}`)
  }

  return folder
}

describe('uploadFolder when an upload fails', () => {
  it('starts no new uploads after the first failure, so an outage costs one round of retries', async () => {
    const folder = folderOf(5)
    let attempts = 0
    const client: UploadClient = {
      async uploadFile() {
        attempts += 1
        throw new Error('503 Service Unavailable')
      },
    }

    await expect(uploadFolder(client, folder, { concurrency: 1 })).rejects.toThrow(
      /Failed to upload f\d\.txt: 503/,
    )
    expect(attempts).toBe(1)
  })

  it('names the file that failed', async () => {
    const folder = folderOf(1)
    const client: UploadClient = {
      async uploadFile() {
        return {}
      },
    }

    await expect(uploadFolder(client, folder)).rejects.toThrow(
      'Failed to upload f0.txt: upload result missing transaction ID',
    )
  })
})

describe('getAllFiles', () => {
  it('refuses a symlink that points outside the deploy folder', () => {
    const folder = folderOf(1)
    const secret = path.join(dir, 'secret.txt')
    fs.writeFileSync(secret, 'do not publish')
    fs.symlinkSync(secret, path.join(folder, 'leak.txt'))

    expect(() => getAllFiles(folder)).toThrow(/leak\.txt links outside the deploy folder/)
  })

  it('follows a symlink that stays inside it', () => {
    const folder = folderOf(1)
    fs.symlinkSync(path.join(folder, 'f0.txt'), path.join(folder, 'alias.txt'))

    expect(getAllFiles(folder).sort()).toEqual(['alias.txt', 'f0.txt'])
  })
})

describe('loadCache', () => {
  it('drops entries whose id is not an Arweave id, so a manifest never silently omits a file', () => {
    fs.mkdirSync(path.join(dir, '.ario-deploy'))
    const good = { createdAtTimestamp: 1, lastUsedTimestamp: 1, transactionId: 'a'.repeat(43) }
    fs.writeFileSync(
      path.join(dir, '.ario-deploy', 'transaction-cache.json'),
      JSON.stringify({ bad: { transactionId: 'nope' }, good, missing: {} }),
    )

    expect(loadCache()).toEqual({ good })
  })

  it('treats a cache that is not an object as empty', () => {
    fs.mkdirSync(path.join(dir, '.ario-deploy'))
    fs.writeFileSync(path.join(dir, '.ario-deploy', 'transaction-cache.json'), 'null')

    expect(loadCache()).toEqual({})
  })

  it('keeps each network in its own file', () => {
    fs.mkdirSync(path.join(dir, '.ario-deploy'))
    const entry = { createdAtTimestamp: 1, lastUsedTimestamp: 1, transactionId: 'b'.repeat(43) }
    fs.writeFileSync(
      path.join(dir, '.ario-deploy', 'transaction-cache.upload.services.ar-io.dev.json'),
      JSON.stringify({ k: entry }),
    )

    expect(loadCache()).toEqual({})
    expect(loadCache('upload.services.ar-io.dev')).toEqual({ k: entry })
  })
})
