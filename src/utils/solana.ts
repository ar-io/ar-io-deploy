import { DEVNET_PROGRAM_IDS, DEVNET_RPC_URL, MAINNET_RPC_URL } from '@ar.io/sdk'
import {
  type Address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  type KeyPairSigner,
} from '@solana/kit'
import bs58 from 'bs58'

type ClusterProgramIds = Partial<
  Record<'antProgramId' | 'arnsProgramId' | 'coreProgramId' | 'garProgramId', Address>
>

export type SolanaCluster = 'devnet' | 'mainnet'

/**
 * Normalize a Solana private key provided as a string. Accepts either a base58
 * encoded 64-byte secret key (the format wallets like Phantom export) or a
 * JSON array of bytes (solana-keygen id.json format).
 */
export function solanaDeployKeyFromString(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('[')) {
    return solanaDeployKeyFromFile(trimmed)
  }

  return trimmed
}

/**
 * Convert a `solana-keygen` JSON wallet (a JSON array of 64 bytes, e.g.
 * ~/.config/solana/id.json) into the base58 secret-key string used as the
 * deploy key throughout the CLI.
 */
export function solanaDeployKeyFromFile(content: string): string {
  let bytes: number[]
  try {
    bytes = JSON.parse(content) as number[]
  } catch {
    throw new Error('Invalid Solana wallet file: expected a JSON array of bytes (id.json format)')
  }

  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(
      'Invalid Solana wallet file: expected a 64-byte secret key array (id.json format)',
    )
  }

  return bs58.encode(Uint8Array.from(bytes))
}

/**
 * Build a Solana `TransactionSigner` from the base58 deploy key, used to sign
 * ArNS/ANT program transactions.
 */
export function createSolanaArnsSigner(deployKey: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(bs58.decode(deployKey))
}

function clusterHttpUrl(cluster: SolanaCluster, rpcUrl?: string): string {
  if (rpcUrl) {
    return rpcUrl
  }

  return cluster === 'devnet' ? DEVNET_RPC_URL : MAINNET_RPC_URL
}

function toWebSocketUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws')
}

export function createArioRpc(cluster: SolanaCluster, rpcUrl?: string) {
  return createSolanaRpc(clusterHttpUrl(cluster, rpcUrl))
}

export function createArioRpcSubscriptions(cluster: SolanaCluster, rpcUrl?: string) {
  return createSolanaRpcSubscriptions(toWebSocketUrl(clusterHttpUrl(cluster, rpcUrl)))
}

/**
 * Program-id overrides to pass to `ARIO.init` / `SolanaANTWriteable`. Mainnet
 * uses the SDK defaults (empty object); devnet must pass explicit ids.
 */
export function clusterProgramIds(cluster: SolanaCluster): ClusterProgramIds {
  if (cluster !== 'devnet') {
    return {}
  }

  return {
    antProgramId: DEVNET_PROGRAM_IDS.ant,
    arnsProgramId: DEVNET_PROGRAM_IDS.arns,
    coreProgramId: DEVNET_PROGRAM_IDS.core,
    garProgramId: DEVNET_PROGRAM_IDS.gar,
  }
}
