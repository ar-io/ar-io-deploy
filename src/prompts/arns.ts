import { confirm, input, select } from '@inquirer/prompts'

import { validateArnsName, validateTtl } from '../utils/validators.js'

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

export async function promptAdvancedOptions(): Promise<AdvancedOptions | null> {
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
  const wantsOnDemand = await confirm({
    default: false,
    message: 'Enable on-demand payment?',
  })

  let onDemand: string | undefined
  let maxTokenAmount: string | undefined

  if (wantsOnDemand) {
    onDemand = await select({
      choices: [
        { name: 'ARIO', value: 'ario' },
        { name: 'ETH (Base Network)', value: 'base-eth' },
      ],
      message: 'Select payment token:',
    })

    maxTokenAmount = await input({
      message: 'Enter maximum token amount:',
      validate(value: string) {
        const num = Number.parseFloat(value)
        if (Number.isNaN(num) || num <= 0) {
          return 'Please enter a valid positive number'
        }

        return true
      },
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
