/**
 * Make a Solana wallet file the rest of the CLI can read, and keep it out of
 * git. The file is a `solana-keygen` id.json: a JSON array of 64 bytes, the
 * 32-byte secret seed followed by the 32-byte public key.
 */

import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import bs58 from 'bs58'

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
 * Write the wallet file, readable by its owner only (Windows ignores the
 * mode). The `wx` flag makes the existence check and the write one step, so
 * an existing wallet is never overwritten, even by a race.
 *
 * @throws When the file exists or cannot be written.
 */
export function writeWalletFile(file: string, wallet: GeneratedWallet): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(file, JSON.stringify(wallet.idJson), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `${file} already exists. Choose another path with --out; this command never overwrites a wallet.`,
      )
    }

    throw error
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * Add the file to the repository's root .gitignore unless git already ignores
 * it. Does nothing outside a git work tree or when git is not installed.
 *
 * @returns The .gitignore that was changed, or undefined.
 */
export function ignoreInGit(file: string): string | undefined {
  const absolute = path.resolve(file)
  const directory = path.dirname(absolute)
  try {
    const root = path.resolve(git(directory, ['rev-parse', '--show-toplevel']).trim())
    try {
      git(directory, ['check-ignore', '-q', absolute])
      return undefined
    } catch {
      // Exit 1 means "not ignored": fall through and add it.
    }

    const entry = `/${path.relative(root, absolute).split(path.sep).join('/')}`
    const ignoreFile = path.join(root, '.gitignore')
    const existing = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : ''
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
    fs.writeFileSync(ignoreFile, `${existing}${separator}${entry}\n`)
    return ignoreFile
  } catch {
    return undefined
  }
}
