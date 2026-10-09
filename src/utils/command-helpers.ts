/**
 * What `deploy` and `upload` share: reading keys, deciding whether a prompt
 * is possible, assembling the upload config, and reporting the outcome. Kept
 * in one place because two hand-maintained copies had drifted into bugs (one
 * command prompted in CI, the other did not; one trimmed keys, the other did
 * not).
 */

import fs from 'node:fs'
import path from 'node:path'

import type { UploadWorkflowConfig, UploadWorkflowResult } from '../workflows/upload-workflow.js'
import { chalk } from './chalk.js'
import { deployKeyFromPrivateKey, deployKeyFromWalletFile } from './deploy-key.js'
import { type DisplayRow, formatUploadError } from './display.js'
import { keyFileInUpload } from './key-safety.js'
import { assertNoPrivateKeys, createKeyScanner } from './key-scan.js'
import { expandPath } from './path.js'
import { type ListedFolder, listFolder } from './uploader.js'
import { validateIncrementalDedupe } from './validators.js'

/**
 * Whether a prompt can be answered: a terminal on both ends and not CI. A
 * prompt anywhere else either hangs a pipeline or exits as if cancelled.
 */
export function canPrompt(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY) && !process.env.CI
}

/** A failure the workflow has already explained; reported as-is, never re-wrapped. */
export class WorkflowError extends Error {
  override name = 'WorkflowError'
}

/** Workflow io that turns a refusal into a `WorkflowError`. */
export const workflowIo = {
  error(message: string): never {
    throw new WorkflowError(message)
  },
}

/** True when the user cancelled an interactive prompt (Ctrl-C at a question). */
export function isPromptCancel(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError'
}

/**
 * Read a key from a wallet file, a private-key string, or an environment
 * variable, in that order, and normalize it to the deploy-key form for its
 * signer type.
 *
 * Environment values are trimmed (secrets often carry a trailing newline).
 * An Arweave key from the environment is already base64 and is left as is;
 * every other type is normalized, which also validates a Solana key before
 * anything is paid for.
 *
 * @throws With `missing` when no source provides a key.
 */
export function resolveKey(key: {
  envVar: string
  missing: string
  privateKey?: string
  sigType: string
  walletPath?: string
}): string {
  if (key.walletPath) {
    const resolvedPath = expandPath(key.walletPath)
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Wallet file [${key.walletPath}] does not exist`)
    }

    return deployKeyFromWalletFile(key.sigType, fs.readFileSync(resolvedPath, 'utf8'))
  }

  if (key.privateKey) {
    return deployKeyFromPrivateKey(key.sigType, key.privateKey)
  }

  const envValue = process.env[key.envVar]?.trim()
  if (envValue) {
    return key.sigType === 'arweave' ? envValue : deployKeyFromPrivateKey(key.sigType, envValue)
  }

  throw new Error(key.missing)
}

/**
 * Refuse an upload that would publish a wallet file the command was given:
 * one inside the deploy folder, or the `--deploy-file` itself. Runs before
 * any key is read or any request is made.
 *
 * @throws A `WorkflowError` naming the wallet.
 */
export function refuseWalletInUpload(
  config: Pick<UploadWorkflowConfig, 'deploy-file' | 'deploy-folder'>,
  walletPaths: Array<string | undefined>,
): void {
  const problem = keyFileInUpload(
    {
      deployFile: config['deploy-file'] && expandPath(config['deploy-file']),
      deployFolder: expandPath(config['deploy-folder']),
    },
    walletPaths.map((walletPath) => walletPath && expandPath(walletPath)),
  )
  if (problem) {
    throw new WorkflowError(problem)
  }
}

/** A wallet file's contents, or undefined when it is missing or not a plausible key file. */
function readKeyFile(file: string): string | undefined {
  try {
    return fs.statSync(file).size <= 1024 * 1024 ? fs.readFileSync(file, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/**
 * Search everything about to be uploaded for every key this run holds, and
 * for anything else shaped like a private key, before any network request.
 *
 * @param keys - Wallet file paths, and key strings from flags and resolved
 *   keys. `DEPLOY_KEY` and `ARNS_KEY` are always included when set.
 * @returns What was searched, for the workflow to upload exactly that.
 * @throws A `WorkflowError` naming the file, never the key.
 */
export async function refuseKeysInUpload(
  config: Pick<UploadWorkflowConfig, 'deploy-file' | 'deploy-folder'>,
  keys: { privateKeys: Array<string | undefined>; walletPaths: Array<string | undefined> },
): Promise<'deploy-file' | ListedFolder> {
  const walletFiles = keys.walletPaths.flatMap((walletPath) =>
    walletPath ? [expandPath(walletPath)] : [],
  )
  const scanner = createKeyScanner(
    [
      ...walletFiles.map((file) => readKeyFile(file)),
      ...keys.privateKeys,
      process.env.DEPLOY_KEY,
      process.env.ARNS_KEY,
    ],
    walletFiles,
  )

  const deployFile = config['deploy-file']
  const folder = expandPath(config['deploy-folder'])
  try {
    if (deployFile) {
      await assertNoPrivateKeys([{ fullPath: expandPath(deployFile), name: deployFile }], scanner)
      return 'deploy-file'
    }

    const listed = listFolder(folder)
    await assertNoPrivateKeys(
      listed.relativePaths.map((name) => ({ fullPath: path.join(folder, name), name })),
      scanner,
    )
    return listed
  } catch (error) {
    throw new WorkflowError(error instanceof Error ? error.message : String(error))
  }
}

export const MISSING_UPLOAD_KEY =
  'No upload key provided. Use --wallet, --private-key, or set DEPLOY_KEY (the key that pays for the upload).'

/**
 * The workflow config from a command's resolved flags, with `--no-dedupe`
 * folded into the cache size.
 *
 * @returns The config, or why the flags contradict each other.
 */
export function uploadWorkflowConfig(
  flags: {
    'dedupe-cache-max-entries': number
    'no-dedupe'?: boolean
  } & Omit<UploadWorkflowConfig, 'dedupe-cache-max-entries'>,
): string | UploadWorkflowConfig {
  const maxEntries = flags['no-dedupe'] ? 0 : flags['dedupe-cache-max-entries']

  /*
   * `--no-dedupe` with --incremental is refused by oclif exclusivity; this
   * catches the other way of saying the same thing, so both spellings fail
   * identically instead of one being silently honoured.
   */
  const conflict = validateIncrementalDedupe(Boolean(flags.incremental), maxEntries)
  if (conflict !== true) {
    return conflict
  }

  return {
    compress: flags.compress,
    'compress-exclude': flags['compress-exclude'],
    'dedupe-cache-max-entries': maxEntries,
    'deploy-file': flags['deploy-file'],
    'deploy-folder': flags['deploy-folder'],
    dev: flags.dev,
    'fallback-file': flags['fallback-file'],
    'ignore-approvals': flags['ignore-approvals'],
    incremental: flags.incremental,
    'incremental-gateway': flags['incremental-gateway'],
    'max-token-amount': flags['max-token-amount'],
    'on-demand': flags['on-demand'],
    'paid-by': flags['paid-by'],
    'payment-url': flags['payment-url'],
    'sig-type': flags['sig-type'],
    uploader: flags.uploader,
    'use-signer-balance-first': flags['use-signer-balance-first'],
  }
}

export const SANDBOX_WARNING =
  'This upload went to the Turbo sandbox for testing. It is not permanent and production gateways do not serve it.'

/**
 * The success table's upload rows. `Tx ID: <id>` is the first line, and is the
 * line the GitHub Action reads its `tx-id` output from.
 */
export function uploadResultRows(
  result: UploadWorkflowResult,
  config: Pick<UploadWorkflowConfig, 'uploader'>,
): DisplayRow[] {
  const rows: DisplayRow[] = [['Tx ID', chalk.green(result.transactionId)]]
  if (config.uploader) {
    rows.push(['Bundler service', chalk.cyan(config.uploader)])
  }

  if (result.development) {
    rows.push(
      ['Turbo', chalk.yellow('development sandbox')],
      ['Warning', chalk.yellow(SANDBOX_WARNING)],
    )
  }

  if (result.gatewayUrl) {
    rows.push(['Arweave URL', chalk.yellow(`${result.gatewayUrl}/${result.transactionId}`)])
  }

  return rows
}

/**
 * Report a command failure once, in the right shape: a readable panel in a
 * terminal, a plain message (exit 2) everywhere else. A workflow refusal is
 * already phrased for the user and is not prefixed again.
 */
export function reportFailure(
  command: {
    error(message: string): never
    exit(code: number): never
    log(message: string): void
  },
  error: unknown,
  title: string,
): never {
  // oclif's own exits and errors carry their exit code; let them through.
  if (error && typeof error === 'object' && 'oclif' in error) {
    throw error
  }

  const message = error instanceof Error ? error.message : String(error)
  if (canPrompt()) {
    command.log(`\n${formatUploadError(message, title)}`)
    command.exit(1)
  }

  return command.error(chalk.red(error instanceof WorkflowError ? message : `${title}: ${message}`))
}
