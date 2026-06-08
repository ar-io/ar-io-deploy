import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'

import { deployKeyFromPrivateKey, deployKeyFromWalletFile } from '../../src/utils/deploy-key.js'

describe('deployKeyFromWalletFile', () => {
  it('base64-encodes an Arweave JWK file', () => {
    const jwk = '{"kty":"RSA","n":"abc"}'
    expect(deployKeyFromWalletFile('arweave', jwk)).toBe(Buffer.from(jwk).toString('base64'))
  })

  it('converts a Solana id.json byte array to a base58 secret key', () => {
    const bytes = Array.from({ length: 64 }, (_, i) => i)
    const content = JSON.stringify(bytes)
    expect(deployKeyFromWalletFile('solana', content)).toBe(bs58.encode(Uint8Array.from(bytes)))
  })

  it('rejects a malformed Solana wallet file', () => {
    expect(() => deployKeyFromWalletFile('solana', '[1,2,3]')).toThrow(/64-byte/)
  })

  it('trims raw private keys for EVM-style chains', () => {
    expect(deployKeyFromWalletFile('ethereum', '  0xabc123  \n')).toBe('0xabc123')
    expect(deployKeyFromWalletFile('polygon', ' deadbeef ')).toBe('deadbeef')
    expect(deployKeyFromWalletFile('kyve', ' key ')).toBe('key')
  })
})

describe('deployKeyFromPrivateKey', () => {
  it('base64-encodes an Arweave JWK string', () => {
    const jwk = '{"kty":"RSA","n":"xyz"}'
    expect(deployKeyFromPrivateKey('arweave', jwk)).toBe(Buffer.from(jwk).toString('base64'))
  })

  it('trims a Solana base58 secret key', () => {
    expect(deployKeyFromPrivateKey('solana', '  base58key  ')).toBe('base58key')
  })

  it('trims raw private keys for EVM-style chains', () => {
    expect(deployKeyFromPrivateKey('ethereum', '  0xabc123  ')).toBe('0xabc123')
  })
})
