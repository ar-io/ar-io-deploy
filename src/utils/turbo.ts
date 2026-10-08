/**
 * Turbo payment and service configuration for a deploy.
 *
 * Turbo already models networks, funding tokens, credit sharing and pricing;
 * this module wires those primitives together for a deploy rather than
 * recreating them. Where a deploy has to own a decision -- which tokens a given
 * upload key can pay with, and funding a whole upload plan at once -- the
 * reason is written next to it.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  type CreditShareApproval,
  defaultTurboConfiguration,
  developmentTurboConfiguration,
  exponentMap,
  type TokenType,
  type TurboBalanceResponse,
  type TurboCryptoFundResponse,
  TurboFactory,
  type TurboInfoResponse,
  type TurboSubmitFundTxResponse,
  type TurboWincForTokenResponse,
} from '@ardrive/turbo-sdk'

import { CACHE_DIR } from '../constants/cache.js'
import type { SignerType } from '../types/index.js'

/** Upload and payment service URLs, chosen together. */
export interface TurboServices {
  /**
   * Names the network for local state (the dedupe cache, a pending top-up):
   * undefined for production, the upload service's host otherwise. Ids from
   * one network must never be reused on another.
   */
  cacheScope?: string
  /** True when both services are Turbo's development sandbox. */
  development: boolean
  paymentUrl: string
  uploadUrl: string
  /** Mismatches worth telling the user about before any money moves. */
  warnings: string[]
}

/**
 * A service base URL without trailing slashes. Turbo appends `/v1/...`, so a
 * trailing slash would request `//v1/...`, which the services answer with 404
 * (and a 404 balance reads as an empty one).
 */
function normalizeServiceUrl(url: string, flag: string): string {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new Error(`${flag} must be an http(s) URL, e.g. https://upload.ardrive.io (got "${url}")`)
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${flag} must be an http(s) URL, e.g. https://upload.ardrive.io (got "${url}")`)
  }

  return parsed.href.replace(/\/+$/, '')
}

function sameUrl(a: string | undefined, b: string): boolean {
  return (
    a !== undefined && a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase()
  )
}

/**
 * Resolve the upload and payment services as a pair.
 *
 * The upload service takes the data; the payment service answers every
 * balance, price and top-up question. Configuring only one of them sends
 * those questions to the wrong network: a sandbox upload checked against a
 * production balance is refused for credits it has, and an on-demand top-up
 * spends real tokens on production credits for a sandbox upload. So naming
 * either sandbox service selects the other, and `--dev` selects both, as
 * Turbo's own CLI does.
 */
export function resolveTurboServices(options: {
  dev?: boolean
  paymentUrl?: string
  uploadUrl?: string
}): TurboServices {
  const prod = defaultTurboConfiguration
  const dev = developmentTurboConfiguration
  const warnings: string[] = []
  options = {
    ...options,
    paymentUrl: options.paymentUrl && normalizeServiceUrl(options.paymentUrl, '--payment-url'),
    uploadUrl: options.uploadUrl && normalizeServiceUrl(options.uploadUrl, '--uploader'),
  }

  const development =
    Boolean(options.dev) ||
    sameUrl(options.uploadUrl, dev.uploadServiceConfig.url) ||
    sameUrl(options.paymentUrl, dev.paymentServiceConfig.url)
  const defaults = development ? dev : prod

  const uploadUrl = options.uploadUrl ?? defaults.uploadServiceConfig.url
  const paymentUrl = options.paymentUrl ?? defaults.paymentServiceConfig.url

  const knownUpload =
    sameUrl(uploadUrl, prod.uploadServiceConfig.url) ||
    sameUrl(uploadUrl, dev.uploadServiceConfig.url)
  if (!knownUpload && options.paymentUrl === undefined) {
    warnings.push(
      `Custom upload service ${uploadUrl} is paired with the payment service ${paymentUrl}: ` +
        'balance checks and on-demand top-ups go there. Pass --payment-url if that is wrong.',
    )
  }

  if (
    (sameUrl(uploadUrl, dev.uploadServiceConfig.url) &&
      sameUrl(paymentUrl, prod.paymentServiceConfig.url)) ||
    (sameUrl(uploadUrl, prod.uploadServiceConfig.url) &&
      sameUrl(paymentUrl, dev.paymentServiceConfig.url))
  ) {
    warnings.push(
      `Upload service ${uploadUrl} and payment service ${paymentUrl} are on different ` +
        'networks: the credit check and any top-up will not match where the data goes.',
    )
  }

  const cacheScope = sameUrl(uploadUrl, prod.uploadServiceConfig.url)
    ? undefined
    : new URL(uploadUrl).host.replaceAll(/[^\w.-]/g, '_')

  return { cacheScope, development, paymentUrl, uploadUrl, warnings }
}

/**
 * Tokens each upload key can fund an on-demand top-up with.
 *
 * Turbo pays a top-up from the client's own wallet in the client's configured
 * token, so the token has to be one the upload key can sign for: ARIO and
 * USDC on Solana need a Solana key, Base ETH and Base USDC an EVM key. The
 * subset is the tokens Turbo enables for on-demand uploads. Typed against
 * Turbo's `TokenType`, so a token Turbo renames or drops fails the build
 * rather than the deploy.
 */
export const ON_DEMAND_TOKENS = {
  arweave: [],
  ethereum: ['base-eth', 'base-usdc'],
  polygon: ['base-eth', 'base-usdc'],
  solana: ['ario', 'solana', 'solana-usdc'],
} as const satisfies Record<SignerType, readonly TokenType[]>

export type OnDemandToken = (typeof ON_DEMAND_TOKENS)[SignerType][number]

export const ALL_ON_DEMAND_TOKENS: readonly OnDemandToken[] = [
  ...new Set(Object.values(ON_DEMAND_TOKENS).flat()),
]

/** `true`, or why this upload key cannot pay with that token. */
export function validateOnDemandToken(sigType: string, token: string): string | true {
  const allowed: readonly string[] = ON_DEMAND_TOKENS[sigType as SignerType] ?? []
  if (allowed.includes(token)) {
    return true
  }

  if (allowed.length === 0) {
    return `On-demand funding is not available for ${sigType} upload keys. Top up Turbo credits in advance, or upload with a Solana or EVM key.`
  }

  return `--on-demand ${token} needs a key that can pay in ${token}. With --sig-type ${sigType}, use one of: ${allowed.join(', ')}.`
}

/**
 * Chain RPC each funding token pays through on the development sandbox.
 *
 * Turbo's CLI keeps this table (`tokenToDevGatewayMap`) but the SDK does not
 * export it, so the on-demand subset is mirrored here. Production needs no
 * entry: Turbo's token defaults already point at mainnet.
 */
const DEV_TOKEN_RPC: Record<OnDemandToken, string> = {
  ario: 'https://api.devnet.solana.com',
  'base-eth': 'https://sepolia.base.org',
  'base-usdc': 'https://sepolia.base.org',
  solana: 'https://api.devnet.solana.com',
  'solana-usdc': 'https://api.devnet.solana.com',
}

export function devTokenRpc(token: OnDemandToken): string {
  return DEV_TOKEN_RPC[token]
}

/**
 * Convert a decimal token amount ("1.5") to the token's base units, exactly.
 * The number of decimals comes from Turbo's `exponentMap`.
 */
export function toBaseUnits(amount: string, token: TokenType): bigint {
  const trimmed = amount.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed) && !/^\.\d+$/.test(trimmed)) {
    throw new Error(`Invalid token amount: ${amount}`)
  }

  const decimals = exponentMap[token]
  const [whole = '0', fraction = ''] = trimmed.split('.')
  if (fraction.length > decimals) {
    throw new Error(`${amount} has more than the ${decimals} decimals ${token} supports`)
  }

  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'))
}

/** Base units back to a readable decimal amount. */
export function fromBaseUnits(amount: bigint, token: TokenType): string {
  const decimals = BigInt(exponentMap[token])
  const scale = 10n ** decimals
  const whole = amount / scale
  const fraction = (amount % scale).toString().padStart(Number(decimals), '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

/** How an upload chooses who pays, mirroring Turbo's CLI options. */
export interface PayerOptions {
  /** Pay only from these addresses' credit-share approvals. */
  paidBy?: string[]
  /** Never use received approvals: the upload key's own balance pays. */
  ignoreApprovals?: boolean
  /** Spend the upload key's own balance before any shared credits. */
  useSignerBalanceFirst?: boolean
}

/**
 * The `paidBy` list to send with every data item, or undefined for "the
 * upload key pays".
 *
 * Same rules as Turbo's CLI (`paidByFromOptions`), which the SDK does not
 * export: an explicit list wins; otherwise every address that has shared
 * credits with this key, unless approvals are ignored. The bundler only
 * spends shared credits for a data item that names the payer, so without
 * this a balance made of received credits passes no upload.
 */
export function resolvePaidBy(
  options: PayerOptions,
  receivedApprovals: CreditShareApproval[],
  signerAddress: string,
): string[] | undefined {
  let paidBy: string[] | undefined
  if (options.paidBy && options.paidBy.length > 0) {
    paidBy = [...options.paidBy]
  } else if (!options.ignoreApprovals && receivedApprovals.length > 0) {
    paidBy = [...new Set(receivedApprovals.map((approval) => approval.payingAddress))]
  }

  if (paidBy && options.useSignerBalanceFirst) {
    paidBy.unshift(signerAddress)
  }

  return paidBy
}

/** EVM addresses are case-insensitive (checksum casing); others are not. */
function normalizeAddress(address: string): string {
  return /^0x[\da-f]{40}$/i.test(address) ? address.toLowerCase() : address
}

function remainingWinc(approval: CreditShareApproval, now: number): bigint {
  if (approval.expirationDate && Date.parse(approval.expirationDate) <= now) {
    return 0n
  }

  const remaining = BigInt(approval.approvedWincAmount) - BigInt(approval.usedWincAmount)
  return remaining > 0n ? remaining : 0n
}

/**
 * Credits this upload can actually spend.
 *
 * With every received approval in play that is Turbo's `effectiveBalance`.
 * Ignoring approvals leaves the key's own `winc`. Naming payers counts only
 * what those payers shared, since the bundler will charge nobody else.
 */
export function spendableWinc(
  balance: Pick<TurboBalanceResponse, 'effectiveBalance' | 'receivedApprovals' | 'winc'>,
  options: PayerOptions,
  now = Date.now(),
): bigint {
  const own = BigInt(balance.winc)
  if (options.paidBy && options.paidBy.length > 0) {
    const payers = new Set(options.paidBy.map((address) => normalizeAddress(address)))
    return (balance.receivedApprovals ?? [])
      .filter((approval) => payers.has(normalizeAddress(approval.payingAddress)))
      .reduce((sum, approval) => sum + remainingWinc(approval, now), own)
  }

  if (options.ignoreApprovals) {
    return own
  }

  return BigInt(balance.effectiveBalance ?? balance.winc)
}

/**
 * Largest free data item when the upload service does not say: production's
 * limit, the smaller of the two networks, so the guess errs towards pricing.
 */
export const FALLBACK_FREE_ITEM_BYTES = 107_520

/**
 * What an upload can expect for free.
 *
 * Turbo uploads an item for free when it is within `maxItemBytes` and the
 * wallet still has free-tier bytes left: the tier is metered per wallet (and
 * per network). `bytesRemaining` is null when the wallet is unlimited or the
 * figure is unavailable.
 */
export interface FreeAllowance {
  bytesRemaining: bigint | null
  maxItemBytes: number
}

/** What the upload service says about itself; fields are absent when it does not say. */
export interface UploadServiceInfo {
  /** Largest free data item: 105 KiB in production, 5 MiB on the sandbox. */
  freeUploadLimitBytes?: number
  /** Gateway that serves this service's uploads first. */
  gateway?: string
}

/**
 * Read the upload service's info endpoint. Its free limit differs by network,
 * so it is read rather than assumed. Empty when the service cannot be reached.
 */
export async function fetchUploadServiceInfo(
  uploadUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadServiceInfo> {
  try {
    const response = await fetchImpl(`${uploadUrl.replace(/\/+$/, '')}/`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return {}
    }

    const info = (await response.json()) as Partial<TurboInfoResponse>
    return {
      ...(typeof info.freeUploadLimitBytes === 'number' && {
        freeUploadLimitBytes: info.freeUploadLimitBytes,
      }),
      ...(typeof info.gateway === 'string' && { gateway: info.gateway.replace(/\/+$/, '') }),
    }
  } catch {
    return {}
  }
}

/**
 * Bytes a data item adds on top of its payload: signature, owner, tags.
 *
 * Used to decide whether an item fits the free limit, which the upload
 * service applies to the whole signed item. An Arweave-signed item with this
 * tool's largest tag set measures 1,219 bytes (Ethereum and Solana about 330),
 * so this errs above the largest rather than splitting the difference:
 * guessing "free" for a billed item makes a deploy fail part-way.
 */
export const DATA_ITEM_HEADER_BYTES = 1300

/** Price quotes requested at once, so a large first deploy does not flood the service. */
const QUOTE_BATCH_SIZE = 20

export interface PricingClient {
  getUploadCosts(params: { bytes: number[] }): Promise<Array<{ winc: string }>>
}

/**
 * Winc needed to upload these items.
 *
 * Turbo bills per data item, so each is priced on its own. An item within the
 * free size limit costs nothing while the wallet's free-tier bytes last; once
 * they run out, small items are priced like any other. Pricing the sum instead
 * would charge a folder of small free files as one large paid item.
 */
export async function quoteUploadWinc(
  client: PricingClient,
  payloadByteCounts: number[],
  allowance: FreeAllowance,
): Promise<bigint> {
  let freeBytesLeft = allowance.bytesRemaining
  const paid: number[] = []
  for (const payload of payloadByteCounts) {
    const bytes = payload + DATA_ITEM_HEADER_BYTES
    const fitsBudget = freeBytesLeft === null || BigInt(bytes) <= freeBytesLeft
    if (bytes <= allowance.maxItemBytes && fitsBudget) {
      if (freeBytesLeft !== null) freeBytesLeft -= BigInt(bytes)
    } else {
      paid.push(bytes)
    }
  }

  if (paid.length === 0) {
    return 0n
  }

  const distinct = [...new Set(paid)]
  const prices = new Map<number, bigint>()
  for (let i = 0; i < distinct.length; i += QUOTE_BATCH_SIZE) {
    const batch = distinct.slice(i, i + QUOTE_BATCH_SIZE)
    const quotes = await client.getUploadCosts({ bytes: batch })
    for (const [index, bytes] of batch.entries()) {
      prices.set(bytes, BigInt(quotes[index].winc))
    }
  }

  return paid.reduce((sum, bytes) => sum + (prices.get(bytes) ?? 0n), 0n)
}

/**
 * The wallet's remaining free-upload allowance in bytes, or null when the
 * wallet is unlimited. Reads the payment service by address, so no key is
 * needed.
 *
 * @throws When the payment service cannot be reached.
 */
export async function fetchFreeBytesRemaining(
  paymentUrl: string,
  address: string,
  token: TokenType,
): Promise<bigint | null> {
  const client = TurboFactory.unauthenticated({ paymentServiceConfig: { url: paymentUrl }, token })
  const { bytesRemaining } = await client.getFreeStatus(address)
  return bytesRemaining === null ? null : BigInt(bytesRemaining)
}

type FundStatus = TurboSubmitFundTxResponse['status']

export interface FundingClient {
  getWincForToken(params: { tokenAmount: string }): Promise<Pick<TurboWincForTokenResponse, 'winc'>>
  submitFundTransaction(params: {
    txId: string
  }): Promise<Pick<TurboSubmitFundTxResponse, 'status'>>
  topUpWithTokens(params: {
    tokenAmount: string
  }): Promise<Pick<TurboCryptoFundResponse, 'id' | 'status'>>
}

export interface FundingResult {
  /** False when the top-up did not confirm in time; the upload may still be refused. */
  confirmed: boolean
  tokenAmount: bigint
  txId: string
}

export interface PollOptions {
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

/**
 * What a failed `submitFundTransaction` means.
 *
 * The payment service answers 400 both for a transaction that will never be
 * credited (failed on chain, wrong recipient, too small) and for one that is
 * merely not mined yet, and 404 for one its gateway has not seen yet. Only the
 * body tells them apart. 403 (sender excluded) is final; 5xx and network
 * errors are worth retrying.
 */
function classifyFundError(error: unknown): { failed: string } | 'retry' {
  const status = (error as { status?: number } | undefined)?.status
  const message = error instanceof Error ? error.message : String(error)
  if (status === 404 || (status === 400 && /not been mined yet/i.test(message))) {
    return 'retry'
  }

  if (status === 400 || status === 403) {
    return { failed: message }
  }

  return 'retry'
}

/**
 * Wait for the payment service to credit a fund transaction.
 *
 * Bounded by wall-clock time as well as by attempts: every poll is a POST the
 * SDK retries with backoff on a 5xx, so counting attempts alone can wait many
 * times longer than the timeout.
 *
 * @returns 'confirmed', or 'pending' when the time ran out.
 * @throws When the service says the transaction will never be credited.
 */
export async function waitForFundTransaction(
  client: Pick<FundingClient, 'submitFundTransaction'>,
  txId: string,
  options: { initial?: FundStatus } & PollOptions = {},
): Promise<'confirmed' | 'pending'> {
  const {
    initial = 'pending',
    pollIntervalMs = 3000,
    sleep = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms)
      }),
    timeoutMs = 120_000,
  } = options

  let status: FundStatus = initial
  const deadline = Date.now() + timeoutMs
  const maxPolls = Math.ceil(timeoutMs / pollIntervalMs)
  for (let poll = 0; status === 'pending' && poll < maxPolls && Date.now() < deadline; poll++) {
    await sleep(pollIntervalMs)
    try {
      const result = await client.submitFundTransaction({ txId })
      status = result.status
    } catch (error) {
      const outcome = classifyFundError(error)
      if (outcome !== 'retry') {
        throw new Error(`Top-up transaction ${txId} will not be credited: ${outcome.failed}`)
      }
    }
  }

  if (status === 'failed') {
    throw new Error(`Top-up transaction ${txId} failed`)
  }

  return status
}

/**
 * The fund transaction id in the error `topUpWithTokens` throws when the
 * tokens were sent but Turbo could not record the payment yet. The transfer
 * has happened; the id is the only way to collect the credits for it.
 */
export function sentTransactionIdFrom(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : ''
  return /submitFundTransaction\(id\)'?:\s*(\S+)\s*$/.exec(message)?.[1]
}

/**
 * Buy the credits an upload plan is short, in one top-up, before uploading.
 *
 * Turbo's `OnDemandFunding` tops up per `uploadFile` call. A deploy uploads
 * many files concurrently, so each worker saw the same shortfall and bought
 * its own top-up, and `--max-token-amount` capped each purchase rather than
 * the deploy. Funding the plan's total once, then uploading against the
 * balance, makes the cap a real cap. The arithmetic matches Turbo's: the
 * shortfall plus a buffer, converted at Turbo's quoted rate.
 *
 * `onSent` hears the transaction id as soon as tokens have moved, before
 * waiting for credit, so a run that dies while waiting can be resumed rather
 * than paid for twice.
 */
export async function fundShortfall(
  client: FundingClient,
  options: {
    bufferMultiplier?: number
    maxTokenAmount: bigint
    onSent?: (txId: string) => void
    shortfallWinc: bigint
    token: TokenType
  } & PollOptions,
): Promise<FundingResult> {
  const { bufferMultiplier = 1.1, maxTokenAmount, onSent, shortfallWinc, token } = options

  const oneToken = 10n ** BigInt(exponentMap[token])
  const { winc: wincPerToken } = await client.getWincForToken({ tokenAmount: oneToken.toString() })
  const rate = BigInt(wincPerToken)
  if (rate <= 0n) {
    throw new Error(`Turbo quoted no credits for ${token}; cannot top up`)
  }

  // Integer basis points keep the buffer exact without floating point.
  const bufferBps = BigInt(Math.round(bufferMultiplier * 10_000))
  const topUpWinc = (shortfallWinc * bufferBps + 9999n) / 10_000n
  const tokenAmount = (topUpWinc * oneToken + rate - 1n) / rate

  if (tokenAmount > maxTokenAmount) {
    throw new Error(
      `Topping up ${topUpWinc} winc needs ${fromBaseUnits(tokenAmount, token)} ${token}, ` +
        `more than --max-token-amount ${fromBaseUnits(maxTokenAmount, token)} ${token}.`,
    )
  }

  let txId: string
  let initial: FundStatus
  try {
    const response = await client.topUpWithTokens({ tokenAmount: tokenAmount.toString() })
    txId = response.id
    initial = response.status
  } catch (error) {
    // Tokens sent, payment not yet recorded: keep the id and wait for it.
    const sent = sentTransactionIdFrom(error)
    if (!sent) throw error
    txId = sent
    initial = 'pending'
  }

  onSent?.(txId)
  if (initial === 'failed') {
    throw new Error(`Top-up transaction ${txId} failed`)
  }

  const status = await waitForFundTransaction(client, txId, { ...options, initial })
  return { confirmed: status === 'confirmed', tokenAmount, txId }
}

/** A top-up whose tokens were sent but whose credits this tool has not seen land. */
export interface PendingTopUp {
  createdAt: string
  token: TokenType
  txId: string
}

function pendingTopUpPath(scope?: string): string {
  return path.join(
    process.cwd(),
    CACHE_DIR,
    scope ? `pending-topup.${scope}.json` : 'pending-topup.json',
  )
}

/** The pending top-up recorded by an earlier run, if any. */
export function loadPendingTopUp(scope?: string): PendingTopUp | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingTopUpPath(scope), 'utf8')) as PendingTopUp
    return typeof parsed?.txId === 'string' && typeof parsed.token === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Record (or, with undefined, forget) a sent top-up. Best effort: failing to
 * write it must not fail a deploy whose tokens have already moved.
 */
export function savePendingTopUp(pending: PendingTopUp | undefined, scope?: string): void {
  const file = pendingTopUpPath(scope)
  try {
    if (pending) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(pending, null, 2), 'utf8')
    } else {
      fs.rmSync(file, { force: true })
    }
  } catch {
    // The id is also printed; losing the file only loses the automatic resume.
  }
}
