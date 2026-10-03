import { defaultTurboConfiguration, developmentTurboConfiguration } from '@ardrive/turbo-sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  DATA_ITEM_HEADER_BYTES,
  fetchFreeUploadLimit,
  fromBaseUnits,
  fundShortfall,
  quoteUploadWinc,
  resolvePaidBy,
  resolveTurboServices,
  spendableWinc,
  toBaseUnits,
  validateOnDemandToken,
} from '../../src/utils/turbo.js'

const PROD_UPLOAD = defaultTurboConfiguration.uploadServiceConfig.url
const PROD_PAYMENT = defaultTurboConfiguration.paymentServiceConfig.url
const DEV_UPLOAD = developmentTurboConfiguration.uploadServiceConfig.url
const DEV_PAYMENT = developmentTurboConfiguration.paymentServiceConfig.url

describe('resolveTurboServices', () => {
  it('defaults to production for both services', () => {
    expect(resolveTurboServices({})).toEqual({
      development: false,
      paymentUrl: PROD_PAYMENT,
      uploadUrl: PROD_UPLOAD,
      warnings: [],
    })
  })

  it('selects both sandbox services with --dev', () => {
    const services = resolveTurboServices({ dev: true })
    expect(services).toMatchObject({
      development: true,
      paymentUrl: DEV_PAYMENT,
      uploadUrl: DEV_UPLOAD,
    })
    expect(services.warnings).toEqual([])
  })

  it('pairs the sandbox payment service with a sandbox --uploader (the reported bug)', () => {
    const services = resolveTurboServices({ uploadUrl: `${DEV_UPLOAD}/` })
    expect(services.development).toBe(true)
    expect(services.paymentUrl).toBe(DEV_PAYMENT)
    expect(services.warnings).toEqual([])
  })

  it('pairs the sandbox upload service with a sandbox --payment-url', () => {
    const services = resolveTurboServices({ paymentUrl: DEV_PAYMENT })
    expect(services.uploadUrl).toBe(DEV_UPLOAD)
    expect(services.development).toBe(true)
  })

  it('warns when a custom uploader has no payment service of its own', () => {
    const services = resolveTurboServices({ uploadUrl: 'https://bundler.example.com' })
    expect(services.paymentUrl).toBe(PROD_PAYMENT)
    expect(services.warnings).toHaveLength(1)
    expect(services.warnings[0]).toMatch(/--payment-url/)
  })

  it('stays quiet when both custom services are given', () => {
    const services = resolveTurboServices({
      paymentUrl: 'https://pay.example.com',
      uploadUrl: 'https://bundler.example.com',
    })
    expect(services.warnings).toEqual([])
  })

  it('warns when the services are explicitly on different networks', () => {
    const services = resolveTurboServices({ paymentUrl: PROD_PAYMENT, uploadUrl: DEV_UPLOAD })
    expect(services.warnings.join(' ')).toMatch(/different networks/)
  })
})

describe('validateOnDemandToken', () => {
  it.each([
    ['solana', 'ario'],
    ['solana', 'solana'],
    ['solana', 'solana-usdc'],
    ['ethereum', 'base-eth'],
    ['ethereum', 'base-usdc'],
    ['polygon', 'base-eth'],
  ])('accepts %s keys paying with %s', (sigType, token) => {
    expect(validateOnDemandToken(sigType, token)).toBe(true)
  })

  it('refuses a token the key cannot sign for, naming the ones it can', () => {
    const result = validateOnDemandToken('ethereum', 'ario')
    expect(result).toMatch(/base-eth, base-usdc/)
  })

  it('explains that Arweave keys have no on-demand token', () => {
    expect(validateOnDemandToken('arweave', 'ario')).toMatch(/not available for arweave/)
  })
})

describe('token amounts', () => {
  it('converts decimals to base units exactly', () => {
    expect(toBaseUnits('1.5', 'ario')).toBe(1_500_000n)
    expect(toBaseUnits('0.000000001', 'solana')).toBe(1n)
    expect(toBaseUnits('1000', 'base-eth')).toBe(1000n * 10n ** 18n)
    expect(toBaseUnits('.25', 'solana-usdc')).toBe(250_000n)
  })

  it('refuses more decimals than the token has', () => {
    expect(() => toBaseUnits('0.0000001', 'ario')).toThrow(/6 decimals/)
  })

  it('refuses things that are not amounts', () => {
    expect(() => toBaseUnits('1e3', 'ario')).toThrow(/Invalid token amount/)
    expect(() => toBaseUnits('-1', 'ario')).toThrow(/Invalid token amount/)
  })

  it('round-trips to a readable amount', () => {
    expect(fromBaseUnits(1_500_000n, 'ario')).toBe('1.5')
    expect(fromBaseUnits(2n * 10n ** 18n, 'base-eth')).toBe('2')
  })
})

const approval = (
  payingAddress: string,
  approved: string,
  used = '0',
  expirationDate?: string,
) => ({
  approvalDataItemId: `approval-${payingAddress}`,
  approvedAddress: 'me',
  approvedWincAmount: approved,
  creationDate: '2026-01-01T00:00:00.000Z',
  expirationDate,
  payingAddress,
  usedWincAmount: used,
})

describe('resolvePaidBy', () => {
  it('uses every wallet that shared credits, once each, by default', () => {
    const received = [approval('alice', '10'), approval('bob', '5'), approval('alice', '3')]
    expect(resolvePaidBy({}, received, 'me')).toEqual(['alice', 'bob'])
  })

  it('leaves the payer unset when nothing was shared', () => {
    expect(resolvePaidBy({}, [], 'me')).toBeUndefined()
  })

  it('prefers an explicit list', () => {
    expect(resolvePaidBy({ paidBy: ['carol'] }, [approval('alice', '10')], 'me')).toEqual(['carol'])
  })

  it('ignores approvals when asked', () => {
    expect(
      resolvePaidBy({ ignoreApprovals: true }, [approval('alice', '10')], 'me'),
    ).toBeUndefined()
  })

  it('puts the signer first with --use-signer-balance-first', () => {
    expect(resolvePaidBy({ useSignerBalanceFirst: true }, [approval('alice', '10')], 'me')).toEqual(
      ['me', 'alice'],
    )
  })
})

describe('spendableWinc', () => {
  const balance = {
    effectiveBalance: '160',
    receivedApprovals: [
      approval('alice', '100', '40'),
      approval('bob', '50'),
      approval('carol', '1000', '0', '2020-01-01T00:00:00.000Z'),
    ],
    winc: '50',
  }

  it("uses Turbo's effective balance by default, so shared credits count", () => {
    expect(spendableWinc(balance, {})).toBe(160n)
  })

  it('counts only the upload key when approvals are ignored', () => {
    expect(spendableWinc(balance, { ignoreApprovals: true })).toBe(50n)
  })

  it("counts only named payers' unexpired, unused credits", () => {
    expect(spendableWinc(balance, { paidBy: ['alice'] })).toBe(110n)
    expect(spendableWinc(balance, { paidBy: ['carol'] })).toBe(50n)
  })
})

describe('quoteUploadWinc', () => {
  it('prices nothing when every item is within the free limit', async () => {
    const client = { getUploadCosts: vi.fn() }
    expect(await quoteUploadWinc(client, [1000, 50_000], 107_520)).toBe(0n)
    expect(client.getUploadCosts).not.toHaveBeenCalled()
  })

  it('bills every paid item, including repeats, and nothing within the free limit', async () => {
    const client = {
      getUploadCosts: vi.fn(async ({ bytes }: { bytes: number[] }) =>
        bytes.map((count) => ({ winc: String(count * 10) })),
      ),
    }
    const big = 200_000
    // The 1 KB item is free; the two 200 KB items are each billed, header included.
    const total = await quoteUploadWinc(client, [1000, big, big], 107_520)
    expect(total).toBe(BigInt((big + DATA_ITEM_HEADER_BYTES) * 10 * 2))
  })

  it('counts the data item header against the free limit', async () => {
    const client = { getUploadCosts: vi.fn(async () => [{ winc: '7' }]) }
    // Payload fits, payload plus header does not: Turbo bills the signed item.
    expect(await quoteUploadWinc(client, [107_000], 107_520)).toBe(7n)
  })

  it('never asks for more than a bounded batch of quotes at once', async () => {
    const client = {
      getUploadCosts: vi.fn(async ({ bytes }: { bytes: number[] }) =>
        bytes.map(() => ({ winc: '1' })),
      ),
    }
    const sizes = Array.from({ length: 45 }, (_, i) => 200_000 + i)
    expect(await quoteUploadWinc(client, sizes, 0)).toBe(45n)
    for (const [{ bytes }] of client.getUploadCosts.mock.calls) {
      expect(bytes.length).toBeLessThanOrEqual(20)
    }
  })
})

describe('fetchFreeUploadLimit', () => {
  it('reads the limit the upload service reports', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) =>
      Response.json({ freeUploadLimitBytes: 5_242_880 }),
    )
    expect(await fetchFreeUploadLimit('https://upload.example.com/', fetchImpl)).toBe(5_242_880)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://upload.example.com/')
  })

  it('returns undefined when the service does not say', async () => {
    expect(await fetchFreeUploadLimit('https://x', async () => Response.json({}))).toBeUndefined()
    expect(
      await fetchFreeUploadLimit('https://x', async () => {
        throw new Error('offline')
      }),
    ).toBeUndefined()
  })
})

/** 1 ARIO buys 1,000,000 winc. */
const fundingClient = (statuses: Array<'confirmed' | 'failed' | 'pending'> = ['confirmed']) => ({
  getWincForToken: vi.fn(async () => ({ winc: '1000000' })),
  submitFundTransaction: vi.fn(async () => ({ status: statuses.shift() ?? 'pending' })),
  topUpWithTokens: vi.fn(async () => ({ id: 'fund-tx', status: 'pending' as const })),
})
const noSleep = async () => {}

describe('fundShortfall', () => {
  it('buys the shortfall plus a 10% buffer in one top-up', async () => {
    const turbo = fundingClient()
    const result = await fundShortfall(turbo, {
      maxTokenAmount: toBaseUnits('10', 'ario'),
      shortfallWinc: 1_000_000n,
      sleep: noSleep,
      token: 'ario',
    })
    // 1.1 ARIO, in base units.
    expect(turbo.topUpWithTokens).toHaveBeenCalledWith({ tokenAmount: '1100000' })
    expect(turbo.getWincForToken).toHaveBeenCalledWith({ tokenAmount: '1000000' })
    expect(result).toEqual({ confirmed: true, tokenAmount: 1_100_000n, txId: 'fund-tx' })
  })

  it('refuses before paying when the top-up would exceed the cap', async () => {
    const turbo = fundingClient()
    await expect(
      fundShortfall(turbo, {
        maxTokenAmount: toBaseUnits('1', 'ario'),
        shortfallWinc: 1_000_000n,
        sleep: noSleep,
        token: 'ario',
      }),
    ).rejects.toThrow(/needs 1.1 ario, more than --max-token-amount 1 ario/)
    expect(turbo.topUpWithTokens).not.toHaveBeenCalled()
  })

  it('polls until the payment service confirms', async () => {
    const turbo = fundingClient(['pending', 'pending', 'confirmed'])
    const result = await fundShortfall(turbo, {
      maxTokenAmount: toBaseUnits('10', 'ario'),
      shortfallWinc: 10n,
      sleep: noSleep,
      token: 'ario',
    })
    expect(result.confirmed).toBe(true)
  })

  it('reports an unconfirmed top-up instead of polling forever', async () => {
    const turbo = fundingClient([])
    const result = await fundShortfall(turbo, {
      maxTokenAmount: toBaseUnits('10', 'ario'),
      pollIntervalMs: 1000,
      shortfallWinc: 10n,
      sleep: noSleep,
      timeoutMs: 5000,
      token: 'ario',
    })
    expect(result.confirmed).toBe(false)
  })

  it('fails when the chain rejects the payment', async () => {
    const turbo = fundingClient(['failed'])
    await expect(
      fundShortfall(turbo, {
        maxTokenAmount: toBaseUnits('10', 'ario'),
        shortfallWinc: 10n,
        sleep: noSleep,
        token: 'ario',
      }),
    ).rejects.toThrow(/fund-tx failed/)
  })
})
