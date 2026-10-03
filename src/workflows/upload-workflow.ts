import fs from 'node:fs'

import {
  type TokenTools,
  type TurboAuthenticatedConfiguration,
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
import { parseCompressionConfig } from '../utils/compression.js'
import {
  type ChainIndex,
  createChainIndex,
  ownerAddressFromPublicKey,
} from '../utils/incremental.js'
import { expandPath } from '../utils/path.js'
import { createSigner } from '../utils/signer.js'
import {
  devTokenRpc,
  fetchFreeUploadLimit,
  fromBaseUnits,
  fundShortfall,
  type OnDemandToken,
  type PayerOptions,
  quoteUploadWinc,
  resolvePaidBy,
  resolveTurboServices,
  spendableWinc,
  toBaseUnits,
  validateOnDemandToken,
} from '../utils/turbo.js'
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
  /** Content-Encoding to compress uploads with: gzip, br, or none. */
  compress?: string
  /** Comma-separated globs of files to upload uncompressed. */
  'compress-exclude'?: string
  'dedupe-cache-max-entries': number
  'deploy-file'?: string
  'deploy-folder': string
  /** Use Turbo's development sandbox for both upload and payment. */
  dev?: boolean
  /** Relative path served for routes the manifest does not list. */
  'fallback-file'?: string
  /** Pay only from the upload key's own balance. */
  'ignore-approvals'?: boolean
  /** Opt in to content-hash incremental uploads. */
  incremental?: boolean
  /** Gateway whose GraphQL endpoint answers "have I uploaded these bytes?". */
  'incremental-gateway'?: string
  'max-token-amount'?: string
  'on-demand'?: string
  /** Comma-separated addresses whose shared credits pay. */
  'paid-by'?: string
  /** Turbo payment service URL; paired with the uploader when omitted. */
  'payment-url'?: string
  'sig-type': string
  uploader?: string
  /** Spend the upload key's balance before shared credits. */
  'use-signer-balance-first'?: boolean
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export interface UploadWorkflowIo {
  error: (msg: string) => never
  /**
   * The chain an on-demand top-up is paid on. Omitted, Turbo uses the token's
   * own tooling; tests pass a stand-in so a top-up never leaves the machine.
   */
  tokenTools?: TokenTools
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
    try {
      write()
    } catch {
      /*
       * A cache write can fail — a full disk, a read-only mount. Letting that
       * escape a signal handler turns it into an uncaughtException: the
       * re-raise never runs and the process exits 1 instead of by signal, so
       * anything reading the exit status is told the wrong thing. Losing the
       * flush is bad; lying about how the process died is worse.
       */
    }

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

  /*
   * Everything that can be refused without a network call is refused here,
   * before hashing a folder: a top-up token the key cannot pay with, or a
   * cap that is not a number.
   */
  const onDemandToken = config['on-demand'] as OnDemandToken | undefined
  let maxTokenAmount: bigint | undefined
  if (onDemandToken) {
    const tokenCheck = validateOnDemandToken(config['sig-type'], onDemandToken)
    if (tokenCheck !== true) {
      io.error(tokenCheck)
    }

    if (!config['max-token-amount']) {
      io.error('--on-demand needs --max-token-amount, the most the top-up may spend.')
    }

    try {
      maxTokenAmount = toBaseUnits(config['max-token-amount'], onDemandToken)
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error))
    }
  }

  const payerOptions: PayerOptions = {
    ignoreApprovals: config['ignore-approvals'],
    paidBy: config['paid-by']
      ?.split(',')
      .map((address) => address.trim())
      .filter(Boolean),
    useSignerBalanceFirst: config['use-signer-balance-first'],
  }

  spinner.start('Creating signer')
  const { signer, token: signerToken } = createSigner(config['sig-type'] as SignerType, deployKey)
  spinner.succeed(`Signer created (${chalk.cyan(config['sig-type'])})`)

  const services = resolveTurboServices({
    dev: config.dev,
    paymentUrl: config['payment-url'],
    uploadUrl: config.uploader,
  })
  for (const warning of services.warnings) {
    spinner.warn(warning)
  }

  spinner.start('Initializing Turbo')

  /*
   * Turbo pays a top-up in the client's own token, so with --on-demand the
   * client is configured with the funding token rather than the signer's.
   * Within a signer family that leaves the billing address unchanged.
   */
  const turboFactoryArgs: TurboAuthenticatedConfiguration = {
    paymentServiceConfig: { url: services.paymentUrl },
    signer,
    token: onDemandToken ?? signerToken,
    uploadServiceConfig: { url: services.uploadUrl },
    ...(onDemandToken && services.development && { gatewayUrl: devTokenRpc(onDemandToken) }),
    ...(io.tokenTools && { tokenTools: io.tokenTools }),
  }

  const turbo = TurboFactory.authenticated(turboFactoryArgs)
  const uploadClient: UploadClient = turbo as UploadClient

  spinner.succeed(
    `Turbo initialized${services.development ? ` (${chalk.yellow('development sandbox')})` : ''}`,
  )

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

  const compression = parseCompressionConfig(config.compress, config['compress-exclude'])
  const useCache = config['dedupe-cache-max-entries'] > 0

  /*
   * Plan a folder upload up front: hash every file, skip what the dedupe
   * cache (and, with --incremental, this wallet's past uploads on chain)
   * already holds, share uploads between identical files and compress. The
   * credit check then prices what will actually be sent, not the whole
   * folder -- pricing the folder demanded a full-site balance for a one-page
   * change -- and the upload reuses the plan instead of redoing the work.
   */
  const incrementalFolder = Boolean(config.incremental) && !config['deploy-file']
  const writer = incrementalFolder
    ? createCacheWriter(config['dedupe-cache-max-entries'])
    : undefined

  let incremental: IncrementalOptions | undefined
  let folderPlan: FolderUploadPlan | undefined

  if (!config['deploy-file']) {
    try {
      if (writer) {
        incremental = {
          index: await createIncrementalIndex(uploadClient, config, warn),
          onCacheUpdate: writer.record,
          onWarning: warn,
        }
      }

      startPhase(
        incremental
          ? `Checking ${chalk.yellow(config['deploy-folder'])} against previous uploads`
          : 'Planning upload',
      )
      folderPlan = await planFolderUpload(expandPath(config['deploy-folder']), {
        cache: useCache ? loadCache() : {},
        compression,
        fallbackFile: config['fallback-file'],
        incremental,
      })
      phase = ''
    } catch (planError) {
      writer?.dispose()
      spinner.fail('Failed to plan upload')
      const errorMessage = planError instanceof Error ? planError.message : String(planError)
      io.error(`Failed to plan upload: ${errorMessage}`)
    }

    const { cacheHits, duplicates, files, recovered, uploadBytes } = folderPlan
    const toUpload = files.length - cacheHits - duplicates
    const recoveredMsg = incremental ? ` (${recovered} found on chain)` : ''
    spinner.succeed(
      `Upload planned: ${toUpload} of ${files.length} files to upload (${formatBytes(uploadBytes)}` +
        `${compression ? ` after ${compression.encoding}` : ''}), ${cacheHits} cached${recoveredMsg}, ` +
        `${duplicates} duplicates`,
    )
  }

  /*
   * Price exactly what will be sent, decide who pays, and make sure they can.
   * Turbo bills per data item, so the plan's items are priced one by one
   * against the upload service's own free limit. A shortfall is either
   * refused or, with --on-demand, bought in a single top-up for the whole
   * plan before the first upload.
   */
  let { paidBy } = payerOptions
  startPhase('Checking Turbo credits')

  /** Why the upload cannot go ahead, or undefined when it can. */
  const ensureCredits = async (): Promise<string | undefined> => {
    let requiredWinc: bigint
    let availableWinc: bigint
    try {
      const itemBytes = folderPlan
        ? [
            ...folderPlan.files
              .filter((file) => file.uploadBytes > 0)
              .map((file) => file.uploadBytes),
            folderPlan.manifestBytes,
          ]
        : [fs.statSync(expandPath(config['deploy-file']!)).size]

      const freeLimit = await fetchFreeUploadLimit(services.uploadUrl)
      if (freeLimit === undefined) {
        warn(`${services.uploadUrl} did not report its free upload limit; pricing every item`)
      }

      requiredWinc = await quoteUploadWinc(turbo, itemBytes, freeLimit ?? 0)
      if (requiredWinc === 0n) {
        spinner.succeed('Turbo credits check passed (within the free upload limit)')
        return undefined
      }

      const balance = await turbo.getBalance()
      paidBy = resolvePaidBy(
        payerOptions,
        balance.receivedApprovals ?? [],
        await turbo.signer.getNativeAddress(),
      )
      availableWinc = spendableWinc(balance, payerOptions)
    } catch (error) {
      spinner.fail('Failed to check Turbo credits')
      return `Failed to check Turbo credits: ${error instanceof Error ? error.message : String(error)}`
    }

    const payerNote = paidBy ? ` (shared credits from ${paidBy.join(', ')})` : ''
    if (requiredWinc <= availableWinc) {
      spinner.succeed(`Turbo credits check passed${payerNote}`)
      return undefined
    }

    if (!onDemandToken || maxTokenAmount === undefined) {
      spinner.fail('Insufficient Turbo credits')
      return [
        'Insufficient Turbo credits for this upload.',
        `Required: ${requiredWinc} winc, available: ${availableWinc} winc${payerNote}.`,
        '',
        'Top up your Turbo balance (or re-run with --on-demand and --max-token-amount).',
      ].join(' ')
    }

    startPhase(`Topping up Turbo credits with ${chalk.cyan(onDemandToken)}`)
    try {
      const funding = await fundShortfall(turbo, {
        maxTokenAmount,
        shortfallWinc: requiredWinc - availableWinc,
        token: onDemandToken,
      })
      const spent = `${fromBaseUnits(funding.tokenAmount, onDemandToken)} ${onDemandToken}`
      if (funding.confirmed) {
        spinner.succeed(`Topped up with ${spent} (${chalk.gray(funding.txId)})`)
      } else {
        spinner.warn(
          `Top-up of ${spent} (${funding.txId}) is not confirmed yet; uploading anyway, which fails if the credits have not landed`,
        )
      }
    } catch (error) {
      spinner.fail('On-demand top-up failed')
      return `On-demand top-up failed: ${error instanceof Error ? error.message : String(error)}`
    }

    return undefined
  }

  const creditProblem = await ensureCredits()
  phase = ''
  if (creditProblem) {
    // io.error throws, so nothing after it runs.
    writer?.dispose()
    io.error(creditProblem)
  }

  let txOrManifestId: string
  let cost: UploadCost | undefined
  let size: UploadSize | undefined
  try {
    if (config['deploy-file']) {
      const filePath = expandPath(config['deploy-file'])
      spinner.start(`Uploading file ${chalk.yellow(config['deploy-file'])}`)

      if (config.incremental) {
        /*
         * Incremental reuse is a folder-level idea: it is the manifest that
         * lets unchanged files keep their existing ids. A single file has no
         * manifest, so say so rather than appearing to honour the flag.
         */
        spinner.warn('--incremental applies to folder uploads; ignoring it for --deploy-file')
        spinner.start(`Uploading file ${chalk.yellow(config['deploy-file'])}`)
      }

      let cache = useCache ? loadCache() : {}
      const uploadResult = await uploadFile(uploadClient, filePath, {
        cache,
        compression,
        paidBy,
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

      startPhase(`Uploading folder ${chalk.yellow(config['deploy-folder'])}`)

      let uploadResult: FolderUploadResult
      try {
        uploadResult = await uploadFolder(uploadClient, folderPath, {
          compression,
          fallbackFile: config['fallback-file'],
          incremental,
          paidBy,
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
