import { input, select } from '@inquirer/prompts'

import { validateFileExists } from '../utils/validators.js'

export interface WalletConfig {
  method: 'env' | 'file' | 'string'
  privateKey?: string
  wallet?: string
}

/**
 * Describes which key is being collected so prompts can be explicit about
 * purpose (e.g. the upload key that pays for the upload vs. the ArNS authority
 * key that signs the record update).
 */
export interface KeyPromptOptions {
  /** Short name for the key, e.g. 'upload key' or 'ArNS authority key' */
  label: string
  /** What the key is used for, e.g. 'pays for the upload' */
  purpose: string
  /** Environment variable that can supply this key, e.g. 'DEPLOY_KEY' */
  envVar: string
  /** Default path shown in the file prompt */
  fileDefault?: string
}

export async function promptWalletMethod(opts: KeyPromptOptions): Promise<string> {
  return select({
    choices: [
      { name: `${capitalize(opts.label)} file path`, value: 'file' },
      { name: `${capitalize(opts.label)} private key/JWK string`, value: 'string' },
      { name: `Environment variable (${opts.envVar})`, value: 'env' },
    ],
    message: `How do you want to provide your ${opts.label} (${opts.purpose})?`,
  })
}

export async function promptWalletFile(opts: KeyPromptOptions): Promise<string> {
  return input({
    default: opts.fileDefault ?? './wallet.json',
    message: `Enter ${opts.label} file path:`,
    validate: validateFileExists,
  })
}

export async function promptPrivateKey(opts: KeyPromptOptions): Promise<string> {
  return input({
    message: `Enter your ${opts.label} (private key or JWK JSON):`,
    required: true,
  })
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export async function promptSignerType(): Promise<string> {
  return select({
    choices: [
      { name: 'Arweave', value: 'arweave' },
      { name: 'Ethereum', value: 'ethereum' },
      { name: 'Polygon', value: 'polygon' },
      { name: 'KYVE', value: 'kyve' },
      { name: 'Solana', value: 'solana' },
    ],
    default: 'arweave',
    message: 'Select signer type:',
  })
}

export async function getWalletConfig(opts: KeyPromptOptions): Promise<WalletConfig> {
  const method = (await promptWalletMethod(opts)) as 'env' | 'file' | 'string'

  const config: WalletConfig = { method }

  if (method === 'file') {
    config.wallet = await promptWalletFile(opts)
  } else if (method === 'string') {
    config.privateKey = await promptPrivateKey(opts)
  }

  return config
}
