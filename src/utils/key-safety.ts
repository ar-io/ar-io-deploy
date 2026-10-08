/**
 * Keep private keys out of uploads. An Arweave upload is permanent and public,
 * so a wallet file that lands in the upload set can never be taken back: its
 * funds and its ArNS names belong to anyone who reads it.
 *
 * Two checks, both before any network call:
 * - a wallet file named with `--wallet` or `--arns-wallet` must not be inside
 *   the deploy folder, or be the `--deploy-file`;
 * - no file in the upload set may parse as a private key, whatever its name.
 *
 * The content check covers the two JSON shapes this CLI reads: a Solana
 * `id.json` (a JSON array of exactly 64 bytes) and an Arweave JWK. It does
 * not recognize keys stored as PEM, hex or base58 text.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Files larger than this are not read for the content check. A Solana
 * id.json is under 300 bytes and a 4096-bit Arweave JWK is about 3.3 KiB.
 */
export const KEY_SCAN_MAX_BYTES = 64 * 1024

/** True when `content` is a Solana id.json or an Arweave JWK private key. */
export function looksLikePrivateKey(content: string): boolean {
  const trimmed = content.replace(/^\uFEFF/, '').trim()
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    return false
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return false
  }

  if (Array.isArray(parsed)) {
    return (
      parsed.length === 64 &&
      parsed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    )
  }

  if (parsed && typeof parsed === 'object') {
    const jwk = parsed as Record<string, unknown>
    return jwk.kty === 'RSA' && ['d', 'p', 'q'].some((field) => typeof jwk[field] === 'string')
  }

  return false
}

function privateKeyMessage(name: string): string {
  return `${name} looks like a private key and will not be published. Arweave uploads are permanent and public. Move the file out of what you upload.`
}

/**
 * Refuse a file that parses as a private key.
 *
 * @param fullPath - The file on disk.
 * @param name - How to name it in the error (a path relative to the folder).
 * @throws When the file looks like a private key.
 */
export function assertNotPrivateKey(fullPath: string, name: string): void {
  const stats = fs.statSync(fullPath)
  if (!stats.isFile() || stats.size > KEY_SCAN_MAX_BYTES) {
    return
  }

  if (looksLikePrivateKey(fs.readFileSync(fullPath, 'utf8'))) {
    throw new Error(privateKeyMessage(name))
  }
}

/**
 * The real path of `file`, or, when it does not exist, the real path of the
 * nearest folder above it that does, with the rest appended.
 */
export function realOrResolved(file: string): string {
  const absolute = path.resolve(file)
  try {
    return fs.realpathSync.native(absolute)
  } catch {
    const parent = path.dirname(absolute)
    return parent === absolute
      ? absolute
      : path.join(realOrResolved(parent), path.basename(absolute))
  }
}

/**
 * Whether `child` is `parent` or inside it, for already-resolved absolute
 * paths. Windows and macOS file systems are case-insensitive by default, so
 * case is ignored there: refusing a safe path by mistake costs a retry,
 * missing an unsafe one costs the wallet.
 */
export function isSameOrInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const fold = platform === 'win32' || platform === 'darwin'
  const normalize = (value: string): string => {
    const resolved = paths.resolve(value)
    return fold ? resolved.toLowerCase() : resolved
  }

  const relative = paths.relative(normalize(parent), normalize(child))
  return relative === '' || (!relative.startsWith('..') && !paths.isAbsolute(relative))
}

/**
 * Refuse an upload that would publish one of the key files the command was
 * given. Paths are compared after resolving symlinks, so a link to the deploy
 * folder does not hide a wallet inside it.
 *
 * @param target - What will be uploaded: a folder, or one file.
 * @param walletFiles - `--wallet` and `--arns-wallet`, as given (already `~`-expanded).
 * @returns Why the upload is refused, or undefined.
 */
export function keyFileInUpload(
  target: { deployFile?: string; deployFolder: string },
  walletFiles: Array<string | undefined>,
): string | undefined {
  const wallets = walletFiles.filter((file): file is string => file !== undefined && file !== '')
  if (wallets.length === 0) {
    return undefined
  }

  if (target.deployFile) {
    const file = realOrResolved(target.deployFile)
    const match = wallets.find((wallet) => isSameOrInside(realOrResolved(wallet), file))
    return match
      ? `${target.deployFile} is the wallet file ${match}. A wallet will not be published: Arweave uploads are permanent and public.`
      : undefined
  }

  const folder = realOrResolved(target.deployFolder)
  const match = wallets.find((wallet) => isSameOrInside(realOrResolved(wallet), folder))
  return match
    ? `The wallet file ${match} is inside the deploy folder ${target.deployFolder}. A wallet will not be published: Arweave uploads are permanent and public. Move the wallet outside the folder you deploy.`
    : undefined
}
