import fs from 'node:fs'

import {
  ARIOToTokenAmount,
  ETHToTokenAmount,
  OnDemandFunding,
  TurboAuthenticatedConfiguration,
  TurboFactory,
} from '@ardrive/turbo-sdk'
import ora from 'ora'

import type { SignerType } from '../types/index.js'
import { cleanupCache, loadCache, saveCache } from '../utils/cache.js'
import { chalk } from '../utils/chalk.js'
import { parseCompressionConfig } from '../utils/compression.js'
import { expandPath } from '../utils/path.js'
import { createSigner } from '../utils/signer.js'
import type { UploadClient, UploadCost, UploadSize } from '../utils/upload-types.js'
import {
  type FolderUploadPlan,
  type FolderUploadResult,
  planFolderUpload,
  uploadFile,
  uploadFolder,
} from '../utils/uploader.js'

export interface UploadWorkflowConfig {
  /** Content-Encoding to compress uploads with: gzip, br, or none. */
  compress?: string
  /** Comma-separated globs of files to upload uncompressed. */
  'compress-exclude'?: string
  'dedupe-cache-max-entries': number
  'deploy-file'?: string
  'deploy-folder': string
  /** Relative path served for routes the manifest does not list. */
  'fallback-file'?: string
  'max-token-amount'?: string
  'on-demand'?: string
  'sig-type': string
  uploader?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export interface UploadWorkflowIo {
  error: (msg: string) => never
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

  const compression = parseCompressionConfig(config.compress, config['compress-exclude'])
  const useCache = config['dedupe-cache-max-entries'] > 0

  /*
   * Plan a folder upload up front: hash every file, skip what the dedupe
   * cache already holds, share uploads between identical files and compress.
   * The credit check then prices what will actually be sent, not the whole
   * folder -- pricing the folder demanded a full-site balance for a one-page
   * change -- and the upload reuses the plan instead of redoing the work.
   */
  let folderPlan: FolderUploadPlan | undefined
  if (!config['deploy-file']) {
    spinner.start('Planning upload')
    try {
      folderPlan = await planFolderUpload(expandPath(config['deploy-folder']), {
        cache: useCache ? loadCache() : {},
        compression,
      })
    } catch (planError) {
      spinner.fail('Failed to plan upload')
      const errorMessage = planError instanceof Error ? planError.message : String(planError)
      io.error(`Failed to plan upload: ${errorMessage}`)
    }

    const { cacheHits, duplicates, files, uploadBytes } = folderPlan
    const toUpload = files.length - cacheHits - duplicates
    spinner.succeed(
      `Upload planned: ${toUpload} of ${files.length} files to upload (${formatBytes(uploadBytes)}` +
        `${compression ? ` after ${compression.encoding}` : ''}), ${cacheHits} cached, ${duplicates} duplicates`,
    )
  }

  if (!fundingMode && turbo) {
    spinner.start('Checking Turbo credits for upload')

    try {
      const uploadBytes = folderPlan
        ? folderPlan.uploadBytes + folderPlan.manifestBytes
        : fs.statSync(expandPath(config['deploy-file']!)).size

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

      let cache = useCache ? loadCache() : {}
      const uploadResult = await uploadFile(uploadClient, filePath, {
        cache,
        compression,
        fundingMode,
      })

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

      const uploadResult: FolderUploadResult = await uploadFolder(uploadClient, folderPath, {
        compression,
        fallbackFile: config['fallback-file'],
        fundingMode,
        plan: folderPlan,
        throwOnFailure: true,
      })

      if (!uploadResult.transactionId) {
        spinner.fail('Folder upload failed: no transaction ID returned')
        io.error('Folder upload failed: no transaction ID returned')
      }

      txOrManifestId = uploadResult.transactionId
      cost = uploadResult.cost
      size = uploadResult.size

      if (uploadResult.updatedCache && useCache) {
        saveCache(cleanupCache(uploadResult.updatedCache, config['dedupe-cache-max-entries']))
      }

      const { cacheHits, duplicates, totalFiles, uploaded } = uploadResult
      const sharedMsg = duplicates > 0 ? `, ${duplicates} duplicates shared` : ''
      const statsMsg =
        cacheHits > 0 || duplicates > 0
          ? chalk.gray(
              ` (${cacheHits}/${totalFiles} files cached${sharedMsg}, ${uploaded} uploaded)`,
            )
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
