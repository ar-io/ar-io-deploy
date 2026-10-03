import crypto from 'node:crypto'

import { captureOutput } from '@oclif/test'
import bs58 from 'bs58'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import Deploy from '../../src/commands/deploy.js'
import { server } from '../setup.js'

/**
 * The ArNS update runs after an upload that has already been paid for, so
 * everything about it that can be checked first must be. These drive the
 * `deploy` command with the ArNS SDK replaced and Turbo mocked over
 * HTTP, counting what was uploaded.
 */

const sdk = vi.hoisted(() => ({
  getArNSRecord: vi.fn(),
  getControllers: vi.fn(),
  getOwner: vi.fn(),
  setBaseNameRecord: vi.fn(),
}))

vi.mock('@ar.io/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ar.io/sdk')>()),
  ARIO: { init: () => ({ getArNSRecord: sdk.getArNSRecord }) },
  SolanaANTReadable: class {
    getControllers = sdk.getControllers
    getOwner = sdk.getOwner
  },
  SolanaANTWriteable: class {
    setBaseNameRecord = sdk.setBaseNameRecord
    setUndernameRecord = sdk.setBaseNameRecord
  },
}))

/** A real ed25519 key pair as a base58 Solana secret key, and its address. */
function solanaKey(): { address: string; secret: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return { address: bs58.encode(pub), secret: bs58.encode(Buffer.concat([seed, pub])) }
}

let uploads = 0
/** The last id the bundler issued: the manifest's, since it uploads last. */
let lastId = ''
const PROCESS_ID = 'xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10'

beforeEach(() => {
  uploads = 0
  vi.clearAllMocks()
  sdk.getArNSRecord.mockResolvedValue({ processId: PROCESS_ID })
  sdk.getControllers.mockResolvedValue([])
  sdk.setBaseNameRecord.mockResolvedValue({ id: 'ok' })
  server.use(
    http.post('https://upload.ardrive.io/v1/tx/:token', () => {
      uploads += 1
      lastId = `tx${String(uploads).padStart(41, '0')}`
      return HttpResponse.json({ id: lastId, owner: 'o' })
    }),
  )
})

/**
 * Run the command from source, where the SDK mock applies; the built CLI that
 * `runCommand` loads imports the real SDK.
 */
function deploy(arnsKey: string, extra: string[] = []) {
  return captureOutput(() =>
    Deploy.run(
      [
        '--deploy-folder',
        './tests/fixtures/test-app',
        '--wallet',
        './tests/fixtures/test_wallet.json',
        '--no-dedupe',
        '--arns-name',
        'myapp',
        '--arns-private-key',
        arnsKey,
        ...extra,
      ],
      import.meta.url,
    ),
  )
}

describe('the ArNS update is checked before the upload is paid for', () => {
  it('refuses a malformed ArNS key without uploading', async () => {
    const { error } = await deploy('[1,2,3]')

    expect(error?.message).toMatch(/64-byte/)
    expect(uploads).toBe(0)
  })

  it('refuses a name that does not exist without uploading', async () => {
    sdk.getArNSRecord.mockRejectedValue(new Error('ArNS record not found: myapp'))

    const { error } = await deploy(solanaKey().secret)

    expect(error?.message).toMatch(/ArNS name \[myapp] does not exist on mainnet/)
    expect(uploads).toBe(0)
  })

  it('reports an RPC failure as an RPC failure, not a missing name', async () => {
    sdk.getArNSRecord.mockRejectedValue(new Error('429 Too Many Requests'))

    const { error } = await deploy(solanaKey().secret)

    expect(error?.message).toMatch(/Could not fetch the ArNS record .*429/)
    expect(uploads).toBe(0)
  })

  it('refuses an undername the ANT program would reject, without uploading', async () => {
    const { error } = await deploy(solanaKey().secret, ['--undername', '-bad name'])

    expect(error?.message).toMatch(/Undername must be @/)
    expect(uploads).toBe(0)
  })
})

describe('who controls the name', () => {
  it('refuses a key that neither owns nor controls the name, before uploading', async () => {
    const key = solanaKey()
    sdk.getOwner.mockResolvedValue(solanaKey().address)

    const { error } = await deploy(key.secret)

    expect(error?.message).toContain(`The ArNS key ${key.address} is neither the owner`)
    expect(error?.message).toContain('Nothing was uploaded')
    expect(uploads).toBe(0)
    expect(sdk.setBaseNameRecord).not.toHaveBeenCalled()
  })

  it('accepts a controller that is not the owner', async () => {
    const key = solanaKey()
    sdk.getOwner.mockResolvedValue(solanaKey().address)
    sdk.getControllers.mockResolvedValue([key.address])

    const { error } = await deploy(key.secret)

    expect(error).toBeUndefined()
    expect(sdk.setBaseNameRecord).toHaveBeenCalled()
  })

  it('goes ahead with --skip-arns-check, for a name that changed hands very recently', async () => {
    sdk.getOwner.mockResolvedValue(solanaKey().address)

    const { error } = await deploy(solanaKey().secret, ['--skip-arns-check'])

    expect(error).toBeUndefined()
    expect(uploads).toBeGreaterThan(0)
    expect(sdk.setBaseNameRecord).toHaveBeenCalled()
  })

  it('does not refuse when the ANT cannot be read, leaving the update as the check', async () => {
    sdk.getOwner.mockRejectedValue(new Error('429 Too Many Requests'))

    const { error } = await deploy(solanaKey().secret)

    expect(error).toBeUndefined()
    expect(sdk.setBaseNameRecord).toHaveBeenCalled()
  })
})

describe('after the upload', () => {
  it('points the record at the manifest', async () => {
    const key = solanaKey()
    sdk.getOwner.mockResolvedValue(key.address)

    const { error } = await deploy(key.secret)

    expect(error).toBeUndefined()
    expect(sdk.setBaseNameRecord).toHaveBeenCalledWith({ transactionId: lastId, ttlSeconds: 60 })
  })

  it('keeps the transaction id in front of the user when the record update fails', async () => {
    const key = solanaKey()
    sdk.getOwner.mockResolvedValue(key.address)
    sdk.setBaseNameRecord.mockRejectedValue(new Error('custom program error: 0x1771'))

    const { error } = await deploy(key.secret)

    expect(uploads).toBeGreaterThan(0)
    expect(error?.message).toContain(
      `The upload succeeded (Tx ID ${lastId}) but the ArNS update failed`,
    )
  })
})
