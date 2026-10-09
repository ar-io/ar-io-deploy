/**
 * Keep wallet files out of uploads by where they are: a wallet named with
 * `--wallet` or `--arns-wallet` must not be inside the deploy folder, or be
 * the `--deploy-file`. What is inside each file is checked by `key-scan.ts`.
 */

import fs from 'node:fs'
import path from 'node:path'

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
 * Whether two paths are one file: the same device and inode, which also
 * catches a hard link that no path comparison can see.
 */
export function isSameFile(a: string, b: string): boolean {
  try {
    const first = fs.statSync(a, { bigint: true })
    const second = fs.statSync(b, { bigint: true })
    return first.ino !== 0n && first.dev === second.dev && first.ino === second.ino
  } catch {
    return false
  }
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
    const match = wallets.find(
      (wallet) =>
        isSameOrInside(realOrResolved(wallet), file) || isSameFile(wallet, target.deployFile!),
    )
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
