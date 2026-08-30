import fs from 'node:fs'
import path from 'node:path'

import {
  ARIOToTokenAmount,
  ETHToTokenAmount,
  OnDemandFunding,
  TurboAuthenticatedConfiguration,
  TurboFactory,
} from '@ardrive/turbo-sdk'
import ora from 'ora'

import { APP_NAME, DEFAULT_INCREMENTAL_GATEWAY } from '../constants/incremental.js'
import type { SignerType } from '../types/index.js'
import { cleanupCache, loadCache, saveCache, type TransactionCache } from '../utils/cache.js'
import { chalk } from '../utils/chalk.js'
import { type ChainIndex, createChainIndex } from '../utils/incremental.js'
import { expandPath } from '../utils/path.js'
import { createSigner } from '../utils/signer.js'
import type { UploadClient, UploadCost, UploadSize } from '../utils/upload-types.js'
import {
  type FolderUploadResult,
  type IncrementalOptions,
  uploadFile,
  uploadFolder,
} from '../utils/uploader.js'

export interface UploadWorkflowConfig {
  'dedupe-cache-max-entries': number
  'deploy-file'?: string
  'deploy-folder': string
  /** Relative path served for routes the manifest does not list. */
  'fallback-file'?: string
  /** Opt in to content-hash incremental uploads. */
  incremental?: boolean
  /** Gateway whose GraphQL endpoint answers "have I uploaded these bytes?". */
  'incremental-gateway'?: string
  'max-token-amount'?: string
  'on-demand'?: string
  'sig-type': string
  uploader?: string
}

function getFolderSize(folderPath: string): number {
  let totalSize = 0

  for (const item of fs.readdirSync(folderPath)) {
    const fullPath = path.join(folderPath, item)
    const stats = fs.statSync(fullPath)

    totalSize += stats.isDirectory() ? getFolderSize(fullPath) : stats.size
  }

  return totalSize
}

export interface UploadWorkflowIo {
  error: (msg: string) => never
}

/**
 * Build the chain-backed index, or explain why there is none.
 *
 * The index is keyed on the uploader's own native address: a `File-SHA256`
 * tag is a claim anyone can stamp on any bytes, so only the wallet's own past
 * transactions are trusted to answer "have I already paid for this file?".
 *
 * A wallet whose address cannot be determined is not fatal — the deploy falls
 * back to the local cache alone and uploads what it cannot account for.
 *
 * @param client - Authenticated upload client.
 * @param config - Workflow config carrying the gateway to sweep.
 * @param onWarning - Reports a degraded, still-correct run.
 * @returns The index, or undefined when the owner address is unavailable.
 */
async function createIncrementalIndex(
  client: UploadClient,
  config: UploadWorkflowConfig,
  onWarning: (message: string) => void,
): Promise<ChainIndex | undefined> {
  try {
    const owner = await client.signer?.getNativeAddress()
    if (!owner) {
      onWarning('Incremental uploads: no wallet address available, using the local cache only')
      return undefined
    }

    return createChainIndex({
      appName: APP_NAME,
      gatewayUrl: config['incremental-gateway'] ?? DEFAULT_INCREMENTAL_GATEWAY,
      owner,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onWarning(`Incremental uploads: could not determine the wallet address (${message})`)
    return undefined
  }
}

export interface UploadWorkflowResult {
  cost?: UploadCost
  size?: UploadSize
  transactionId: string
}

/**
 * Sign in to Turbo and upload a file or folder.
 *
 * @param deployKey - Wallet material (base64 JWK or hex private key per sig-type)
 * @param config - Upload paths, dedupe, bundler service URL, on-demand payment
 * @param io - Error handler (must exit the process)
 * @returns Transaction ID or folder manifest ID
 */
export async function runUploadWorkflow(
  deployKey: string,
  config: UploadWorkflowConfig,
  io: UploadWorkflowIo,
): Promise<UploadWorkflowResult> {
  const spinner = ora()

  spinner.start('Creating signer')
  const { signer, token } = createSigner(config['sig-type'] as SignerType, deployKey)
  spinner.succeed(`Signer created (${chalk.cyan(config['sig-type'])})`)

  spinner.start('Initializing Turbo')

  const turboFactoryArgs: TurboAuthenticatedConfiguration = { signer, token }

  if (config.uploader) {
    turboFactoryArgs.uploadServiceConfig = { url: config.uploader }
  }

  const turbo = TurboFactory.authenticated(turboFactoryArgs)
  const uploadClient: UploadClient = turbo as UploadClient

  spinner.succeed('Turbo initialized')

  let fundingMode: OnDemandFunding | undefined
  if (config['on-demand'] && config['max-token-amount']) {
    const tokenType = config['on-demand']
    const maxAmount = Number.parseFloat(config['max-token-amount'])

    let maxTokenAmount: ReturnType<typeof ARIOToTokenAmount>
    switch (tokenType) {
      case 'ario': {
        maxTokenAmount = ARIOToTokenAmount(maxAmount)
        break
      }

      case 'base-eth': {
        maxTokenAmount = ETHToTokenAmount(maxAmount)
        break
      }

      default: {
        throw new Error(`Unsupported on-demand token type: ${tokenType}`)
      }
    }

    fundingMode = new OnDemandFunding({
      maxTokenAmount,
      topUpBufferMultiplier: 1.1,
    })
  }

  if (!fundingMode && turbo) {
    spinner.start('Checking Turbo credits for upload')

    try {
      const uploadBytes = config['deploy-file']
        ? (() => {
            const filePath = expandPath(config['deploy-file']!)
            return fs.statSync(filePath).size
          })()
        : (() => {
            const folderPath = expandPath(config['deploy-folder']!)
            return getFolderSize(folderPath)
          })()

      const FREE_THRESHOLD_BYTES = 107_520 // ~105 KiB

      if (uploadBytes >= FREE_THRESHOLD_BYTES) {
        const [uploadCost] = await turbo.getUploadCosts({ bytes: [uploadBytes] })
        const balance = await turbo.getBalance()

        const requiredWinc = BigInt(uploadCost.winc)
        const currentWinc = BigInt(balance.winc)

        if (requiredWinc > currentWinc) {
          spinner.fail('Insufficient Turbo credits')

          io.error(
            [
              'Insufficient Turbo credits for this upload.',
              `Required: ${requiredWinc.toString()} winc, available: ${currentWinc.toString()} winc.`,
              '',
              'Top up your Turbo balance (or re-run with --on-demand and --max-token-amount).',
            ].join(' '),
          )
        }
      }

      spinner.succeed('Turbo credits check passed')
    } catch (balanceError) {
      spinner.fail('Failed to check Turbo credits')
      const errorMessage =
        balanceError instanceof Error ? balanceError.message : String(balanceError)
      io.error(`Failed to check Turbo credits: ${errorMessage}`)
    }
  }

  let txOrManifestId: string
  let cost: UploadCost | undefined
  let size: UploadSize | undefined
  try {
    if (config['deploy-file']) {
      const filePath = expandPath(config['deploy-file'])
      spinner.start(`Uploading file ${chalk.yellow(config['deploy-file'])}`)

      let cache = config['dedupe-cache-max-entries'] > 0 ? loadCache() : {}
      const uploadResult = await uploadFile(uploadClient, filePath, { cache, fundingMode })

      if (!uploadResult.transactionId) {
        spinner.fail('File upload failed: no transaction ID returned')
        io.error('File upload failed: no transaction ID returned')
      }

      txOrManifestId = uploadResult.transactionId
      cost = uploadResult.cost
      size = uploadResult.size

      if (uploadResult.updatedCache && config['dedupe-cache-max-entries'] > 0) {
        cache = cleanupCache(uploadResult.updatedCache, config['dedupe-cache-max-entries'])
        saveCache(cache)
      }

      if (uploadResult.cacheHit) {
        spinner.succeed(`File cache hit - reusing transaction ${chalk.green(txOrManifestId)}`)
      } else {
        const cacheMsg =
          config['dedupe-cache-max-entries'] > 0 ? chalk.gray('(cached for future uploads)') : ''
        spinner.succeed(`File uploaded: ${chalk.green(txOrManifestId)} ${cacheMsg}`.trim())
      }
    } else {
      const folderPath = expandPath(config['deploy-folder'])
      spinner.start(`Uploading folder ${chalk.yellow(config['deploy-folder'])}`)

      let cache = config['dedupe-cache-max-entries'] > 0 ? loadCache() : {}

      /*
       * Persist every id the moment it lands rather than only at the end of
       * the run. A deploy killed part-way through is the normal case, and an
       * upload that was paid for but forgotten has to be paid for again.
       */
      const persist = (updated: TransactionCache): void => {
        if (config['dedupe-cache-max-entries'] > 0) {
          saveCache(cleanupCache(updated, config['dedupe-cache-max-entries']))
        }
      }

      const incremental: IncrementalOptions | undefined = config.incremental
        ? {
            index: await createIncrementalIndex(uploadClient, config, (message) => {
              spinner.warn(message)
            }),
            onCacheUpdate: persist,
            onWarning: (message) => spinner.warn(message),
          }
        : undefined

      if (incremental) {
        spinner.start(`Uploading folder ${chalk.yellow(config['deploy-folder'])}`)
      }

      const uploadResult: FolderUploadResult = await uploadFolder(uploadClient, folderPath, {
        cache,
        fallbackFile: config['fallback-file'],
        fundingMode,
        incremental,
        throwOnFailure: true,
      })

      if (!uploadResult.transactionId) {
        spinner.fail('Folder upload failed: no transaction ID returned')
        io.error('Folder upload failed: no transaction ID returned')
      }

      txOrManifestId = uploadResult.transactionId
      cost = uploadResult.cost
      size = uploadResult.size

      if (uploadResult.updatedCache && config['dedupe-cache-max-entries'] > 0) {
        cache = cleanupCache(uploadResult.updatedCache, config['dedupe-cache-max-entries'])
        saveCache(cache)
      }

      const { cacheHits, totalFiles, uploaded } = uploadResult
      const statsMsg =
        cacheHits > 0
          ? chalk.gray(` (${cacheHits}/${totalFiles} files cached, ${uploaded} uploaded)`)
          : ''

      if (uploadResult.cacheHit) {
        spinner.succeed(`All ${totalFiles} files cached - manifest: ${chalk.green(txOrManifestId)}`)
      } else {
        const cacheMsg =
          config['dedupe-cache-max-entries'] > 0
            ? chalk.gray(' (files cached for future uploads)')
            : ''
        spinner.succeed(`Folder uploaded: ${chalk.green(txOrManifestId)}${statsMsg}${cacheMsg}`)
      }
    }
  } catch (uploadError) {
    spinner.fail('Upload failed')
    const errorMessage = uploadError instanceof Error ? uploadError.message : String(uploadError)
    io.error(`Upload failed: ${errorMessage}`)
  }

  return {
    cost,
    size,
    transactionId: txOrManifestId,
  }
}
