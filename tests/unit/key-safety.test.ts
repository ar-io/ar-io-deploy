import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { captureOutput } from '@oclif/test'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import Deploy from '../../src/commands/deploy.js'
import Upload from '../../src/commands/upload.js'
import { getAllFiles } from '../../src/utils/cache.js'
import { isSameOrInside, keyFileInUpload, looksLikePrivateKey } from '../../src/utils/key-safety.js'
import { generateSolanaWallet } from '../../src/utils/keygen.js'
import { planFileUpload, planFolderUpload } from '../../src/utils/uploader.js'
import { server } from '../setup.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-key-safety-'))
})

afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true })
})

/** A generated id.json; never a real wallet. */
const solanaIdJson = (): string => JSON.stringify(generateSolanaWallet().idJson)

/** The shape of an Arweave JWK private key, with placeholder values. */
const arweaveJwk = JSON.stringify({ d: 'x', e: 'AQAB', kty: 'RSA', n: 'y', p: 'z', q: 'w' })

function site(files: Record<string, string>): string {
  const folder = path.join(dir, 'site')
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true })
    fs.writeFileSync(path.join(folder, name), content)
  }

  return folder
}

describe('looksLikePrivateKey', () => {
  it('recognizes a Solana id.json and an Arweave JWK, with whitespace or a BOM', () => {
    expect(looksLikePrivateKey(solanaIdJson())).toBe(true)
    expect(looksLikePrivateKey(`\uFEFF\n  ${solanaIdJson()}\n`)).toBe(true)
    expect(looksLikePrivateKey(arweaveJwk)).toBe(true)
    expect(looksLikePrivateKey(JSON.stringify({ d: 'x', kty: 'RSA' }))).toBe(true)
  })

  it('leaves ordinary JSON alone', () => {
    expect(looksLikePrivateKey(JSON.stringify(Array.from({ length: 63 }, () => 1)))).toBe(false)
    expect(looksLikePrivateKey(JSON.stringify(Array.from({ length: 64 }, () => 256)))).toBe(false)
    expect(looksLikePrivateKey(JSON.stringify(Array.from({ length: 64 }, () => 1.5)))).toBe(false)
    // A public JWK has no private fields.
    expect(looksLikePrivateKey(JSON.stringify({ e: 'AQAB', kty: 'RSA', n: 'y' }))).toBe(false)
    expect(looksLikePrivateKey('{"name":"app"}')).toBe(false)
    expect(looksLikePrivateKey('<html></html>')).toBe(false)
    expect(looksLikePrivateKey('[1, 2,')).toBe(false)
  })
})

describe('planFolderUpload', () => {
  it('refuses a folder holding a Solana id.json under any name', async () => {
    const folder = site({ 'assets/data.txt': solanaIdJson(), 'index.html': '<p>hi</p>' })
    await expect(planFolderUpload(folder)).rejects.toThrow(
      'assets/data.txt looks like a private key and will not be published',
    )
  })

  it('refuses a folder holding an Arweave JWK', async () => {
    const folder = site({ 'index.html': '<p>hi</p>', 'wallet.json': arweaveJwk })
    await expect(planFolderUpload(folder)).rejects.toThrow(/wallet\.json looks like a private key/)
  })

  it('plans an ordinary folder', async () => {
    const folder = site({ 'data.json': '[1,2,3]', 'index.html': '<p>hi</p>' })
    const plan = await planFolderUpload(folder)
    expect(plan.files.map((file) => file.relativePath).sort()).toEqual(['data.json', 'index.html'])
  })

  it('leaves .git directories out and reports them, at any depth', async () => {
    const folder = site({
      '.git/HEAD': 'ref: refs/heads/main',
      '.git/config': '[core]',
      'index.html': '<p>hi</p>',
      'sub/.git/HEAD': 'ref: refs/heads/main',
      'sub/page.html': '<p>sub</p>',
    })

    const plan = await planFolderUpload(folder)

    expect(plan.files.map((file) => file.relativePath).sort()).toEqual([
      'index.html',
      'sub/page.html',
    ])
    expect(plan.skipped.sort()).toEqual(['.git', 'sub/.git'])
  })

  it('still uploads a file named .git that is not a directory', () => {
    const folder = site({ '.git': 'gitdir: ../elsewhere', 'index.html': '<p>hi</p>' })
    expect(getAllFiles(folder).sort()).toEqual(['.git', 'index.html'])
  })
})

describe('planFileUpload', () => {
  it('refuses a file that is a private key', async () => {
    const file = path.join(dir, 'notes.txt')
    fs.writeFileSync(file, solanaIdJson())
    await expect(planFileUpload(file)).rejects.toThrow(/looks like a private key/)
  })
})

describe('isSameOrInside', () => {
  it('matches the folder itself and anything below it', () => {
    expect(isSameOrInside('/a/b', '/a/b', 'linux')).toBe(true)
    expect(isSameOrInside('/a/b/c/w.json', '/a/b', 'linux')).toBe(true)
    expect(isSameOrInside('/a/bc/w.json', '/a/b', 'linux')).toBe(false)
    expect(isSameOrInside('/a/w.json', '/a/b', 'linux')).toBe(false)
  })

  it('ignores case on Windows and macOS, and only there', () => {
    expect(isSameOrInside('C:\\Site\\Wallet.json', 'c:\\site', 'win32')).toBe(true)
    expect(isSameOrInside('D:\\site\\w.json', 'C:\\site', 'win32')).toBe(false)
    expect(isSameOrInside('/Users/Me/Site/w.json', '/users/me/site', 'darwin')).toBe(true)
    expect(isSameOrInside('/home/Me/Site/w.json', '/home/me/site', 'linux')).toBe(false)
  })
})

describe('keyFileInUpload', () => {
  it('refuses a wallet inside the deploy folder, also as a relative path', () => {
    const folder = site({ 'index.html': '<p>hi</p>', 'w.json': '[]' })
    expect(keyFileInUpload({ deployFolder: folder }, [path.join(folder, 'w.json')])).toMatch(
      /is inside the deploy folder/,
    )
    expect(
      keyFileInUpload({ deployFolder: folder }, [path.relative(process.cwd(), `${folder}/w.json`)]),
    ).toMatch(/is inside the deploy folder/)
  })

  it('refuses the ArNS wallet too, and a wallet that is the deploy file', () => {
    const folder = site({ 'arns.json': '[]', 'index.html': '<p>hi</p>' })
    const outside = path.join(dir, 'w.json')
    expect(
      keyFileInUpload({ deployFolder: folder }, [outside, path.join(folder, 'arns.json')]),
    ).toMatch(/arns\.json is inside the deploy folder/)
    expect(keyFileInUpload({ deployFile: outside, deployFolder: folder }, [outside])).toMatch(
      /is the wallet file/,
    )
  })

  it('sees through a link to the deploy folder', () => {
    const folder = site({ 'index.html': '<p>hi</p>', 'w.json': '[]' })
    const link = path.join(dir, 'link')
    // A junction needs no privileges on Windows; elsewhere the type is ignored.
    fs.symlinkSync(folder, link, 'junction')
    expect(keyFileInUpload({ deployFolder: link }, [path.join(folder, 'w.json')])).toMatch(
      /is inside the deploy folder/,
    )
  })

  it('allows a wallet outside the deploy folder', () => {
    const folder = site({ 'index.html': '<p>hi</p>' })
    expect(keyFileInUpload({ deployFolder: folder }, [path.join(dir, 'w.json')])).toBeUndefined()
    expect(keyFileInUpload({ deployFolder: folder }, [undefined])).toBeUndefined()
  })
})

/** Fails the test if anything reaches the upload or payment service. */
function forbidNetwork(): { requests: string[] } {
  const seen = { requests: [] as string[] }
  server.use(
    http.all('*', ({ request }) => {
      seen.requests.push(request.url)
      return HttpResponse.error()
    }),
  )
  return seen
}

describe('the commands', () => {
  it('upload refuses a deploy folder holding its own wallet, before any request', async () => {
    const seen = forbidNetwork()
    const folder = site({ 'index.html': '<p>hi</p>' })
    const wallet = path.join(folder, 'id.json')
    fs.writeFileSync(wallet, solanaIdJson())

    const { error } = await captureOutput(() =>
      Upload.run(['--sig-type', 'solana', '--wallet', wallet, '--deploy-folder', folder]),
    )

    expect(error?.message).toMatch(/is inside the deploy folder/)
    expect(seen.requests).toEqual([])
  })

  it('upload refuses a --deploy-file that is the wallet, before any request', async () => {
    const seen = forbidNetwork()
    const wallet = path.join(dir, 'id.json')
    fs.writeFileSync(wallet, solanaIdJson())

    const { error } = await captureOutput(() =>
      Upload.run(['--sig-type', 'solana', '--wallet', wallet, '--deploy-file', wallet]),
    )

    expect(error?.message).toMatch(/is the wallet file/)
    expect(seen.requests).toEqual([])
  })

  it('deploy refuses a folder holding another key, before any request', async () => {
    const seen = forbidNetwork()
    const folder = site({ 'index.html': '<p>hi</p>', 'old-wallet.json': solanaIdJson() })
    const wallet = path.join(dir, 'id.json')
    fs.writeFileSync(wallet, solanaIdJson())

    const { error } = await captureOutput(() =>
      Deploy.run(['--sig-type', 'solana', '--wallet', wallet, '--deploy-folder', folder]),
    )

    expect(error?.message).toMatch(/old-wallet\.json looks like a private key/)
    expect(seen.requests).toEqual([])
  })
})
