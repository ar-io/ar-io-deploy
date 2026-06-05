import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'

import { createSigner } from '../../src/utils/signer.js'
import { solanaDeployKeyFromFile, solanaDeployKeyFromString } from '../../src/utils/solana.js'

const TEST_ETH_PRIVATE_KEY = '0x'.padEnd(66, '1')

describe('createSigner', () => {
  it('creates a solana signer with the solana token', () => {
    const secret = bs58.encode(Buffer.alloc(64, 1))
    const { signer, token } = createSigner('solana', secret)

    expect(token).toBe('solana')
    expect(signer).toBeDefined()
  })

  it('creates an ethereum signer with the ethereum token', () => {
    const { token } = createSigner('ethereum', TEST_ETH_PRIVATE_KEY)
    expect(token).toBe('ethereum')
  })

  it('throws on an unknown signer type', () => {
    // @ts-expect-error - intentionally invalid sig type
    expect(() => createSigner('dogecoin', 'key')).toThrow(/Invalid sig-type/)
  })
})

describe('solana deploy key parsing', () => {
  it('converts an id.json byte array to a base58 secret key', () => {
    const bytes = Array.from({ length: 64 }, (_, i) => i)
    const key = solanaDeployKeyFromFile(JSON.stringify(bytes))

    expect(key).toBe(bs58.encode(Uint8Array.from(bytes)))
  })

  it('rejects malformed solana wallet files', () => {
    expect(() => solanaDeployKeyFromFile('not json')).toThrow(/Invalid Solana wallet/)
    expect(() => solanaDeployKeyFromFile('[1, 2, 3]')).toThrow(/64-byte/)
  })

  it('trims a base58 private key string', () => {
    expect(solanaDeployKeyFromString('  abc123  ')).toBe('abc123')
  })
})
