import { DEVNET_PROGRAM_IDS } from '@ar.io/sdk'
import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'

import {
  clusterProgramIds,
  createSolanaArnsSigner,
  solanaDeployKeyFromFile,
} from '../../src/utils/solana.js'

// Deterministic ed25519 keypair (seed = 32 bytes of 0x07). The base58 secret
// and address were generated from that seed; see the assertion below.
const FIXTURE_SECRET_BASE58 =
  '99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3StnzFNUx8FKCPPPPpR479qsw5zv2WNBKmgiz7WqgAJfM'
const FIXTURE_ADDRESS = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'

describe('createSolanaArnsSigner', () => {
  it('derives the expected Solana address from a base58 secret key', async () => {
    const signer = await createSolanaArnsSigner(FIXTURE_SECRET_BASE58)
    expect(signer.address).toBe(FIXTURE_ADDRESS)
  })

  it('derives the same signer from an id.json wallet file', async () => {
    const idJson = JSON.stringify([...bs58.decode(FIXTURE_SECRET_BASE58)])
    const signer = await createSolanaArnsSigner(solanaDeployKeyFromFile(idJson))
    expect(signer.address).toBe(FIXTURE_ADDRESS)
  })
})

describe('clusterProgramIds', () => {
  it('returns no overrides for mainnet (uses SDK defaults)', () => {
    expect(clusterProgramIds('mainnet')).toEqual({})
  })

  it('returns the devnet program ids', () => {
    expect(clusterProgramIds('devnet')).toEqual({
      antProgramId: DEVNET_PROGRAM_IDS.ant,
      arnsProgramId: DEVNET_PROGRAM_IDS.arns,
      coreProgramId: DEVNET_PROGRAM_IDS.core,
      garProgramId: DEVNET_PROGRAM_IDS.gar,
    })
  })
})
