/**
 * Turbo payment and service configuration for a deploy.
 *
 * Turbo already models networks, funding tokens, credit sharing and pricing;
 * this module wires those primitives together for a deploy rather than
 * recreating them. Where a deploy has to own a decision -- which tokens a given
 * upload key can pay with, and funding a whole upload plan at once -- the
 * reason is written next to it.
 */

import {
  type CreditShareApproval,
  defaultTurboConfiguration,
  developmentTurboConfiguration,
  exponentMap,
  type TokenType,
  type TurboBalanceResponse,
  type TurboCryptoFundResponse,
  type TurboInfoResponse,
  type TurboSubmitFundTxResponse,
  type TurboWincForTokenResponse,
} from '@ardrive/turbo-sdk'

import type { SignerType } from '../types/index.js'

/** Upload and payment service URLs, chosen together. */
export interface TurboServices {
  /** True when both services are Turbo's development sandbox. */
  development: boolean
  paymentUrl: string
  uploadUrl: string
  /** Mismatches worth telling the user about before any money moves. */
  warnings: string[]
}

function sameUrl(a: string | undefined, b: string): boolean {
  return a !== undefined && a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
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

  return { development, paymentUrl, uploadUrl, warnings }
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
    const payers = new Set(options.paidBy)
    return (balance.receivedApprovals ?? [])
      .filter((approval) => payers.has(approval.payingAddress))
      .reduce((sum, approval) => sum + remainingWinc(approval, now), own)
  }

  if (options.ignoreApprovals) {
    return own
  }

  return BigInt(balance.effectiveBalance ?? balance.winc)
}

/**
 * Largest data item the upload service accepts for free, read from the
 * service itself because it differs by network: 105 KiB in production, 5 MiB
 * on the development sandbox. Undefined when the service does not say.
 */
export async function fetchFreeUploadLimit(
  uploadUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | undefined> {
  try {
    const response = await fetchImpl(`${uploadUrl.replace(/\/+$/, '')}/`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return undefined
    }

    const info = (await response.json()) as Partial<TurboInfoResponse>
    return typeof info.freeUploadLimitBytes === 'number' ? info.freeUploadLimitBytes : undefined
  } catch {
    return undefined
  }
}

/**
 * Bytes a data item adds on top of its payload: signature, owner, tags. The
 * same allowance Turbo's own on-demand estimate uses.
 */
export const DATA_ITEM_HEADER_BYTES = 1200

/** Price quotes requested at once, so a large first deploy does not flood the service. */
const QUOTE_BATCH_SIZE = 20

export interface PricingClient {
  getUploadCosts(params: { bytes: number[] }): Promise<Array<{ winc: string }>>
}

/**
 * Winc needed to upload these items.
 *
 * Turbo bills per data item, so each is priced on its own: an item within
 * the free limit costs nothing, and the rest are quoted through Turbo's
 * pricing. Pricing the sum instead would charge a folder of small free files
 * as one large paid item.
 */
export async function quoteUploadWinc(
  client: PricingClient,
  payloadByteCounts: number[],
  freeLimitBytes: number,
): Promise<bigint> {
  const itemBytes = payloadByteCounts.map((bytes) => bytes + DATA_ITEM_HEADER_BYTES)
  const paid = itemBytes.filter((bytes) => bytes > freeLimitBytes)
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

/**
 * Buy the credits an upload plan is short, in one top-up, before uploading.
 *
 * Turbo's `OnDemandFunding` tops up per `uploadFile` call. A deploy uploads
 * many files concurrently, so each worker saw the same shortfall and bought
 * its own top-up, and `--max-token-amount` capped each purchase rather than
 * the deploy. Funding the plan's total once, then uploading against the
 * balance, makes the cap a real cap. The arithmetic matches Turbo's: the
 * shortfall plus a buffer, converted at Turbo's quoted rate, polled until the
 * payment service confirms.
 */
export async function fundShortfall(
  client: FundingClient,
  options: {
    bufferMultiplier?: number
    maxTokenAmount: bigint
    pollIntervalMs?: number
    shortfallWinc: bigint
    sleep?: (ms: number) => Promise<void>
    timeoutMs?: number
    token: TokenType
  },
): Promise<FundingResult> {
  const {
    bufferMultiplier = 1.1,
    maxTokenAmount,
    pollIntervalMs = 3000,
    shortfallWinc,
    sleep = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms)
      }),
    timeoutMs = 120_000,
    token,
  } = options

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

  const response = await client.topUpWithTokens({ tokenAmount: tokenAmount.toString() })
  if (response.status === 'failed') {
    throw new Error(`Top-up transaction ${response.id} failed`)
  }

  /** The fund transaction's status, or undefined while the service has not seen it yet. */
  const fetchStatus = async (): Promise<FundStatus | undefined> => {
    try {
      const result = await client.submitFundTransaction({ txId: response.id })
      return result.status
    } catch {
      return undefined
    }
  }

  // Widened on purpose: a later poll can still report 'failed'.
  let current: FundStatus = response.status
  const maxPolls = Math.ceil(timeoutMs / pollIntervalMs)
  for (let poll = 0; current !== 'confirmed' && poll < maxPolls; poll++) {
    await sleep(pollIntervalMs)
    current = (await fetchStatus()) ?? current
    if (current === 'failed') {
      throw new Error(`Top-up transaction ${response.id} failed`)
    }
  }

  const confirmed = current === 'confirmed'

  return { confirmed, tokenAmount, txId: response.id }
}
