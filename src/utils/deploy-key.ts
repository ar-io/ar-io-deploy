import { solanaDeployKeyFromFile, solanaDeployKeyFromString } from './solana.js'

/**
 * Encode the contents of a wallet file into the deploy-key string used
 * throughout the CLI, based on the signer type:
 * - arweave: base64-encoded JWK JSON
 * - solana: base58 secret key derived from a solana-keygen id.json byte array
 * - ethereum/polygon/kyve: trimmed hex private key
 */
export function deployKeyFromWalletFile(sigType: string, content: string): string {
  if (sigType === 'arweave') {
    return Buffer.from(content).toString('base64')
  }

  if (sigType === 'solana') {
    return solanaDeployKeyFromFile(content)
  }

  return content.trim()
}

/**
 * Encode a private-key string into the deploy-key string used throughout the
 * CLI, based on the signer type (see {@link deployKeyFromWalletFile}). For
 * Solana this is a base58-encoded secret key.
 */
export function deployKeyFromPrivateKey(sigType: string, privateKey: string): string {
  if (sigType === 'arweave') {
    return Buffer.from(privateKey).toString('base64')
  }

  if (sigType === 'solana') {
    return solanaDeployKeyFromString(privateKey)
  }

  return privateKey.trim()
}
