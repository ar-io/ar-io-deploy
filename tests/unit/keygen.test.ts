import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HexSolanaSigner } from '@ardrive/turbo-sdk'
import bs58 from 'bs58'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Keygen from '../../src/commands/keygen.js'
import { resolveKey } from '../../src/utils/command-helpers.js'
import { generateSolanaWallet, ignoreInGit, writeWalletFile } from '../../src/utils/keygen.js'
import { createSigner } from '../../src/utils/signer.js'
import { server } from '../setup.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-keygen-'))
})

afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true })
})

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('generateSolanaWallet', () => {
  it('makes a 64-byte id.json: the secret seed, then the public key', () => {
    const wallet = generateSolanaWallet()
    expect(wallet.idJson).toHaveLength(64)
    expect(wallet.idJson.every((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256)).toBe(
      true,
    )
    expect(bs58.encode(Uint8Array.from(wallet.idJson.slice(32)))).toBe(wallet.address)
  })

  it('makes a different wallet each time', () => {
    expect(generateSolanaWallet().address).not.toBe(generateSolanaWallet().address)
  })
})

describe('writeWalletFile', () => {
  it('writes a file the key loader accepts, for the address it reports', async () => {
    const file = path.join(dir, 'wallet.json')
    const wallet = generateSolanaWallet()
    writeWalletFile(file, wallet)

    const deployKey = resolveKey({
      envVar: 'DEPLOY_KEY',
      missing: 'missing',
      sigType: 'solana',
      walletPath: file,
    })
    expect(bs58.decode(deployKey)).toHaveLength(64)

    // The signer derives the same address from the file as keygen printed.
    const { signer } = createSigner('solana', deployKey)
    expect(bs58.encode((signer as HexSolanaSigner).publicKey)).toBe(wallet.address)
  })

  it('refuses to overwrite an existing file and leaves it untouched', () => {
    const file = path.join(dir, 'wallet.json')
    fs.writeFileSync(file, 'precious')
    expect(() => writeWalletFile(file, generateSolanaWallet())).toThrow(/already exists/)
    expect(fs.readFileSync(file, 'utf8')).toBe('precious')
  })

  it.skipIf(process.platform === 'win32')('is readable by its owner only', () => {
    const file = path.join(dir, 'wallet.json')
    writeWalletFile(file, generateSolanaWallet())
    expect((fs.statSync(file).mode % 0o1000).toString(8)).toBe('600')
  })
})

describe.skipIf(!hasGit)('ignoreInGit', () => {
  it('adds the wallet to the repository root .gitignore, once', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules')
    fs.mkdirSync(path.join(dir, 'sub'))
    const file = path.join(dir, 'sub', 'wallet.json')
    fs.writeFileSync(file, '[]')

    expect(ignoreInGit(file)).toBeDefined()
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(
      'node_modules\n/sub/wallet.json\n',
    )

    expect(ignoreInGit(file)).toBeUndefined()
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(
      'node_modules\n/sub/wallet.json\n',
    )
  })

  it('does nothing outside a git work tree', () => {
    const file = path.join(dir, 'wallet.json')
    fs.writeFileSync(file, '[]')
    expect(ignoreInGit(file)).toBeUndefined()
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false)
  })
})

const walletBytes = (file: string): number[] => JSON.parse(fs.readFileSync(file, 'utf8'))

/** Run the command from source, returning what it logged and the error it raised. */
async function keygen(args: string[]): Promise<{ error?: Error; stdout: string }> {
  const lines: string[] = []
  const log = vi.spyOn(Keygen.prototype, 'log').mockImplementation((line?: string) => {
    lines.push(line ?? '')
  })
  try {
    await Keygen.run(args)
    return { stdout: lines.join('\n') }
  } catch (error) {
    return { error: error as Error, stdout: lines.join('\n') }
  } finally {
    log.mockRestore()
  }
}

describe('keygen command', () => {
  it('prints the path, the address, the free allowance and the next command, never the secret', async () => {
    const file = path.join(dir, 'wallet.json')
    server.use(
      http.get('https://payment.ardrive.io/v1/account/free', () =>
        HttpResponse.json({ bytesRemaining: 10 * 1024 * 1024 }),
      ),
    )

    const { error, stdout } = await keygen(['--out', file])

    expect(error).toBeUndefined()
    const bytes = walletBytes(file)
    expect(stdout).toContain(file)
    expect(stdout).toContain(bs58.encode(Uint8Array.from(bytes.slice(32))))
    expect(stdout).toContain('10.0 MiB')
    expect(stdout).toContain(
      `ario-deploy deploy --sig-type solana --wallet ${file} --deploy-folder ./dist`,
    )
    expect(stdout).not.toContain(bs58.encode(Uint8Array.from(bytes.slice(0, 32))))
    expect(stdout).not.toContain(bs58.encode(Uint8Array.from(bytes)))
    expect(stdout).not.toMatch(/(?:\d+,\s*){2}\d+/)
  })

  it('succeeds with one line when the allowance cannot be read', async () => {
    const file = path.join(dir, 'wallet.json')
    server.use(http.get('https://payment.ardrive.io/v1/account/free', () => HttpResponse.error()))

    const { error, stdout } = await keygen(['--out', file])

    expect(error).toBeUndefined()
    expect(fs.existsSync(file)).toBe(true)
    expect(stdout).toMatch(/Could not read the free upload allowance/)
  })

  it('asks the sandbox for the allowance with --dev', async () => {
    const file = path.join(dir, 'wallet.json')
    let asked = ''
    server.use(
      http.get('https://payment.services.ar-io.dev/v1/account/free', ({ request }) => {
        asked = request.url
        return HttpResponse.json({ bytesRemaining: 1024 })
      }),
    )

    const { stdout } = await keygen(['--out', file, '--dev'])

    expect(asked).toContain('/v1/account/free')
    expect(stdout).toContain('1.0 KiB')
    expect(stdout).toContain('--deploy-folder ./dist --dev')
  })

  it('refuses to overwrite a wallet', async () => {
    const file = path.join(dir, 'wallet.json')
    fs.writeFileSync(file, 'precious')

    const { error } = await keygen(['--out', file])

    expect(error?.message).toMatch(/already exists/)
    expect(fs.readFileSync(file, 'utf8')).toBe('precious')
  })
})
