import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SolanaANTReadable } from '@ar.io/sdk'
import {
  developmentTurboConfiguration as sandbox,
  EthereumSigner,
  HexSolanaSigner,
  SolanaToken,
  TurboFactory,
} from '@ardrive/turbo-sdk'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  clusterProgramIds,
  createArioRpc,
  createSolanaArnsSigner,
  solanaDeployKeyFromFile,
} from '../../src/utils/solana.js'

/**
 * Live tests that spend devnet tokens: on-demand top-ups, shared credits and
 * ArNS updates, against the Turbo sandbox and Solana devnet. They run only
 * when given a funded devnet wallet and a devnet ArNS name it controls:
 *
 *   ARIO_DEPLOY_LIVE_SOLANA_WALLET=./devnet-id.json  (devnet SOL, a little ARIO)
 *   ARIO_DEPLOY_LIVE_ARNS_NAME=my-devnet-test-name    (controlled by that wallet)
 *
 * A run spends about 0.005 devnet SOL per top-up and nothing else of note.
 */

const WALLET = process.env.ARIO_DEPLOY_LIVE_SOLANA_WALLET
const ARNS_NAME = process.env.ARIO_DEPLOY_LIVE_ARNS_NAME
const ROOT = process.cwd()

let tmp: string
let walletKey: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-live-funded-'))
  if (WALLET) walletKey = solanaDeployKeyFromFile(fs.readFileSync(WALLET, 'utf8'))
})

function cli(args: string[]): { output: string; status: null | number; txId?: string } {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/run.js'), ...args], {
    cwd: fs.mkdtempSync(path.join(tmp, 'run-')),
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', NO_COLOR: '1', NODE_ENV: 'production' },
    timeout: 600_000,
  })
  const output = `${result.stdout}${result.stderr}`.replaceAll(/\s*\n\s*›\s*/g, ' ')
  return { output, status: result.status, txId: /^Tx ID: ([\w-]{43})$/m.exec(output)?.[1] }
}

/** A file over the sandbox's 5 MiB free limit, never uploaded before. */
function paidFile(): string {
  const file = path.join(tmp, `${crypto.randomUUID()}.bin`)
  fs.writeFileSync(file, crypto.randomBytes(5_400_000))
  return file
}

const DEVNET_RPC = 'https://api.devnet.solana.com'

/** The funded wallet as a Turbo client on the sandbox, paying in devnet SOL. */
function fundedTurbo() {
  return TurboFactory.authenticated({
    ...sandbox,
    gatewayUrl: DEVNET_RPC,
    signer: new HexSolanaSigner(walletKey),
    token: 'solana',
  })
}

/** A Solana key pair as an id.json file. */
function newSolanaWallet(): string {
  const pair = crypto.generateKeyPairSync('ed25519')
  const seed = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const pub = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const file = path.join(tmp, `${crypto.randomUUID()}.json`)
  fs.writeFileSync(file, JSON.stringify([...seed, ...pub]))
  return file
}

async function addressOf(walletFile: string): Promise<string> {
  return (
    await createSolanaArnsSigner(solanaDeployKeyFromFile(fs.readFileSync(walletFile, 'utf8')))
  ).address
}

/**
 * A wallet that holds devnet SOL but no Turbo credits, so an upload that
 * costs anything is guaranteed a shortfall. The funded wallet may have credits
 * left from earlier runs, which would let a top-up test pass without topping up.
 */
async function walletWithSolOnly(lamports: number): Promise<string> {
  const file = newSolanaWallet()
  const tool = new SolanaToken({ gatewayUrl: DEVNET_RPC })
  // tokenAmount is typed as a BigNumber, which the SDK does not export; it
  // converts whatever it is given with `new BigNumber(...)`.
  const { id } = await tool.createAndSubmitTx({
    feeMultiplier: 1,
    signer: fundedTurbo().signer,
    target: await addressOf(file),
    tokenAmount: lamports,
  } as unknown as Parameters<SolanaToken['createAndSubmitTx']>[0])
  await tool.pollTxAvailability({ txId: id })
  return file
}

function tinySite(): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'site-'))
  fs.writeFileSync(path.join(dir, 'index.html'), `<html>${crypto.randomUUID()}</html>`)
  return dir
}

describe.skipIf(!WALLET)('on-demand funding, paid in devnet SOL', () => {
  it('refuses, before paying, a top-up larger than the cap', () => {
    // A key with no SOL and no credits: any spend at all would fail loudly.
    const run = cli([
      'upload',
      '--dev',
      '--deploy-file',
      paidFile(),
      '--sig-type',
      'solana',
      '--wallet',
      newSolanaWallet(),
      '--on-demand',
      'solana',
      '--max-token-amount',
      '0.000000001',
    ])

    expect(run.status).not.toBe(0)
    expect(run.output).toMatch(/more than --max-token-amount/)
  })

  it('tops up once and uploads when the balance falls short', async () => {
    const wallet = await walletWithSolOnly(20_000_000) // 0.02 devnet SOL, no credits
    const run = cli([
      'upload',
      '--dev',
      '--deploy-file',
      paidFile(),
      '--sig-type',
      'solana',
      '--wallet',
      wallet,
      '--on-demand',
      'solana',
      '--max-token-amount',
      '0.05',
    ])

    expect(run.status, run.output).toBe(0)
    expect(run.output.match(/Topped up with/g)).toHaveLength(1)
    expect(run.txId).toBeDefined()
  })
})

describe.skipIf(!WALLET)('shared credits', () => {
  it('pays from credits another wallet shared, and only when the payer is named', async () => {
    // A fresh wallet with nothing of its own, given credits by the funded one.
    const ethKey = `0x${crypto.randomBytes(32).toString('hex')}`
    const recipient = await TurboFactory.authenticated({
      ...sandbox,
      signer: new EthereumSigner(ethKey),
      token: 'ethereum',
    }).signer.getNativeAddress()
    const sharer = fundedTurbo()
    const needed = 150_000_000_000n
    if (BigInt((await sharer.getBalance()).winc) < needed) {
      await sharer.topUpWithTokens({ tokenAmount: 20_000_000 })
    }

    await sharer.shareCredits({ approvedAddress: recipient, approvedWincAmount: needed.toString() })

    const args = [
      'upload',
      '--dev',
      '--deploy-file',
      paidFile(),
      '--sig-type',
      'ethereum',
      '--private-key',
      ethKey,
    ]
    expect(cli([...args, '--ignore-approvals']).output).toMatch(/Insufficient Turbo credits/)

    const shared = cli(args)
    expect(shared.status, shared.output).toBe(0)
    expect(shared.output).toMatch(/shared credits from/)
  })
})

async function onChainRecord(undername: string): Promise<string | undefined> {
  const { ARIO } = await import('@ar.io/sdk')
  const programIds = clusterProgramIds('devnet')
  const rpc = createArioRpc('devnet')
  const { processId } = await ARIO.init({ rpc, ...programIds }).getArNSRecord({
    name: ARNS_NAME!,
  })
  const ant = new SolanaANTReadable({ antProgramId: programIds.antProgramId, processId, rpc })
  return (await ant.getRecord({ undername }))?.transactionId
}

describe.skipIf(!WALLET || !ARNS_NAME)('ArNS updates on devnet', () => {
  it.each(['@', 'live-test'])(
    'points the %s record at the deployed manifest',
    async (undername) => {
      const run = cli([
        'deploy',
        '--dev',
        '--cluster',
        'devnet',
        '--deploy-folder',
        tinySite(),
        '--wallet',
        WALLET!,
        '--sig-type',
        'solana',
        '--arns-name',
        ARNS_NAME!,
        '--arns-wallet',
        WALLET!,
        '--undername',
        undername,
      ])

      expect(run.status, run.output).toBe(0)
      expect(await onChainRecord(undername)).toBe(run.txId)
    },
  )

  it('refuses, before uploading, a key that does not control the name', async () => {
    const stranger = newSolanaWallet()
    const strangerAddress = await addressOf(stranger)
    const args = [
      'deploy',
      '--dev',
      '--cluster',
      'devnet',
      '--deploy-folder',
      tinySite(),
      '--wallet',
      WALLET!,
      '--sig-type',
      'solana',
      '--arns-name',
      ARNS_NAME!,
      '--arns-wallet',
      stranger,
      '--undername',
      'stranger',
    ]

    const refused = cli(args)
    expect(refused.status).not.toBe(0)
    expect(refused.output).toContain(`The ArNS key ${strangerAddress} is neither the owner`)
    expect(refused.txId).toBeUndefined()

    // Forced past the check, the program itself refuses, and the id survives.
    const forced = cli([...args, '--skip-arns-check'])
    expect(forced.status).not.toBe(0)
    expect(forced.output).toContain(`The upload succeeded (Tx ID ${forced.txId})`)
  })
})
