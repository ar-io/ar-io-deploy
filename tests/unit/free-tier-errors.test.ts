import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { SANDBOX_WARNING, uploadResultRows } from '../../src/utils/command-helpers.js'
import { explainPaymentRequired } from '../../src/utils/display.js'
import { runUploadWorkflow } from '../../src/workflows/upload-workflow.js'
import { TEST_ARWEAVE_WALLET } from '../constants.js'
import { server } from '../setup.js'

/**
 * The free tier is metered per wallet and per IP range, and only the wallet
 * can be asked before uploading. These pin what the user is told when the
 * upload service says no, and when a run was only a sandbox test.
 */

const ARWEAVE_KEY = Buffer.from(JSON.stringify(TEST_ARWEAVE_WALLET)).toString('base64')
const UPLOAD = 'https://upload.ardrive.io'
const SANDBOX_UPLOAD = 'https://upload.services.ar-io.dev'

const X402_BODY = JSON.stringify({
  accepts: [{ asset: 'USDC', maxAmountRequired: '1000', network: 'base', scheme: 'exact' }],
  error: 'Payment required',
  x402Version: 1,
})

const FALLBACK_BODY = JSON.stringify({
  byteCount: 4096,
  code: 'FREE_TIER_EXHAUSTED',
  error: 'Payment required',
  message: 'Free tier used up',
  topUpUrl: 'https://app.ardrive.io/#/topup',
})

describe('explainPaymentRequired', () => {
  const context = { freeLimitBytes: 107_520, uploadUrl: UPLOAD }

  it('replaces the x402 dump with the free-tier limits and the ways forward', () => {
    const text = explainPaymentRequired(`Failed request (Status 402): ${X402_BODY}`, context)

    expect(text).toMatch(/refused the upload as unpaid/)
    expect(text).toContain('105 KiB per file')
    expect(text).toContain('10 MiB per wallet and per IP range')
    expect(text).toContain('--on-demand')
    expect(text).toContain('credits shared to this wallet')
    expect(text).toContain(`HTTP 402 from ${UPLOAD}`)
    expect(text).not.toContain('x402Version')
    expect(text).not.toContain('accepts')
  })

  it('recognises the fallback body and passes its top-up link on', () => {
    const text = explainPaymentRequired(`Failed request: ${FALLBACK_BODY}`, context)

    expect(text).toContain('https://app.ardrive.io/#/topup')
    expect(text).not.toContain('FREE_TIER_EXHAUSTED')
  })

  it('reads the per-file limit it is given', () => {
    const text = explainPaymentRequired('Failed request (Status 402): x', {
      ...context,
      freeLimitBytes: 5 * 1024 * 1024,
    })
    expect(text).toContain('5120 KiB per file')
  })

  it('leaves other failures alone', () => {
    expect(explainPaymentRequired('Failed request (Status 500): boom', context)).toBeUndefined()
    expect(explainPaymentRequired('Failed request (Status 4020): boom', context)).toBeUndefined()
  })
})

const upload = (host: string, answer: () => Response) => {
  server.use(
    http.get(`${host}/`, () => HttpResponse.json({ freeUploadLimitBytes: 107_520 })),
    http.post(`${host}/v1/tx/:token`, answer),
  )
}

describe('upload workflow messages', () => {
  let workdir: string
  let cwdSpy: ReturnType<typeof vi.spyOn>
  let stderr: MockInstance<typeof process.stderr.write>
  const io = {
    error(message: string): never {
      throw new Error(message)
    },
  }

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-free-'))
    fs.writeFileSync(path.join(workdir, 'index.html'), '<html>hello</html>')
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workdir)
    stderr = vi.spyOn(process.stderr, 'write')
  })

  afterEach(() => {
    cwdSpy.mockRestore()
    stderr.mockRestore()
    fs.rmSync(workdir, { force: true, recursive: true })
  })

  const config = (overrides: Record<string, unknown> = {}) => ({
    'dedupe-cache-max-entries': 0,
    'deploy-folder': workdir,
    'sig-type': 'arweave',
    ...overrides,
  })

  it('turns a 402 from the upload service into a plain message', async () => {
    upload(UPLOAD, () => new HttpResponse(X402_BODY, { status: 402 }))

    const failure = await runUploadWorkflow(ARWEAVE_KEY, config(), io).catch((error) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toMatch(/^Upload failed: Turbo refused the upload as unpaid/)
    expect(failure.message).toContain('105 KiB per file')
    expect(failure.message).not.toContain('x402Version')
  })

  it('says the credit check covers this wallet, and that the IP range is checked later', async () => {
    upload(UPLOAD, () => HttpResponse.json({ id: 'a'.repeat(43), owner: 'o' }))

    await runUploadWorkflow(ARWEAVE_KEY, config(), io)

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(output).toContain("within this wallet's free tier")
    expect(output).toContain('per IP range, checked at upload time')
  })

  it('marks a sandbox result, and only a sandbox result', async () => {
    upload(SANDBOX_UPLOAD, () => HttpResponse.json({ id: 'b'.repeat(43), owner: 'o' }))
    const sandbox = await runUploadWorkflow(ARWEAVE_KEY, config({ dev: true }), io)
    expect(sandbox.development).toBe(true)

    upload(UPLOAD, () => HttpResponse.json({ id: 'c'.repeat(43), owner: 'o' }))
    const production = await runUploadWorkflow(ARWEAVE_KEY, config(), io)
    expect(production.development).toBe(false)
  })
})

describe('uploadResultRows', () => {
  const result = { gatewayUrl: 'https://gateway.example', transactionId: 'a'.repeat(43) }

  it('warns loudly that a sandbox upload is not permanent', () => {
    const rows = uploadResultRows({ ...result, development: true }, {})
    const warning = rows.find(([label]) => label === 'Warning')?.[1] ?? ''

    expect(warning).toContain(SANDBOX_WARNING)
    expect(SANDBOX_WARNING).toMatch(/Turbo sandbox for testing/)
    expect(SANDBOX_WARNING).toMatch(/not permanent/)
    expect(SANDBOX_WARNING).toMatch(/production gateways do not serve it/)
    expect(rows[0][0]).toBe('Tx ID')
  })

  it('adds no warning to a production result', () => {
    const rows = uploadResultRows({ ...result, development: false }, {})
    expect(rows.some(([label]) => label === 'Warning')).toBe(false)
  })
})
