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
import {
  type AclDeps,
  BACKUP_LINE,
  generateSolanaWallet,
  gitignoreEntry,
  icaclsArgs,
  ignoreInGit,
  resolveOutPath,
  restrictToCurrentUser,
  writeWalletFile,
} from '../../src/utils/keygen.js'
import { createSigner } from '../../src/utils/signer.js'
import { server } from '../setup.js'

let dir: string
let home: string

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-keygen-')))
  // Never the real home folder: the default wallet location is under it.
  home = path.join(dir, 'home')
  fs.mkdirSync(home)
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
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

  it('flushes the file to disk before returning', () => {
    const file = path.join(dir, 'wallet.json')
    const fsync = vi.spyOn(fs, 'fsyncSync')
    writeWalletFile(file, generateSolanaWallet())
    expect(fsync).toHaveBeenCalled()
  })

  it('removes a file it could not finish writing', () => {
    const file = path.join(dir, 'wallet.json')
    vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    })
    expect(() => writeWalletFile(file, generateSolanaWallet())).toThrow(/no space/)
    expect(fs.existsSync(file)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('is readable by its owner only', () => {
    const file = path.join(dir, 'wallet.json')
    writeWalletFile(file, generateSolanaWallet())
    expect((fs.statSync(file).mode % 0o1000).toString(8)).toBe('600')
  })
})

describe('gitignoreEntry', () => {
  it('anchors the path and escapes what git would read as a pattern', () => {
    expect(gitignoreEntry('sub/wallet.json')).toBe('/sub/wallet.json')
    expect(gitignoreEntry('[a]*?.json')).toBe(String.raw`/\[a\]\*\?.json`)
    expect(gitignoreEntry('#1 !x.json')).toBe(String.raw`/\#1 \!x.json`)
    expect(gitignoreEntry(String.raw`back\slash.json`)).toBe(String.raw`/back\\slash.json`)
    expect(gitignoreEntry('  w.json  ')).toBe(String.raw`/\ \ w.json\ \ `)
  })
})

function init(): void {
  execFileSync('git', ['init', '-q'], { cwd: dir })
}

describe.skipIf(!hasGit)('ignoreInGit', () => {
  it('appends the wallet to the repository root .gitignore, once, and checks git agrees', () => {
    init()
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules')
    fs.mkdirSync(path.join(dir, 'sub'))
    const file = path.join(dir, 'sub', 'wallet.json')
    fs.writeFileSync(file, '[]')

    expect(ignoreInGit(file)).toEqual({
      addedTo: path.join(dir, '.gitignore'),
      inRepository: true,
      warnings: [],
    })
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(
      'node_modules\n/sub/wallet.json\n',
    )

    expect(ignoreInGit(file)).toEqual({ inRepository: true, warnings: [] })
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(
      'node_modules\n/sub/wallet.json\n',
    )
  })

  it('ignores a file whose name holds pattern characters, and only that file', () => {
    init()
    const file = path.join(dir, '[x] #1 !.json')
    fs.writeFileSync(file, '[]')
    fs.writeFileSync(path.join(dir, 'x #1 !.json'), '[]')

    expect(ignoreInGit(file).warnings).toEqual([])
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: dir,
      encoding: 'utf8',
    })
    expect(status).toContain('x #1 !.json')
    expect(status).not.toContain('[x]')
  })

  it('appends instead of rewriting the file', () => {
    init()
    const ignoreFile = path.join(dir, '.gitignore')
    fs.writeFileSync(ignoreFile, 'a\n')
    const file = path.join(dir, 'wallet.json')
    fs.writeFileSync(file, '[]')
    const write = vi.spyOn(fs, 'writeFileSync')

    ignoreInGit(file)

    // Node implements an append as a write with the `a` flag; nothing else may write it.
    expect(write.mock.calls.length).toBeGreaterThan(0)
    for (const call of write.mock.calls) {
      expect(call[2]).toMatchObject({ flag: 'a' })
    }

    expect(fs.readFileSync(ignoreFile, 'utf8')).toBe('a\n/wallet.json\n')
  })

  it('warns, and claims nothing, when .gitignore cannot be written', () => {
    init()
    // A folder where the file belongs makes the append fail on every platform.
    fs.mkdirSync(path.join(dir, '.gitignore'))
    const file = path.join(dir, 'wallet.json')
    fs.writeFileSync(file, '[]')

    const result = ignoreInGit(file)

    expect(result.addedTo).toBeUndefined()
    expect(result.warnings.join('\n')).toMatch(/Could not add the wallet to .*Add this line/)
    expect(result.warnings.join('\n')).toMatch(/git does not ignore/)
  })

  it('warns when git already tracks the file', () => {
    init()
    const file = path.join(dir, 'wallet.json')
    fs.writeFileSync(file, '[]')
    execFileSync('git', ['add', 'wallet.json'], { cwd: dir })

    const result = ignoreInGit(file)

    expect(result.addedTo).toBeUndefined()
    expect(result.warnings.join('\n')).toMatch(/git already tracks/)
  })

  it('does nothing outside a git work tree', () => {
    const file = path.join(home, 'wallet.json')
    fs.writeFileSync(file, '[]')
    expect(ignoreInGit(file)).toEqual({ inRepository: false, warnings: [] })
    expect(fs.existsSync(path.join(home, '.gitignore'))).toBe(false)
  })
})

describe('resolveOutPath', () => {
  it('expands ~ to the home folder', () => {
    expect(resolveOutPath('~/w.json')).toBe(path.join(home, 'w.json'))
  })

  it('refuses a path that ends with a separator or names a folder', () => {
    expect(() => resolveOutPath('wallets/', 'linux')).toThrow(/must name a file/)
    expect(() => resolveOutPath('wallets\\', 'win32')).toThrow(/must name a file/)
    expect(() => resolveOutPath(dir)).toThrow(/existing folder/)
  })
})

/** Fake `icacls` runner: records each call. */
function aclDeps(overrides: Partial<AclDeps> = {}): { calls: string[][] } & AclDeps {
  const calls: string[][] = []
  return {
    calls,
    env: { USERDOMAIN: 'BOX', USERNAME: 'me' },
    execFile(file, args) {
      calls.push([file, ...args])
    },
    platform: 'win32',
    ...overrides,
  }
}

describe('restrictToCurrentUser', () => {
  it('removes inherited permissions and grants the current user alone, without a shell', () => {
    const fake = aclDeps()
    expect(restrictToCurrentUser(String.raw`C:\w.json`, {}, fake)).toBeUndefined()
    expect(fake.calls).toEqual([
      ['icacls', String.raw`C:\w.json`, '/inheritance:r', '/grant:r', String.raw`BOX\me:F`],
    ])
  })

  it('makes the grant inherited for a folder', () => {
    const fake = aclDeps()
    restrictToCurrentUser('C:/w', { directory: true }, fake)
    expect(fake.calls[0].at(-1)).toBe(String.raw`BOX\me:(OI)(CI)F`)
    expect(icaclsArgs('C:/w', 'me', false)).toEqual(['C:/w', '/inheritance:r', '/grant:r', 'me:F'])
  })

  it('reports a failed icacls with its exit code', () => {
    const fake = aclDeps({
      execFile() {
        throw Object.assign(new Error('Command failed'), { status: 5 })
      },
    })
    expect(restrictToCurrentUser('C:/w.json', {}, fake)).toBe('icacls exited with code 5')
  })

  it('reports a missing user name instead of granting nobody', () => {
    const fake = aclDeps({ env: {} })
    expect(restrictToCurrentUser('C:/w.json', {}, fake)).toMatch(/USERNAME/)
    expect(fake.calls).toEqual([])
  })

  it('does nothing outside Windows', () => {
    const fake = aclDeps({ platform: 'linux' })
    expect(restrictToCurrentUser('/w.json', {}, fake)).toBeUndefined()
    expect(fake.calls).toEqual([])
  })
})

const walletBytes = (file: string): number[] => JSON.parse(fs.readFileSync(file, 'utf8'))

/** Run the command from source, returning what it logged, warned and raised. */
async function keygen(
  args: string[],
): Promise<{ error?: Error; stdout: string; warnings: string }> {
  const lines: string[] = []
  const warned: string[] = []
  const log = vi.spyOn(Keygen.prototype, 'log').mockImplementation((line?: string) => {
    lines.push(line ?? '')
  })
  const warn = vi.spyOn(Keygen.prototype, 'warn').mockImplementation((input: Error | string) => {
    warned.push(String(input))
    return input
  })
  let error: Error | undefined
  try {
    await Keygen.run(args)
  } catch (error_) {
    error = error_ as Error
  } finally {
    log.mockRestore()
    warn.mockRestore()
  }

  return { error, stdout: lines.join('\n'), warnings: warned.join('\n') }
}

function allowance(body: Parameters<typeof HttpResponse.json>[0], status = 200): void {
  server.use(
    http.get('https://payment.ardrive.io/v1/account/free', () =>
      HttpResponse.json(body, { status }),
    ),
  )
}

describe('keygen command', () => {
  it('prints the path, the address, the free allowance and the next command, never the secret', async () => {
    const file = path.join(dir, 'wallet.json')
    allowance({ bytesRemaining: 10 * 1024 * 1024 })

    const { error, stdout } = await keygen(['--out', file])

    expect(error).toBeUndefined()
    const bytes = walletBytes(file)
    expect(stdout).toContain(file)
    expect(stdout).toContain(bs58.encode(Uint8Array.from(bytes.slice(32))))
    expect(stdout).toContain('10.0 MiB')
    expect(stdout).toContain(BACKUP_LINE)
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
    expect(stdout).toMatch(/Free upload allowance: unknown/)
  })

  it('calls a 404 or a missing figure unknown, never unlimited', async () => {
    allowance({}, 404)
    const notFound = await keygen(['--out', path.join(dir, 'a.json')])
    expect(notFound.stdout).toContain(
      'Free upload allowance: unknown (the payment service answered 404)',
    )

    allowance({})
    const empty = await keygen(['--out', path.join(dir, 'b.json')])
    expect(empty.stdout).toMatch(/Free upload allowance: unknown/)

    expect(`${notFound.stdout}${empty.stdout}`).not.toMatch(/unlimited/)
  })

  it('says unlimited only when the service says so', async () => {
    allowance({ bytesRemaining: null })
    const { stdout } = await keygen(['--out', path.join(dir, 'a.json')])
    expect(stdout).toContain('Free upload allowance: unlimited')
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

  it('writes to a per-user folder outside any project by default', async () => {
    allowance({ bytesRemaining: 0 })

    const { error, stdout, warnings } = await keygen([])

    expect(error).toBeUndefined()
    const folder = path.join(home, '.ar.io', 'wallets')
    const [name] = fs.readdirSync(folder)
    const file = path.join(folder, name)
    const bytes = walletBytes(file)
    expect(name).toBe(`${bs58.encode(Uint8Array.from(bytes.slice(32)))}.json`)
    expect(stdout).toContain(`Wallet file: ${file}`)
    expect(stdout).toContain(`--wallet ${file} --deploy-folder ./dist`)
    expect(warnings).toBe('')
    if (process.platform !== 'win32') {
      expect((fs.statSync(folder).mode % 0o1000).toString(8)).toBe('700')
    }
  })

  it('expands ~ in --out', async () => {
    allowance({ bytesRemaining: 0 })
    const { error } = await keygen(['--out', '~/my-wallet.json'])
    expect(error).toBeUndefined()
    expect(walletBytes(path.join(home, 'my-wallet.json'))).toHaveLength(64)
  })

  it('refuses an --out that names a folder', async () => {
    const trailing = await keygen(['--out', `${dir}${path.sep}`])
    expect(trailing.error?.message).toMatch(/must name a file/)
    const existing = await keygen(['--out', dir])
    expect(existing.error?.message).toMatch(/existing folder/)
  })

  it('warns when --out is inside the current folder, and not otherwise', async () => {
    allowance({ bytesRemaining: 0 })
    const project = path.join(dir, 'project')
    fs.mkdirSync(project)
    vi.spyOn(process, 'cwd').mockReturnValue(project)

    const inside = await keygen(['--out', path.join(project, 'w.json')])
    expect(inside.warnings).toMatch(/must never be inside a folder you deploy/)

    const outside = await keygen(['--out', path.join(home, 'w.json')])
    expect(outside.warnings).not.toMatch(/must never be inside/)
  })

  it('warns for the default path too, when the home folder is the current folder', async () => {
    allowance({ bytesRemaining: 0 })
    vi.spyOn(process, 'cwd').mockReturnValue(home)

    const { warnings } = await keygen([])

    expect(warnings).toMatch(/must never be inside a folder you deploy/)
  })

  it('keeps the default wallet folder off the name the GitHub Action caches', async () => {
    allowance({ bytesRemaining: 0 })
    const { stdout } = await keygen([])
    const action = fs.readFileSync(new URL('../../action.yml', import.meta.url), 'utf8')
    const cached = [...action.matchAll(/^\s*path:\s*(\S+)/gm)].map(([, cached]) => cached)

    expect(cached.length).toBeGreaterThan(0)
    for (const cachedPath of cached) {
      const top = cachedPath.split('/')[0]
      expect(stdout).not.toContain(`${path.sep}${top}${path.sep}`)
    }
  })

  it('refuses to overwrite a wallet', async () => {
    const file = path.join(dir, 'wallet.json')
    fs.writeFileSync(file, 'precious')

    const { error } = await keygen(['--out', file])

    expect(error?.message).toMatch(/already exists/)
    expect(fs.readFileSync(file, 'utf8')).toBe('precious')
  })

  it.skipIf(process.platform !== 'win32')(
    'limits the file to the current Windows user',
    async () => {
      allowance({ bytesRemaining: 0 })
      const file = path.join(dir, 'w.json')

      const { warnings } = await keygen(['--out', file])

      expect(warnings).toBe('')
      const acl = execFileSync('icacls', [file], { encoding: 'utf8' })
      expect(acl).toContain(`${process.env.USERNAME}:(F)`)
      expect(acl).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/)
    },
  )
})
