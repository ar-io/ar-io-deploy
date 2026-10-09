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
import { explainPaymentRequired, formatBytes } from '../utils/display.js'
import {
  type ChainIndex,
  createChainIndex,
  ownerAddressFromPublicKey,
} from '../utils/incremental.js'
import type { KeyScanner } from '../utils/key-scan.js'
import { expandPath } from '../utils/path.js'
import { createSigner } from '../utils/signer.js'
import {
  devTokenRpc,
  FALLBACK_FREE_ITEM_BYTES,
  fetchFreeBytesRemaining,
  fetchUploadServiceInfo,
  fromBaseUnits,
  fundShortfall,
  loadPendingTopUp,
  type OnDemandToken,
  type PayerOptions,
  type PollOptions,
  quoteUploadWinc,
  resolvePaidBy,
  resolveTurboServices,
  savePendingTopUp,
  spendableWinc,
  toBaseUnits,
  type TurboServices,
  validateOnDemandToken,
  waitForFundTransaction,
} from '../utils/turbo.js'
import type { UploadClient } from '../utils/upload-types.js'
import {
  type FileUploadPlan,
  type FolderUploadPlan,
  type IncrementalOptions,
  type ListedFolder,
  planFileUpload,
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

export interface UploadWorkflowIo {
  error: (msg: string) => never
  /**
   * The chain an on-demand top-up is paid on. Omitted, Turbo uses the token's
   * own tooling; tests pass a stand-in so a top-up never leaves the machine.
   */
  tokenTools?: TokenTools
  /** How long to wait for a top-up to be credited; tests shorten it. */
  fundingPoll?: PollOptions
  /** Every key the command holds, searched for in each file before planning. */
  keyScanner?: KeyScanner
  /**
   * Set when the command has already searched the upload for keys: the
   * folder's file list, or `'deploy-file'`. The plan then uploads exactly
   * what was searched and does not read every file a second time.
   */
  scanned?: 'deploy-file' | ListedFolder
}

/**
 * Build the chain-backed index, or explain why there is none.
 *
 * The index is scoped to the uploading wallet: a `File-SHA256` tag is a claim
 * anyone can stamp on any bytes, so only the wallet's own past transactions
 * are trusted to answer "have I already paid for this file?".
 *
 * The address is derived from the signer's public key rather than taken from
 * `getNativeAddress()`, which returns a chain-native form for three of the four
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
  {
    onWarning,
    raise = reRaise,
    scope,
  }: {
    /** Told once if the cache cannot be written; the deploy itself carries on. */
    onWarning?: (message: string) => void
    raise?: (signal: NodeJS.Signals) => void
    /** Which network's cache file to write; see `getCachePath`. */
    scope?: string
  } = {},
): CacheWriter {
  let pending: TransactionCache | undefined
  let lastWrite = 0
  let timer: NodeJS.Timeout | undefined
  let warned = false

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

    try {
      saveCache(cleanupCache(pending, maxEntries), scope)
    } catch (error) {
      /*
       * The uploads are paid for whether or not their ids reach the disk, so
       * a read-only or full disk must not fail the deploy that bought them.
       */
      if (!warned) {
        warned = true
        const message = error instanceof Error ? error.message : String(error)
        onWarning?.(
          `Could not save the transaction cache (${message}); this run's uploads will not be reused`,
        )
      }
    }

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
  /** True when the upload went to Turbo's development sandbox. */
  development: boolean
  /** Gateway to view the upload on, when the network's is known. */
  gatewayUrl?: string
  transactionId: string
}

/** On-demand funding settings, validated. */
interface Funding {
  maxTokenAmount: bigint
  token: OnDemandToken
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Everything that can be refused without a network call: a funding token the
 * upload key cannot pay with, a cap that is not an amount, a service URL that
 * is not a URL. Refused here, before a folder is hashed or a token spent.
 */
function validateWorkflowConfig(
  config: UploadWorkflowConfig,
): { funding?: Funding; payers: PayerOptions; services: TurboServices } | string {
  let funding: Funding | undefined
  const onDemand = config['on-demand']
  if (onDemand) {
    const tokenCheck = validateOnDemandToken(config['sig-type'], onDemand)
    if (tokenCheck !== true) return tokenCheck

    const cap = config['max-token-amount']
    if (!cap) return '--on-demand needs --max-token-amount, the most the top-up may spend.'

    try {
      funding = {
        maxTokenAmount: toBaseUnits(cap, onDemand as OnDemandToken),
        token: onDemand as OnDemandToken,
      }
    } catch (error) {
      return errorMessage(error)
    }
  }

  let services: TurboServices
  try {
    services = resolveTurboServices({
      dev: config.dev,
      paymentUrl: config['payment-url'],
      uploadUrl: config.uploader,
    })
  } catch (error) {
    return errorMessage(error)
  }

  const payers: PayerOptions = {
    ignoreApprovals: config['ignore-approvals'],
    paidBy: config['paid-by']
      ?.split(',')
      .map((address) => address.trim())
      .filter(Boolean),
    useSignerBalanceFirst: config['use-signer-balance-first'],
  }

  return { funding, payers, services }
}

/**
 * Sign in to Turbo and upload a file or folder.
 *
 * @param deployKey - Wallet material (base64 JWK, hex key, or base58 Solana key per sig-type)
 * @param config - Upload paths, dedupe, Turbo services, payment options
 * @param io - Error handler (must throw) and, for tests, the chain a top-up is paid on
 * @returns Transaction ID or folder manifest ID
 */
export async function runUploadWorkflow(
  deployKey: string,
  config: UploadWorkflowConfig,
  io: UploadWorkflowIo,
): Promise<UploadWorkflowResult> {
  const spinner = ora()

  const validated = validateWorkflowConfig(config)
  if (typeof validated === 'string') {
    io.error(validated)
  }

  const { funding, payers, services } = validated

  spinner.start('Creating signer')
  const { signer, token: signerToken } = createSigner(config['sig-type'] as SignerType, deployKey)
  spinner.succeed(`Signer created (${chalk.cyan(config['sig-type'])})`)

  for (const warning of services.warnings) {
    spinner.warn(warning)
  }

  /*
   * Turbo pays a top-up in the client's own token, so with --on-demand the
   * client is configured with the funding token rather than the signer's.
   * Within a signer family that leaves the billing address unchanged.
   */
  const turboFactoryArgs: TurboAuthenticatedConfiguration = {
    paymentServiceConfig: { url: services.paymentUrl },
    signer,
    token: funding?.token ?? signerToken,
    uploadServiceConfig: { url: services.uploadUrl },
    ...(funding && services.development && { gatewayUrl: devTokenRpc(funding.token) }),
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
  const maxEntries = config['dedupe-cache-max-entries']
  const useCache = maxEntries > 0
  const scope = services.cacheScope

  /** Persist the cache without letting a disk problem fail a paid-for deploy. */
  const persistCache = (cache: TransactionCache | undefined): void => {
    if (!cache || !useCache) return
    try {
      saveCache(cleanupCache(cache, maxEntries), scope)
    } catch (error) {
      warn(
        `Could not save the transaction cache (${errorMessage(error)}); this run's uploads will not be reused`,
      )
    }
  }

  /*
   * Plan before paying: hash every file, skip what the dedupe cache (and, with
   * --incremental, this wallet's past uploads on chain) already holds, share
   * uploads between identical files, compress. The credit check then prices
   * what will actually be sent, and the upload reuses the plan.
   */
  const deployFile = config['deploy-file']
  const writer =
    useCache && !deployFile ? createCacheWriter(maxEntries, { onWarning: warn, scope }) : undefined

  let filePlan: FileUploadPlan | undefined
  let folderPlan: FolderUploadPlan | undefined
  let incremental: IncrementalOptions | undefined
  let planError: string | undefined

  try {
    if (deployFile) {
      startPhase(`Planning upload of ${chalk.yellow(deployFile)}`)
      if (config.incremental) {
        /*
         * Incremental reuse is a folder-level idea: it is the manifest that
         * lets unchanged files keep their existing ids. A single file has no
         * manifest, so say so rather than appearing to honour the flag.
         */
        warn('--incremental applies to folder uploads; ignoring it for --deploy-file')
      }

      filePlan = await planFileUpload(expandPath(deployFile), {
        cache: useCache ? loadCache(scope) : undefined,
        compression,
        keyScanner: io.scanned ? false : io.keyScanner,
      })
      spinner.succeed(
        filePlan.cached
          ? `Upload planned: file already uploaded (${chalk.green(filePlan.cached.transactionId)})`
          : `Upload planned: ${formatBytes(filePlan.uploadBytes)}${compression && filePlan.encoding ? ` after ${filePlan.encoding}` : ''}`,
      )
    } else {
      if (config.incremental && writer) {
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
        cache: useCache ? loadCache(scope) : undefined,
        compression,
        fallbackFile: config['fallback-file'],
        incremental,
        keyScanner: io.keyScanner,
        listed: typeof io.scanned === 'object' ? io.scanned : undefined,
      })

      const { cacheHits, duplicates, files, recovered, uploadBytes } = folderPlan
      const toUpload = files.length - cacheHits - duplicates
      const recoveredMsg = incremental ? ` (${recovered} found on chain)` : ''
      spinner.succeed(
        `Upload planned: ${toUpload} of ${files.length} files to upload (${formatBytes(uploadBytes)}` +
          `${compression ? ` after ${compression.encoding}` : ''}), ${cacheHits} cached${recoveredMsg}, ` +
          `${duplicates} duplicates`,
      )
      if (folderPlan.skipped.length > 0) {
        spinner.info(`Not uploaded: ${folderPlan.skipped.join(', ')} (git repository data)`)
      }
    }
  } catch (error) {
    spinner.fail('Failed to plan upload')
    planError = `Failed to plan upload: ${errorMessage(error)}`
  }

  phase = ''
  if (planError || (!filePlan && !folderPlan)) {
    writer?.dispose()
    io.error(planError ?? 'Failed to plan upload')
  }

  /*
   * Price exactly what will be sent, decide who pays, and make sure they can.
   * Turbo bills per data item against the upload service's free limit and the
   * wallet's metered free tier. A shortfall is refused or, with --on-demand,
   * bought in a single top-up before the first upload.
   */
  let { paidBy } = payers
  const itemBytes = folderPlan
    ? [
        ...folderPlan.files.filter((file) => file.uploadBytes > 0).map((file) => file.uploadBytes),
        folderPlan.manifestBytes,
      ]
    : filePlan && !filePlan.cached
      ? [filePlan.uploadBytes]
      : []

  const serviceInfo = await fetchUploadServiceInfo(services.uploadUrl)

  const describeUploadError = (error: unknown): string =>
    explainPaymentRequired(errorMessage(error), {
      freeLimitBytes: serviceInfo.freeUploadLimitBytes ?? FALLBACK_FREE_ITEM_BYTES,
      uploadUrl: services.uploadUrl,
    }) ?? errorMessage(error)

  const ensureCredits = async (): Promise<string | undefined> => {
    /*
     * A top-up an earlier run sent but never saw credited. Buying again before
     * it lands would pay twice for the same shortfall.
     */
    const pending = loadPendingTopUp(scope)
    if (pending) {
      startPhase(`Checking the earlier top-up ${chalk.gray(pending.txId)}`)
      const pendingClient = TurboFactory.unauthenticated({
        paymentServiceConfig: { url: services.paymentUrl },
        token: pending.token,
      })
      try {
        const status = await waitForFundTransaction(pendingClient, pending.txId, {
          timeoutMs: 30_000,
          ...io.fundingPoll,
        })
        if (status === 'pending') {
          spinner.fail('Earlier top-up not credited yet')
          return (
            `A top-up sent by an earlier run (${pending.txId}, ${pending.token}) has not been credited yet. ` +
            'Re-run once it confirms; delete .ario-deploy/pending-topup*.json only if you are sure it never will.'
          )
        }

        spinner.succeed(`Earlier top-up ${chalk.gray(pending.txId)} credited`)
      } catch (error) {
        warn(`Earlier top-up ${pending.txId} will not be credited: ${errorMessage(error)}`)
      }

      savePendingTopUp(undefined, scope)
    }

    if (itemBytes.length === 0) {
      spinner.succeed('Turbo credits check passed (nothing to upload)')
      return undefined
    }

    startPhase('Checking Turbo credits')
    let requiredWinc: bigint
    let availableWinc: bigint | undefined
    try {
      const maxItemBytes = serviceInfo.freeUploadLimitBytes
      if (maxItemBytes === undefined) {
        warn(
          `${services.uploadUrl} did not report its free upload limit; assuming ${formatBytes(FALLBACK_FREE_ITEM_BYTES)}`,
        )
      }

      /*
       * Read directly rather than through Turbo SDK's getFreeStatus, which
       * reports a 404 as unlimited. An allowance that cannot be read is
       * priced as none: the check then asks for credits it might not need,
       * rather than promising free uploads the service might refuse.
       */
      let bytesRemaining: bigint | null
      try {
        bytesRemaining = await fetchFreeBytesRemaining(
          services.paymentUrl,
          await turbo.signer.getNativeAddress(),
        )
      } catch (error) {
        bytesRemaining = 0n
        warn(
          `Could not confirm this wallet's free-tier allowance (${errorMessage(error)}); pricing every item as paid`,
        )
      }

      requiredWinc = await quoteUploadWinc(turbo, itemBytes, {
        bytesRemaining,
        maxItemBytes: maxItemBytes ?? FALLBACK_FREE_ITEM_BYTES,
      })
    } catch (error) {
      spinner.fail('Failed to check Turbo credits')
      return `Failed to check Turbo credits: ${errorMessage(error)}`
    }

    /*
     * Who pays is resolved even for a free upload: the free tier is decided
     * per item at upload time, and an item it does not cover is charged to
     * the payers named on it, or to nobody but the signer.
     */
    try {
      const balance = await turbo.getBalance()
      paidBy = resolvePaidBy(
        payers,
        balance.receivedApprovals ?? [],
        await turbo.signer.getNativeAddress(),
      )
      availableWinc = spendableWinc(balance, payers)
    } catch (error) {
      if (requiredWinc > 0n) {
        spinner.fail('Failed to check Turbo credits')
        return `Failed to check Turbo credits: ${errorMessage(error)}`
      }

      warn(
        `Could not read the Turbo balance (${errorMessage(error)}); uploading within the free tier`,
      )
    }

    const payerNote = paidBy ? ` (shared credits from ${paidBy.join(', ')})` : ''
    if (requiredWinc === 0n) {
      spinner.succeed(
        `Turbo credits check passed (within this wallet's free tier; Turbo also meters free uploads per IP range, checked at upload time)${payerNote}`,
      )
      return undefined
    }

    if (availableWinc !== undefined && requiredWinc <= availableWinc) {
      spinner.succeed(`Turbo credits check passed${payerNote}`)
      return undefined
    }

    const available = availableWinc ?? 0n
    if (!funding) {
      spinner.fail('Insufficient Turbo credits')
      return [
        'Insufficient Turbo credits for this upload.',
        `Required: ${requiredWinc} winc, available: ${available} winc${payerNote}.`,
        '',
        'Top up your Turbo balance (or re-run with --on-demand and --max-token-amount).',
      ].join(' ')
    }

    startPhase(`Topping up Turbo credits with ${chalk.cyan(funding.token)}`)
    try {
      const result = await fundShortfall(turbo, {
        ...io.fundingPoll,
        maxTokenAmount: funding.maxTokenAmount,
        onSent: (txId) =>
          savePendingTopUp(
            { createdAt: new Date().toISOString(), token: funding.token, txId },
            scope,
          ),
        shortfallWinc: requiredWinc - available,
        token: funding.token,
      })
      const spent = `${fromBaseUnits(result.tokenAmount, funding.token)} ${funding.token}`
      if (result.confirmed) {
        savePendingTopUp(undefined, scope)
        spinner.succeed(`Topped up with ${spent} (${chalk.gray(result.txId)})`)
        return undefined
      }

      spinner.fail('Top-up not credited yet')
      return (
        `Sent ${spent} (${result.txId}), but Turbo has not credited it yet. ` +
        'Re-run in a few minutes: the next run waits for this top-up instead of buying another.'
      )
    } catch (error) {
      savePendingTopUp(undefined, scope)
      spinner.fail('On-demand top-up failed')
      return `On-demand top-up failed: ${errorMessage(error)}`
    }
  }

  const creditProblem = await ensureCredits()
  phase = ''
  if (creditProblem) {
    writer?.dispose()
    io.error(creditProblem)
  }

  let transactionId: string | undefined
  let uploadError: string | undefined

  if (filePlan) {
    startPhase(`Uploading file ${chalk.yellow(deployFile)}`)
    try {
      const result = await uploadFile(uploadClient, filePlan, { paidBy })
      transactionId = result.transactionId
      persistCache(result.updatedCache)
      spinner.succeed(
        result.cacheHit
          ? `File cache hit - reusing transaction ${chalk.green(transactionId)}`
          : `File uploaded: ${chalk.green(transactionId)}${useCache ? chalk.gray(' (cached for future uploads)') : ''}`,
      )
    } catch (error) {
      spinner.fail('Upload failed')
      uploadError = `Upload failed: ${describeUploadError(error)}`
    }
  } else if (folderPlan) {
    startPhase(`Uploading folder ${chalk.yellow(config['deploy-folder'])}`)
    try {
      const result = await uploadFolder(uploadClient, expandPath(config['deploy-folder']), {
        compression,
        fallbackFile: config['fallback-file'],
        incremental,
        onCacheUpdate: writer?.record,
        paidBy,
        plan: folderPlan,
      })
      transactionId = result.transactionId
      if (result.updatedCache) writer?.record(result.updatedCache)

      const { cacheHits, duplicates, totalFiles, uploaded } = result
      const sharedMsg = duplicates > 0 ? `, ${duplicates} duplicates shared` : ''
      const statsMsg =
        cacheHits > 0 || duplicates > 0
          ? chalk.gray(
              ` (${cacheHits}/${totalFiles} files cached${sharedMsg}, ${uploaded} uploaded)`,
            )
          : ''
      spinner.succeed(
        result.cacheHit
          ? `All ${totalFiles} files cached - manifest: ${chalk.green(transactionId)}`
          : `Folder uploaded: ${chalk.green(transactionId)}${statsMsg}${useCache ? chalk.gray(' (files cached for future uploads)') : ''}`,
      )
    } catch (error) {
      spinner.fail('Upload failed')
      uploadError =
        `Upload failed: ${describeUploadError(error)}` +
        (useCache
          ? '. Files that did upload are cached, so a re-run does not pay for them again.'
          : '')
    } finally {
      // Whatever landed before a failure is paid for; every upload has settled.
      writer?.flush()
      writer?.dispose()
    }
  }

  phase = ''
  if (uploadError || !transactionId) {
    io.error(uploadError ?? 'Upload failed: no transaction ID returned')
  }

  return {
    development: services.development,
    gatewayUrl:
      serviceInfo.gateway ?? (services.development ? undefined : 'https://turbo-gateway.com'),
    transactionId,
  }
}
