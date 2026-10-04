import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { TokenTools } from '@ardrive/turbo-sdk'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runUploadWorkflow } from '../../src/workflows/upload-workflow.js'
import { TEST_ARWEAVE_WALLET, TEST_ETH_PRIVATE_KEY } from '../constants.js'
import { server } from '../setup.js'

/**
 * Payment behaviour, driven through the real workflow and the real Turbo SDK
 * against mocked Turbo HTTP. Each block pins one of the reported gaps: which
 * payment service is asked, whether shared credits reach the bundler, and how
 * often an on-demand top-up pays.
 */

const ARWEAVE_KEY = Buffer.from(JSON.stringify(TEST_ARWEAVE_WALLET)).toString('base64')

const PROD = { payment: 'https://payment.ardrive.io', upload: 'https://upload.ardrive.io' }
const DEV = {
  payment: 'https://payment.services.ar-io.dev',
  upload: 'https://upload.services.ar-io.dev',
}

interface Balance {
  effectiveBalance: string
  receivedApprovals?: Array<{
    approvedWincAmount: string
    payingAddress: string
    usedWincAmount: string
  }>
  winc: string
}

/** Everything a run asked of one Turbo deployment. */
interface Traffic {
  balanceRequests: number
  /** `x-paid-by` of every data item posted, in order. */
  paidBy: Array<string | null>
  priceRequests: string[]
  uploads: number
}

/**
 * Handlers for one upload + payment service pair. Requests to any other
 * Turbo host are left to the default mocks, so a run that talks to the wrong
 * network shows up as traffic missing here.
 */
function turboAt(
  base: { payment: string; upload: string },
  options: {
    balance?: () => Balance
    /** Free-tier bytes the wallet has left; null (the default) is unlimited. */
    freeBytesRemaining?: null | number
    freeLimit?: number
    /** Answer this upload (1-based) with a 402, as the bundler does when unpaid. */
    rejectUpload?: (n: number) => boolean
    wincPerByte?: number
  } = {},
): Traffic {
  const traffic: Traffic = { balanceRequests: 0, paidBy: [], priceRequests: [], uploads: 0 }
  const { freeLimit = 107_520, wincPerByte = 10 } = options
  const balance: () => Balance =
    options.balance ?? (() => ({ effectiveBalance: '1000000000000', winc: '1000000000000' }))

  const balanceReply = () => {
    traffic.balanceRequests += 1
    const { effectiveBalance, receivedApprovals = [], winc } = balance()
    return HttpResponse.json({
      controlledWinc: winc,
      effectiveBalance,
      givenApprovals: [],
      receivedApprovals: receivedApprovals.map((approval) => ({
        approvalDataItemId: `approval-${approval.payingAddress}`,
        approvedAddress: 'signer',
        creationDate: '2026-01-01T00:00:00.000Z',
        ...approval,
      })),
      winc,
    })
  }

  server.use(
    http.get(`${base.upload}/`, () =>
      HttpResponse.json({ addresses: {}, freeUploadLimitBytes: freeLimit, version: '0.2.0' }),
    ),
    http.post(`${base.upload}/v1/tx/:token`, ({ request }) => {
      traffic.uploads += 1
      if (options.rejectUpload?.(traffic.uploads)) {
        return new HttpResponse('Insufficient balance', { status: 402 })
      }

      traffic.paidBy.push(request.headers.get('x-paid-by'))
      return HttpResponse.json({
        dataCaches: [],
        deadlineHeight: 1,
        fastFinalityIndexes: [],
        id: `tx${String(traffic.uploads).padStart(41, '0')}`,
        owner: 'owner',
        timestamp: Date.now(),
        winc: '0',
      })
    }),
    http.get(`${base.payment}/v1/price/bytes/:bytes`, ({ params }) => {
      traffic.priceRequests.push(String(params.bytes))
      return HttpResponse.json({
        adjustments: [],
        winc: String(Number(params.bytes) * wincPerByte),
      })
    }),
    http.get(`${base.payment}/v1/account/free`, () =>
      HttpResponse.json({ bytesRemaining: options.freeBytesRemaining ?? null }),
    ),
    http.get(`${base.payment}/v1/balance`, balanceReply),
    http.get(`${base.payment}/v1/account/balance/:token`, balanceReply),
  )

  return traffic
}

/** Production traffic that must not happen when the run targets the sandbox. */
function watchProductionPayment(): string[] {
  const seen: string[] = []
  server.use(
    http.all(`${PROD.payment}/*`, ({ request }) => {
      seen.push(request.url)
      return HttpResponse.json({}, { status: 500 })
    }),
  )
  return seen
}

let workdir: string
let folder: string
let cwdSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-pay-'))
  folder = path.join(workdir, 'dist')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'index.html'), '<html>index</html>')
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workdir)
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(workdir, { force: true, recursive: true })
})

/** `count` files Turbo bills individually, each a different size. */
function writePaidFiles(count: number): void {
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(folder, `chunk-${i}.bin`), Buffer.alloc(150_000 + i * 1000, i + 1))
  }
}

const io = {
  error(message: string): never {
    throw new Error(message)
  },
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    'dedupe-cache-max-entries': 0,
    'deploy-folder': folder,
    'sig-type': 'arweave',
    ...overrides,
  }
}

const sharedOnly = (): Balance => ({
  effectiveBalance: '100000000000',
  receivedApprovals: [
    { approvedWincAmount: '100000000000', payingAddress: 'alice', usedWincAmount: '0' },
  ],
  winc: '0',
})

/**
 * A chain that records every transfer instead of making it. A transfer
 * takes a while to land, as on a real chain; an instant one would let the
 * first top-up finish before any other upload looked at the balance, and
 * hide the race this guards against.
 */
function fakeChain(): { transfers: string[] } & TokenTools {
  const transfers: string[] = []
  return {
    async createAndSubmitTx({ tokenAmount }) {
      transfers.push(String(tokenAmount))
      await new Promise((resolve) => {
        setTimeout(resolve, 300)
      })
      return { id: `fund-${transfers.length}`, target: 'turbo' }
    },
    async pollTxAvailability() {},
    transfers,
  }
}

/**
 * Payment endpoints a top-up needs. The balance stays empty until the
 * transfer is credited, as it would on a real chain.
 */
function fundable(answer: 'credit' | 'fail' | 'pending' = 'credit'): {
  credited: () => boolean
  submits: () => number
} {
  let credited = false
  let submits = 0
  server.use(
    http.get(`${PROD.payment}/v1/info`, () =>
      HttpResponse.json({ addresses: { 'base-eth': '0xturbo' } }),
    ),
    // 1 ETH buys 10^15 winc.
    http.get(`${PROD.payment}/v1/price/:token/:amount`, () =>
      HttpResponse.json({
        actualPaymentAmount: 1,
        adjustments: [],
        fees: [],
        quotedPaymentAmount: 1,
        winc: '1000000000000000',
      }),
    ),
    http.post(`${PROD.payment}/v1/account/balance/:token`, async ({ request }) => {
      submits += 1
      const { tx_id: id } = (await request.json()) as { tx_id: string }
      // The payment service's real answers (addPendingPaymentTx.ts).
      if (answer === 'fail') {
        return HttpResponse.json({ failedTransaction: { transactionId: id } }, { status: 400 })
      }

      if (answer === 'pending') {
        return HttpResponse.json({ pendingTransaction: { transactionId: id } }, { status: 202 })
      }

      credited = true
      return HttpResponse.json({
        creditedTransaction: {
          block: 1,
          destinationAddress: 'me',
          destinationAddressType: 'ethereum',
          transactionId: id,
          transactionQuantity: '1',
          winstonCreditAmount: '1000000000000000',
        },
        message: 'credited',
      })
    }),
  )
  return { credited: () => credited, submits: () => submits }
}

const ethConfig = (overrides: Record<string, unknown> = {}) =>
  config({
    'max-token-amount': '1',
    'on-demand': 'base-eth',
    'sig-type': 'ethereum',
    ...overrides,
  })

describe('the sandbox uses its own payment service', () => {
  it('sends balance and price checks to the sandbox when --uploader is the sandbox', async () => {
    writePaidFiles(1)
    const prodPayment = watchProductionPayment()
    const dev = turboAt(DEV, { freeLimit: 0 })

    await runUploadWorkflow(ARWEAVE_KEY, config({ uploader: DEV.upload }), io)

    expect(dev.priceRequests.length).toBeGreaterThan(0)
    expect(dev.balanceRequests).toBe(1)
    expect(dev.uploads).toBe(3) // the chunk, index.html and the manifest
    expect(prodPayment).toEqual([])
  })

  it('selects both sandbox services with --dev', async () => {
    writePaidFiles(1)
    const prodPayment = watchProductionPayment()
    const dev = turboAt(DEV, { freeLimit: 0 })

    await runUploadWorkflow(ARWEAVE_KEY, config({ dev: true }), io)

    expect(dev.uploads).toBe(3)
    expect(dev.balanceRequests).toBe(1)
    expect(prodPayment).toEqual([])
  })

  it("prices against the sandbox's own free limit, not production's", async () => {
    // 150 KB is a paid item in production but free under the sandbox's 5 MiB.
    writePaidFiles(1)
    const dev = turboAt(DEV, {
      balance: () => ({ effectiveBalance: '0', winc: '0' }),
      freeLimit: 5_242_880,
    })

    await runUploadWorkflow(ARWEAVE_KEY, config({ dev: true }), io)

    expect(dev.priceRequests).toEqual([])
    expect(dev.uploads).toBe(3)
  })
})

describe('credits shared with the upload key', () => {
  it('pass the credit check and name the payer on every data item', async () => {
    writePaidFiles(2)
    const prod = turboAt(PROD, { balance: sharedOnly })

    await runUploadWorkflow(ARWEAVE_KEY, config(), io)

    // Two chunks, index.html and the manifest: every one tells the bundler who pays.
    expect(prod.paidBy).toEqual(['alice', 'alice', 'alice', 'alice'])
  })

  it('are not used with --ignore-approvals', async () => {
    writePaidFiles(1)
    const prod = turboAt(PROD, { balance: sharedOnly })

    await expect(
      runUploadWorkflow(ARWEAVE_KEY, config({ 'ignore-approvals': true }), io),
    ).rejects.toThrow(/Insufficient Turbo credits/)
    expect(prod.uploads).toBe(0)
  })

  it('count only the payers named with --paid-by', async () => {
    writePaidFiles(1)
    const prod = turboAt(PROD, { balance: sharedOnly })

    await expect(runUploadWorkflow(ARWEAVE_KEY, config({ 'paid-by': 'bob' }), io)).rejects.toThrow(
      /Insufficient Turbo credits/,
    )
    expect(prod.uploads).toBe(0)
  })

  it('send no payer when nothing was shared', async () => {
    writePaidFiles(1)
    const prod = turboAt(PROD)

    await runUploadWorkflow(ARWEAVE_KEY, config(), io)

    expect(prod.paidBy).toEqual([null, null, null])
  })
})

describe('on-demand funding', () => {
  it('tops up once for the whole folder, before uploading, however many files upload at once', async () => {
    writePaidFiles(8)
    const chain = fakeChain()
    const funding = fundable()
    const prod = turboAt(PROD, {
      balance: () =>
        funding.credited()
          ? { effectiveBalance: '1000000000000000', winc: '1000000000000000' }
          : { effectiveBalance: '0', winc: '0' },
    })

    await runUploadWorkflow(TEST_ETH_PRIVATE_KEY, ethConfig(), { ...io, tokenTools: chain })

    expect(chain.transfers).toHaveLength(1)
    expect(prod.uploads).toBe(10) // eight chunks, index.html and the manifest
  })

  it('refuses, before paying anything, a top-up larger than --max-token-amount', async () => {
    writePaidFiles(2)
    const chain = fakeChain()
    fundable()
    const prod = turboAt(PROD, { balance: () => ({ effectiveBalance: '0', winc: '0' }) })

    await expect(
      runUploadWorkflow(
        TEST_ETH_PRIVATE_KEY,
        ethConfig({ 'max-token-amount': '0.000000000000000001' }),
        { ...io, tokenTools: chain },
      ),
    ).rejects.toThrow(/On-demand top-up failed: .*more than --max-token-amount/)
    expect(chain.transfers).toEqual([])
    expect(prod.uploads).toBe(0)
  })

  it('does not top up when the balance already covers the upload', async () => {
    writePaidFiles(2)
    const chain = fakeChain()
    const prod = turboAt(PROD)

    await runUploadWorkflow(TEST_ETH_PRIVATE_KEY, ethConfig(), { ...io, tokenTools: chain })

    expect(chain.transfers).toEqual([])
    expect(prod.uploads).toBe(4)
  })

  it('refuses a token the upload key cannot pay with, before any network call', async () => {
    writePaidFiles(1)
    const prod = turboAt(PROD)

    await expect(
      runUploadWorkflow(ARWEAVE_KEY, config({ 'max-token-amount': '1', 'on-demand': 'ario' }), io),
    ).rejects.toThrow(/not available for arweave upload keys/)
    expect(prod.balanceRequests).toBe(0)
    expect(prod.uploads).toBe(0)
  })
})

/** Polling short enough for a test; the real default waits two minutes. */
const quickPoll = { pollIntervalMs: 1, async sleep() {}, timeoutMs: 50 }

describe('top-ups that do not land', () => {
  it('stops at once, without uploading, when the payment service rejects the transfer', async () => {
    writePaidFiles(2)
    const chain = fakeChain()
    fundable('fail')
    const prod = turboAt(PROD, { balance: () => ({ effectiveBalance: '0', winc: '0' }) })

    await expect(
      runUploadWorkflow(TEST_ETH_PRIVATE_KEY, ethConfig(), {
        ...io,
        fundingPoll: quickPoll,
        tokenTools: chain,
      }),
    ).rejects.toThrow(/On-demand top-up failed: .*will not be credited/)
    expect(prod.uploads).toBe(0)
  })

  it('does not upload against an uncredited top-up, and a re-run waits for it instead of paying again', async () => {
    writePaidFiles(2)
    const chain = fakeChain()
    const pending = fundable('pending')
    turboAt(PROD, { balance: () => ({ effectiveBalance: '0', winc: '0' }) })
    const ioWithChain = { ...io, fundingPoll: quickPoll, tokenTools: chain }

    await expect(runUploadWorkflow(TEST_ETH_PRIVATE_KEY, ethConfig(), ioWithChain)).rejects.toThrow(
      /has not credited it yet/,
    )
    expect(chain.transfers).toHaveLength(1)
    expect(pending.submits()).toBeGreaterThan(0)

    // The transfer lands; the next run collects it rather than buying again.
    const landed = fundable('credit')
    const prod = turboAt(PROD, {
      balance: () =>
        landed.credited()
          ? { effectiveBalance: '1000000000000000', winc: '1000000000000000' }
          : { effectiveBalance: '0', winc: '0' },
    })

    await runUploadWorkflow(TEST_ETH_PRIVATE_KEY, ethConfig(), ioWithChain)

    expect(chain.transfers).toHaveLength(1)
    expect(prod.uploads).toBe(4)
  })
})

describe('a single file that is already uploaded', () => {
  it('is neither priced nor paid for, even with on-demand funding', async () => {
    fs.writeFileSync(path.join(folder, 'bundle.js'), Buffer.alloc(200_000, 1))
    const deployFile = path.join(folder, 'bundle.js')
    const cached = { 'dedupe-cache-max-entries': 1000, 'deploy-file': deployFile }

    // First run uploads it, paid from balance.
    turboAt(PROD)
    const first = await runUploadWorkflow(TEST_ETH_PRIVATE_KEY, ethConfig(cached), io)

    // Second run: empty balance and on-demand on. The cache already holds it.
    const chain = fakeChain()
    fundable()
    const prod = turboAt(PROD, { balance: () => ({ effectiveBalance: '0', winc: '0' }) })
    const second = await runUploadWorkflow(TEST_ETH_PRIVATE_KEY, ethConfig(cached), {
      ...io,
      tokenTools: chain,
    })

    expect(second.transactionId).toBe(first.transactionId)
    expect(chain.transfers).toEqual([])
    expect(prod.priceRequests).toEqual([])
    expect(prod.uploads).toBe(0)
  })
})

describe("the wallet's metered free tier", () => {
  it('prices small files once the free-tier bytes are spent, and tops up for them', async () => {
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(folder, `small-${i}.txt`), `small file ${i}`)
    }

    const chain = fakeChain()
    const funding = fundable()
    const prod = turboAt(PROD, {
      balance: () =>
        funding.credited()
          ? { effectiveBalance: '1000000000000000', winc: '1000000000000000' }
          : { effectiveBalance: '0', winc: '0' },
      freeBytesRemaining: 0,
    })

    await runUploadWorkflow(TEST_ETH_PRIVATE_KEY, ethConfig(), { ...io, tokenTools: chain })

    // Every item, the manifest included, is priced, and one top-up covers them.
    expect(prod.priceRequests.length).toBeGreaterThan(0)
    expect(chain.transfers).toHaveLength(1)
  })

  it('still names the payers of shared credits when the upload is expected to be free', async () => {
    const prod = turboAt(PROD, {
      balance: () => ({
        effectiveBalance: '100',
        receivedApprovals: [
          { approvedWincAmount: '100', payingAddress: 'alice', usedWincAmount: '0' },
        ],
        winc: '0',
      }),
    })

    await runUploadWorkflow(ARWEAVE_KEY, config(), io)

    // index.html and the manifest are free by size, but the free tier is
    // decided at upload time; if it does not cover them, alice pays.
    expect(prod.priceRequests).toEqual([])
    expect(prod.paidBy).toEqual(['alice', 'alice'])
  })
})

describe('partial failure', () => {
  it('keeps the ids of files that did upload, so a re-run pays only for the rest', async () => {
    writePaidFiles(3)
    const cachedConfig = config({ 'dedupe-cache-max-entries': 1000 })

    // The second data item is refused; the others land.
    turboAt(PROD, { rejectUpload: (n) => n === 2 })
    await expect(runUploadWorkflow(ARWEAVE_KEY, cachedConfig, io)).rejects.toThrow(
      /Files that did upload are cached/,
    )

    const retry = turboAt(PROD)
    await runUploadWorkflow(ARWEAVE_KEY, cachedConfig, io)

    // Four files (three chunks and index.html) went up the first time, less the
    // refused one; the re-run sends that one and the manifest.
    expect(retry.uploads).toBe(2)
  })

  it('does not fail a paid deploy because the cache cannot be written', async () => {
    // A file where the cache directory should be makes every write fail.
    fs.writeFileSync(path.join(workdir, '.ario-deploy'), 'not a directory')
    const prod = turboAt(PROD)

    const result = await runUploadWorkflow(
      ARWEAVE_KEY,
      config({ 'dedupe-cache-max-entries': 1000 }),
      io,
    )

    expect(result.transactionId).toMatch(/^tx/)
    expect(prod.uploads).toBe(2)
  })
})

describe('local state is kept per network', () => {
  it('never reuses a sandbox upload for a production deploy', async () => {
    const cachedConfig = config({ 'dedupe-cache-max-entries': 1000 })

    const dev = turboAt(DEV)
    await runUploadWorkflow(ARWEAVE_KEY, { ...cachedConfig, dev: true }, io)
    expect(dev.uploads).toBe(2)

    const prod = turboAt(PROD)
    await runUploadWorkflow(ARWEAVE_KEY, cachedConfig, io)

    // index.html is uploaded again: the sandbox id would not resolve on mainnet gateways.
    expect(prod.uploads).toBe(2)
  })
})

describe('service URLs', () => {
  it('refuses an --uploader that is not a URL before touching the network', async () => {
    const prod = turboAt(PROD)

    await expect(
      runUploadWorkflow(ARWEAVE_KEY, config({ uploader: 'upload.ardrive.io' }), io),
    ).rejects.toThrow(/--uploader must be an http\(s\) URL/)
    expect(prod.uploads).toBe(0)
  })

  it('strips a trailing slash, which Turbo would turn into a //v1 path that 404s', async () => {
    writePaidFiles(1)
    const prod = turboAt(PROD, { freeLimit: 0 })

    await runUploadWorkflow(
      ARWEAVE_KEY,
      config({
        'payment-url': 'https://payment.ardrive.io/',
        uploader: 'https://upload.ardrive.io/',
      }),
      io,
    )

    expect(prod.balanceRequests).toBe(1)
    expect(prod.uploads).toBe(3)
  })
})
