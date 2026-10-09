/**
 * Make a Solana wallet file the rest of the CLI can read, put it where no
 * deploy picks it up, and keep it out of git. The file is a `solana-keygen`
 * id.json: a JSON array of 64 bytes, the 32-byte secret seed followed by the
 * 32-byte public key.
 */

import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import bs58 from 'bs58'

import { realOrResolved } from './key-safety.js'
import { expandPath } from './path.js'

/** Printed after every new wallet. */
export const BACKUP_LINE =
  'This file is the only copy of this wallet. Back it up somewhere safe and never paste it anywhere.'

export interface GeneratedWallet {
  /** The public address, base58. */
  address: string
  /** The id.json contents: seed then public key. */
  idJson: number[]
}

/** A new ed25519 keypair in id.json form. */
export function generateSolanaWallet(): GeneratedWallet {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const seed = Buffer.from(jwk.d as string, 'base64url')
  const publicKey = Buffer.from(jwk.x as string, 'base64url')
  return {
    address: bs58.encode(publicKey),
    idJson: [...seed, ...publicKey],
  }
}

/**
 * Where `keygen` puts a wallet by default: a per-user folder outside any
 * project, so no `deploy --deploy-folder .` can reach it.
 */
export function defaultWalletFolder(home: string = os.homedir()): string {
  return path.join(home, '.ar.io', 'wallets')
}

/**
 * Turn `--out` into the absolute path of the file to create.
 *
 * @throws When `--out` names a folder: it ends with a path separator or is an
 *   existing directory.
 */
export function resolveOutPath(out: string, platform: NodeJS.Platform = process.platform): string {
  const expanded = expandPath(out)
  const separators = platform === 'win32' ? /[/\\]$/ : /\/$/
  if (separators.test(expanded)) {
    throw new Error(`--out must name a file, not a folder: ${out}`)
  }

  if (fs.existsSync(expanded) && fs.statSync(expanded).isDirectory()) {
    throw new Error(`--out names an existing folder: ${out}. Give the path of a new file.`)
  }

  return path.resolve(expanded)
}

/** Flush a folder's entry for a new file to disk. Not possible on Windows. */
function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  let fd: number | undefined
  try {
    fd = fs.openSync(directory, 'r')
    fs.fsyncSync(fd)
  } catch {
    // Some file systems refuse to sync a directory; the file itself is synced.
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * Write the wallet file and flush it to disk before returning, so success is
 * never reported for a key that a crash could still lose. The `wx` flag makes
 * the existence check and the write one step, so an existing wallet is never
 * overwritten, even by a race. Mode 0600 limits the file to its owner on
 * Linux and macOS; Windows ignores it (see {@link restrictToCurrentUser}).
 *
 * @throws When the file exists or cannot be written. A file that was created
 *   but not fully written is removed.
 */
export function writeWalletFile(file: string, wallet: GeneratedWallet): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let fd: number
  try {
    fd = fs.openSync(file, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `${file} already exists. Choose another path with --out; this command never overwrites a wallet.`,
      )
    }

    throw error
  }

  try {
    fs.writeSync(fd, JSON.stringify(wallet.idJson))
    fs.fsyncSync(fd)
  } catch (error) {
    fs.closeSync(fd)
    fs.rmSync(file, { force: true })
    throw error
  }

  fs.closeSync(fd)
  fsyncDirectory(path.dirname(file))
}

/**
 * Create the default wallet folder, limited to its owner: mode 0700 on Linux
 * and macOS. On Windows the mode is ignored; see {@link restrictToCurrentUser}.
 */
export function createWalletFolder(folder: string): void {
  fs.mkdirSync(folder, { mode: 0o700, recursive: true })
  if (process.platform !== 'win32') {
    fs.chmodSync(folder, 0o700)
  }
}

export interface AclDeps {
  env: NodeJS.ProcessEnv
  /** Runs a program without a shell; throws when it fails or exits non-zero. */
  execFile: (file: string, args: string[]) => void
  platform: NodeJS.Platform
}

const defaultAclDeps: AclDeps = {
  env: process.env,
  execFile(file, args) {
    execFileSync(file, args, { stdio: 'ignore', windowsHide: true })
  },
  platform: process.platform,
}

/**
 * The `icacls` arguments that remove inherited permissions from `target` and
 * give full control to one account only. For a folder the grant is inherited
 * by what is created in it.
 */
export function icaclsArgs(target: string, principal: string, directory: boolean): string[] {
  return [target, '/inheritance:r', '/grant:r', `${principal}:${directory ? '(OI)(CI)F' : 'F'}`]
}

/**
 * On Windows, limit `target` to the current user with `icacls`. A file mode
 * means nothing there, and a new file inherits its folder's permissions,
 * which can let other local accounts read it. Does nothing elsewhere.
 *
 * @returns Why the permissions could not be set, or undefined on success.
 */
export function restrictToCurrentUser(
  target: string,
  { directory = false }: { directory?: boolean } = {},
  deps: AclDeps = defaultAclDeps,
): string | undefined {
  if (deps.platform !== 'win32') {
    return undefined
  }

  const user = deps.env.USERNAME
  if (!user) {
    return 'USERNAME is not set'
  }

  const principal = deps.env.USERDOMAIN ? `${deps.env.USERDOMAIN}\\${user}` : user
  try {
    deps.execFile('icacls', icaclsArgs(target, principal, directory))
    return undefined
  } catch (error) {
    const { status } = error as { status?: unknown }
    return typeof status === 'number'
      ? `icacls exited with code ${status}`
      : error instanceof Error
        ? error.message
        : String(error)
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** True when the git command exits 0. */
function gitSucceeds(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args)
    return true
  } catch {
    return false
  }
}

/**
 * A `.gitignore` line that matches exactly one path, relative to the
 * repository root and `/`-separated. Pattern characters and a backslash are
 * escaped, and so are leading and trailing spaces, which git would otherwise
 * strip or misread.
 */
export function gitignoreEntry(relativePath: string): string {
  const escaped = relativePath
    .replaceAll(/[!#*?[\\\]]/g, String.raw`\$&`)
    .replaceAll(/^ +| +$/g, (spaces) => String.raw`\ `.repeat(spaces.length))
  return `/${escaped}`
}

export interface GitIgnoreResult {
  /** The .gitignore the entry was appended to, when one was. */
  addedTo?: string
  /** False outside a git work tree, or when git is not installed. */
  inRepository: boolean
  /** Problems the user must know about: the file may end up in git. */
  warnings: string[]
}

/**
 * Inside a git work tree, make sure git ignores the wallet: append an entry
 * to the repository's root .gitignore unless git already ignores it, then ask
 * git whether it does and whether the file is tracked. Anything short of
 * "ignored and untracked" is returned as a warning, never hidden.
 */
export function ignoreInGit(file: string): GitIgnoreResult {
  const absolute = realOrResolved(file)
  const directory = path.dirname(absolute)

  let root: string
  try {
    root = realOrResolved(git(directory, ['rev-parse', '--show-toplevel']).trim())
  } catch {
    return { inRepository: false, warnings: [] }
  }

  const warnings: string[] = []
  const relative = path.relative(root, absolute)
  let addedTo: string | undefined

  if (!gitSucceeds(root, ['check-ignore', '-q', absolute])) {
    const entry = gitignoreEntry(relative.split(path.sep).join('/'))
    const ignoreFile = path.join(root, '.gitignore')
    try {
      fs.appendFileSync(ignoreFile, `${needsNewline(ignoreFile) ? '\n' : ''}${entry}\n`, {
        flag: 'a',
      })
      addedTo = ignoreFile
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warnings.push(
        `Could not add the wallet to ${ignoreFile} (${reason}). Add this line to it yourself: ${entry}`,
      )
    }
  }

  if (!gitSucceeds(root, ['check-ignore', '-q', absolute])) {
    warnings.push(
      `git does not ignore ${absolute}. Never commit this file: anyone who reads it controls the wallet.`,
    )
  }

  if (gitSucceeds(root, ['ls-files', '--error-unmatch', absolute])) {
    warnings.push(
      `git already tracks ${absolute}. Remove it from the repository (git rm --cached) and never push it.`,
    )
  }

  return { addedTo: warnings.length === 0 ? addedTo : undefined, inRepository: true, warnings }
}

/** Whether a file exists and its last byte is not a newline. */
function needsNewline(file: string): boolean {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const { size } = fs.fstatSync(fd)
    if (size === 0) return false
    const last = Buffer.alloc(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
