import { confirm, input, select } from '@inquirer/prompts'

import type { SignerType } from '../types/index.js'
import { ON_DEMAND_TOKENS, type OnDemandToken } from '../utils/turbo.js'
import {
  validateArnsName,
  validateTokenAmount,
  validateTtl,
  validateUndername,
} from '../utils/validators.js'

const ON_DEMAND_TOKEN_LABELS: Record<OnDemandToken, string> = {
  ario: 'ARIO (Solana)',
  'base-eth': 'ETH (Base)',
  'base-usdc': 'USDC (Base)',
  solana: 'SOL',
  'solana-usdc': 'USDC (Solana)',
}

export interface AdvancedOptions {
  cluster: string
  maxTokenAmount?: string
  onDemand?: string
  ttlSeconds: string
  undername: string
}

export async function promptUpdateArns(): Promise<boolean> {
  return confirm({
    default: true,
    message: 'Update an ArNS name after upload?',
  })
}

export async function promptArnsName(): Promise<string> {
  return input({
    message: 'Enter your ArNS name:',
    required: true,
    validate: validateArnsName,
  })
}

export async function promptUndername(): Promise<string> {
  return input({
    default: '@',
    message: 'Enter undername (subdomain):',
    validate: validateUndername,
  })
}

export async function promptTtl(): Promise<string> {
  return input({
    default: '60',
    message: 'Enter TTL in seconds:',
    validate: validateTtl,
  })
}

export async function promptCluster(): Promise<string> {
  return select({
    choices: [
      { name: 'Mainnet', value: 'mainnet' },
      { name: 'Devnet', value: 'devnet' },
    ],
    default: 'mainnet',
    message: 'Select Solana cluster:',
  })
}

export async function promptAdvancedOptions(sigType: string): Promise<AdvancedOptions | null> {
  const wantsAdvanced = await confirm({
    default: false,
    message: 'Configure advanced options?',
  })

  if (!wantsAdvanced) {
    return null
  }

  const undername = await promptUndername()
  const ttlSeconds = await promptTtl()
  const cluster = await promptCluster()

  // On-demand payment options
  // Only offer tokens the upload key can pay with; an Arweave key has none.
  const tokens: readonly OnDemandToken[] = ON_DEMAND_TOKENS[sigType as SignerType] ?? []
  const wantsOnDemand =
    tokens.length > 0 &&
    (await confirm({
      default: false,
      message: 'Enable on-demand payment?',
    }))

  let onDemand: string | undefined
  let maxTokenAmount: string | undefined

  if (wantsOnDemand) {
    onDemand = await select({
      choices: tokens.map((token) => ({ name: ON_DEMAND_TOKEN_LABELS[token], value: token })),
      message: 'Select payment token:',
    })

    maxTokenAmount = await input({
      message: 'Maximum the top-up may spend, in whole tokens:',
      validate: validateTokenAmount,
    })
  }

  return {
    cluster,
    maxTokenAmount,
    onDemand,
    ttlSeconds,
    undername,
  }
}
