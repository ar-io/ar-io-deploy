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

import {
  APP_NAME,
  CACHE_FLUSH_INTERVAL_MS,
  DEFAULT_INCREMENTAL_GATEWAY,
} from '../constants/incremental.js'
import type { SignerType } from '../types/index.js'
import { cleanupCache, loadCache, saveCache, type TransactionCache } from '../utils/cache.js'
import { chalk } from '../utils/chalk.js'
import {
  type ChainIndex,
  createChainIndex,
  ownerAddressFromPublicKey,
} from '../utils/incremental.js'
import { expandPath } from '../utils/path.js'
import { createSigner } from '../utils/signer.js'
import type { UploadClient, UploadCost, UploadSize } from '../utils/upload-types.js'
import {
  type FolderUploadPlan,
  type FolderUploadResult,
  type IncrementalOptions,
  planFolderUpload,
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
 * The index is scoped to the uploading wallet: a `File-SHA256` tag is a claim
 * anyone can stamp on any bytes, so only the wallet's own past transactions
 * are trusted to answer "have I already paid for this file?".
 *
 * The address is derived from the signer's public key rather than taken from
 * `getNativeAddress()`, which returns a chain-native form for four of the five
 * supported signer types that no gateway indexes as an owner. See
 * `ownerAddressFromPublicKey`.
 *
 * A wallet whose address cannot be derived is not fatal — the deploy falls
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
    const publicKey = await client.signer?.getPublicKey()
    if (!publicKey || publicKey.length === 0) {
      onWarning('Incremental uploads: no wallet public key available, using the local cache only')
      return undefined
    }

    /*
     * Derived from the public key, never from `getNativeAddress()`.
     * `createChainIndex` refuses anything that is not a gateway-shaped
     * address, so a bad derivation surfaces as a warning here rather than as
     * a query that can only ever match nothing.
     */
    const owner = ownerAddressFromPublicKey(publicKey)

    return createChainIndex({
      appName: APP_NAME,
      gatewayUrl: config['incremental-gateway'] ?? DEFAULT_INCREMENTAL_GATEWAY,
      onWarning,
      owner,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onWarning(`Incremental uploads: could not derive the wallet address (${message})`)
    return undefined
  }
}

export interface CacheWriter {
  /** Stop the timer and drop the signal handlers. */
  dispose: () => void
  /** Write anything outstanding right now. */
  flush: () => void
  /** Offer a new cache state; written on the leading edge or shortly after. */
  record: (cache: TransactionCache) => void
}

/** Re-raise a signal so the process still exits with the right code. */
function reRaise(signal: NodeJS.Signals): void {
  process.kill(process.pid, signal)
}

/**
 * A cache writer that survives an interrupt without amplifying it.
 *
 * Recording an id only at the end of a run loses everything a killed deploy
 * already paid for. Writing all of them, one synchronous `writeFileSync` per
 * upload, is worse: at the default 10,000-entry cap the file reaches a couple
 * of megabytes, so a 143-file deploy rewrites hundreds of megabytes of
 * blocking I/O on the event loop the concurrent upload workers share.
 *
 * So writes fire on the leading edge and are then coalesced — but a leading
 * edge alone is a throttle, not a debounce: when ten uploads land together the
 * last nine would sit unwritten until the next batch arrived. The trailing
 * timer is what makes the guarantee real, and it is unref'd so it can never
 * hold the process open on its own.
 *
 * Ctrl-C is how a deploy usually dies, and a bare SIGINT runs no `finally`, so
 * the signal handlers are part of the durability rather than a nicety.
 *
 * @param maxEntries - LRU bound applied before each write; 0 disables writing.
 * @param options - `raise` is injectable so tests can assert the re-raise
 *   without killing the test runner.
 * @returns The writer. `dispose` must be called, or the handlers leak.
 */
export function createCacheWriter(
  maxEntries: number,
  { raise = reRaise }: { raise?: (signal: NodeJS.Signals) => void } = {},
): CacheWriter {
  let pending: TransactionCache | undefined
  let lastWrite = 0
  let timer: NodeJS.Timeout | undefined

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const write = (): void => {
    clear()
    if (!pending || maxEntries <= 0) {
      pending = undefined
      return
    }

    saveCache(cleanupCache(pending, maxEntries))
    lastWrite = Date.now()
    pending = undefined
  }

  const onSignal = (signal: NodeJS.Signals): void => {
    write()
    dispose()
    raise(signal)
  }

  const handlers: Array<[NodeJS.Signals, () => void]> = (
    ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]
  ).map((signal) => [signal, () => onSignal(signal)])

  for (const [signal, handler] of handlers) {
    process.once(signal, handler)
  }

  function dispose(): void {
    clear()
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler)
    }
  }

  return {
    dispose,
    flush: write,
    record(cache: TransactionCache) {
      pending = cache
      if (Date.now() - lastWrite >= CACHE_FLUSH_INTERVAL_MS) {
        write()
        return
      }

      /*
       * A quiet period must still reach the disk. Without this the last burst
       * of a deploy stays in memory until something else happens to it.
       */
      if (!timer) {
        timer = setTimeout(write, CACHE_FLUSH_INTERVAL_MS)
        timer.unref?.()
      }
    },
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

  /*
   * Spinner phase, so a warning can restore whatever line was showing. Any
   * `spinner.warn` stops the spinner, and a chain-index warning arrives in the
   * middle of a phase.
   */
  let phase = ''
  const startPhase = (message: string): void => {
    phase = message
    spinner.start(message)
  }

  const warn = (message: string): void => {
    spinner.warn(message)
    if (phase) {
      spinner.start(phase)
    }
  }

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

  /*
   * An incremental folder deploy is planned before the credits check, so the
   * quote prices what will actually be sent. Pricing the whole folder would
   * refuse a two-chunk redeploy for want of credits for the entire bundle —
   * exactly the deploy this flag exists to make cheap.
   */
  const incrementalFolder = Boolean(config.incremental) && !config['deploy-file']
  const writer = incrementalFolder
    ? createCacheWriter(config['dedupe-cache-max-entries'])
    : undefined

  let folderCache: TransactionCache = {}
  let incremental: IncrementalOptions | undefined
  let folderPlan: FolderUploadPlan | undefined

  if (incrementalFolder && writer) {
    try {
      folderCache = config['dedupe-cache-max-entries'] > 0 ? loadCache() : {}
      incremental = {
        index: await createIncrementalIndex(uploadClient, config, warn),
        onCacheUpdate: writer.record,
        onWarning: warn,
      }

      startPhase(`Checking ${chalk.yellow(config['deploy-folder'])} against previous uploads`)
      folderPlan = await planFolderUpload(expandPath(config['deploy-folder']), {
        cache: folderCache,
        fallbackFile: config['fallback-file'],
        incremental,
      })
      phase = ''
      spinner.succeed(
        `${folderPlan.cacheHits}/${folderPlan.tasks.length} files already on Arweave, ` +
          `${folderPlan.uploadTargets.length} to upload`,
      )
    } catch (planError) {
      writer.dispose()
      spinner.fail('Upload failed')
      const message = planError instanceof Error ? planError.message : String(planError)
      io.error(`Upload failed: ${message}`)
    }
  }

  if (!fundingMode && turbo) {
    spinner.start('Checking Turbo credits for upload')

    try {
      const uploadBytes = config['deploy-file']
        ? (() => {
            const filePath = expandPath(config['deploy-file']!)
            return fs.statSync(filePath).size
          })()
        : (folderPlan?.pendingBytes ??
          (() => {
            const folderPath = expandPath(config['deploy-folder']!)
            return getFolderSize(folderPath)
          })())

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

      writer?.dispose()

      if (config.incremental) {
        /*
         * Incremental reuse is a folder-level idea: it is the manifest that
         * lets unchanged files keep their existing ids. A single file has no
         * manifest, so say so rather than appearing to honour the flag.
         */
        spinner.warn('--incremental applies to folder uploads; ignoring it for --deploy-file')
        spinner.start(`Uploading file ${chalk.yellow(config['deploy-file'])}`)
      }

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

      startPhase(`Uploading folder ${chalk.yellow(config['deploy-folder'])}`)

      let cache = incrementalFolder
        ? folderCache
        : config['dedupe-cache-max-entries'] > 0
          ? loadCache()
          : {}

      let uploadResult: FolderUploadResult
      try {
        uploadResult = await uploadFolder(uploadClient, folderPath, {
          cache,
          fallbackFile: config['fallback-file'],
          fundingMode,
          incremental,
          plan: folderPlan,
          throwOnFailure: true,
        })
      } finally {
        /*
         * Whatever landed before a failure is still paid for, and still ours.
         * Every upload has settled by now, so nothing can record after this.
         */
        writer?.flush()
        writer?.dispose()
      }

      phase = ''

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
