import { http, HttpResponse } from 'msw'

import type { components as PaymentComponents } from '../types/payment-service.js'
import type { components as UploadComponents } from '../types/upload-service.js'

/**
 * Default responses for the Turbo endpoints Turbo SDK 2.x actually calls.
 * Every route here was checked against the SDK source; a mock for a route the
 * SDK no longer calls makes a test pass while production breaks.
 */

type DataItemPost = UploadComponents['schemas']['DataItemPost']
type BalanceResponse = PaymentComponents['schemas']['BalanceResponse']
type CreditResponse = PaymentComponents['schemas']['CreditResponse']

export const mockTurboData = {
  balanceResponse: (winc = '1000000000000'): BalanceResponse => ({
    controlledWinc: winc,
    effectiveBalance: winc,
    winc,
  }),

  priceResponse: (winc = '100000000'): CreditResponse => ({
    adjustments: [],
    winc,
  }),

  uploadResponse: (id = 'NkeBzc8ObeLGw_L9AO-ivBN8H-ZUKOhOvmDKdBRxVUw'): DataItemPost => ({
    dataCaches: ['https://turbo-gateway.com'],
    deadlineHeight: 1_000_000,
    fastFinalityIndexes: ['https://turbo-gateway.com'],
    id,
    owner: 'mock-owner-address',
    public: 'mock-public-key',
    signature: 'mock-signature',
    timestamp: Date.now(),
    version: '1.0.0',
  }),
}

/** Turbo upload service (upload.ardrive.io). */
export const turboUploadHandlers = [
  // Service info: the free item limit and the gateway, read before pricing.
  http.get('https://upload.ardrive.io/', async () =>
    HttpResponse.json({
      addresses: {
        arweave: '8wgRDgvYOrtSaWEIV21g0lTuWDUnTu4_iYj4hmA7PI0',
        ethereum: '0x8wgRDgvYOrtSaWEIV21g0lTuWDUnTu4_iYj4hmA7PI0',
        solana: '8wgRDgvYOrtSaWEIV21g0lTuWDUnTu4_iYj4hmA7PI0',
      },
      freeUploadLimitBytes: 107_520,
      gateway: 'https://turbo-gateway.com',
      version: '0.2.0',
    }),
  ),

  // A signed data item (POST /v1/tx/:token).
  http.post('https://upload.ardrive.io/v1/tx/:token', async () =>
    HttpResponse.json(mockTurboData.uploadResponse()),
  ),
]

/** Turbo payment service (payment.ardrive.io). */
export const turboPaymentHandlers = [
  http.get('https://payment.ardrive.io/v1/account/balance/:token', async () =>
    HttpResponse.json(mockTurboData.balanceResponse()),
  ),

  // The wallet's remaining free-tier bytes; null means unlimited.
  http.get('https://payment.ardrive.io/v1/account/free', async () =>
    HttpResponse.json({ bytesRemaining: null }),
  ),

  http.get('https://payment.ardrive.io/v1/price/bytes/:byteCount', async () =>
    HttpResponse.json(mockTurboData.priceResponse()),
  ),

  http.get('https://payment.ardrive.io/v1/price/:type/:amount', async () =>
    HttpResponse.json({
      actualPaymentAmount: 1000,
      adjustments: [],
      fees: [],
      quotedPaymentAmount: 1000,
      winc: mockTurboData.priceResponse().winc,
    }),
  ),

  // Submit a fund transaction (POST /v1/account/balance/:token): credited.
  http.post('https://payment.ardrive.io/v1/account/balance/:token', async ({ request }) => {
    const body = (await request.json()) as { tx_id: string }
    return HttpResponse.json({
      creditedTransaction: {
        block: 1_234_567,
        destinationAddress: 'mock-owner',
        destinationAddressType: 'arweave',
        transactionId: body.tx_id,
        transactionQuantity: '1000000000',
        winstonCreditAmount: '1000000000000',
      },
      message: 'Transaction credited',
    })
  }),
]

/** The GraphQL gateway `--incremental` reads past uploads from: none by default. */
export const gatewayHandlers = [
  http.post('https://turbo-gateway.com/graphql', async () =>
    HttpResponse.json({
      data: { transactions: { edges: [], pageInfo: { hasNextPage: false } } },
    }),
  ),
]

export const turboHandlers = [...turboUploadHandlers, ...turboPaymentHandlers, ...gatewayHandlers]

/**
 * A wallet whose balance cannot cover the upload.
 *
 * @param balanceWinc - Balance in winc.
 * @param costWinc - Price of each priced item in winc.
 */
export function mockInsufficientBalance(balanceWinc = '100', costWinc = '1000000') {
  return [
    http.get('https://payment.ardrive.io/v1/account/balance/:token', async () =>
      HttpResponse.json(mockTurboData.balanceResponse(balanceWinc)),
    ),
    http.get('https://payment.ardrive.io/v1/price/bytes/:byteCount', async () =>
      HttpResponse.json(mockTurboData.priceResponse(costWinc)),
    ),
  ]
}
