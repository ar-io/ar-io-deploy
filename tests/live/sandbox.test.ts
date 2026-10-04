import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { EthereumSigner } from '@ardrive/turbo-sdk'
import { beforeAll, describe, expect, it } from 'vitest'

import { ownerAddressFromPublicKey } from '../../src/utils/incremental.js'

/**
 * The built CLI against the real Turbo development sandbox, the sandbox
 * gateway and public Solana RPCs. Nothing is mocked: results are checked from
 * the outside, through the gateway. Run with `pnpm test:live`.
 *
 * Uploads stay within the sandbox's free limit and cost nothing, but they are
 * real and permanent, so every file here is small and throwaway. Keys are
 * generated per run and never leave the temp directory.
 */

const ROOT = process.cwd()
const SANDBOX_GATEWAY = 'https://ar-io.dev'
const SANDBOX_UPLOAD = 'https://upload.services.ar-io.dev'

let tmp: string
let keys: { arweave: string; eth: string; solana: string; solanaPublicKey: Uint8Array }

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-live-'))

  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 65_537 })
  const arweave = path.join(tmp, 'arweave.json')
  fs.writeFileSync(
    arweave,
    JSON.stringify({ kty: 'RSA', ...rsa.privateKey.export({ format: 'jwk' }) }),
  )

  const ed = crypto.generateKeyPairSync('ed25519')
  const seed = ed.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const solanaPublicKey = ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const solana = path.join(tmp, 'solana.json')
  // An id.json is a plain JSON array of the 64 secret-key bytes.
  fs.writeFileSync(solana, JSON.stringify([...seed, ...solanaPublicKey]))

  keys = { arweave, eth: `0x${crypto.randomBytes(32).toString('hex')}`, solana, solanaPublicKey }
})

/** A fresh working directory, so each run starts with no local cache. */
function workdir(): string {
  return fs.mkdtempSync(path.join(tmp, 'run-'))
}

/** A small site with a unique stamp, so its bytes have never been uploaded. */
function site(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'site-'))
  const stamp = crypto.randomUUID()
  const all = {
    '404.html': `<html><body>not found ${stamp}</body></html>`,
    'assets/app.css': `body{color:red} /* ${stamp} */`,
    'index.html': `<html><body>live ${stamp}</body></html>`,
    ...files,
  }
  for (const [name, body] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }

  return dir
}

interface CliRun {
  hosts: string[]
  output: string
  status: number | null
  txId?: string
}

/** Run the built CLI, recording every host it fetches from. */
function cli(args: string[], cwd: string): CliRun {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      path.join(ROOT, 'tests/live/fetch-log.mjs'),
      path.join(ROOT, 'bin/run.js'),
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', NO_COLOR: '1', NODE_ENV: 'production' },
      timeout: 300_000,
    },
  )
  // oclif wraps long messages over lines prefixed with ›; join them back.
  const output = `${result.stdout}${result.stderr}`.replaceAll(/\s*\n\s*›\s*/g, ' ')
  const hosts = [...output.matchAll(/^FETCH \S+ (https?:\/\/[^\s/]+)/gm)].map((m) => m[1])
  return {
    hosts: [...new Set(hosts)],
    output,
    status: result.status,
    txId: /^Tx ID: ([\w-]{43})$/m.exec(output)?.[1],
  }
}

async function gateway(
  id: string,
  route = '',
): Promise<{ body: Buffer; encoding: null | string; status: number; type: null | string }> {
  const response = await fetch(`${SANDBOX_GATEWAY}/${id}/${route}`, {
    headers: { 'Accept-Encoding': 'identity' },
  })
  return {
    body: Buffer.from(await response.arrayBuffer()),
    encoding: response.headers.get('content-encoding'),
    status: response.status,
    type: response.headers.get('content-type'),
  }
}

async function ownerOf(id: string): Promise<null | string> {
  const response = await fetch(`${SANDBOX_GATEWAY}/${id}`, { method: 'HEAD' })
  return response.headers.get('x-arweave-owner-address')
}

/** Wait until the gateway's GraphQL index holds every id. */
async function waitIndexed(ids: string[], timeoutMs = 10 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`${SANDBOX_GATEWAY}/graphql`, {
      body: JSON.stringify({
        query: 'query($ids:[ID!]){transactions(ids:$ids,first:100){edges{node{id}}}}',
        variables: { ids },
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    const edges = ((await response.json()) as { data?: { transactions?: { edges?: unknown[] } } })
      .data?.transactions?.edges
    if (edges?.length === ids.length) return
    await new Promise((resolve) => {
      setTimeout(resolve, 15_000)
    })
  }

  throw new Error(`gateway did not index ${ids.length} items in time`)
}

describe('uploads to the Turbo sandbox, checked through its gateway', () => {
  it('serves every file with its type, and the fallback for unknown routes', async () => {
    const dir = site()
    const run = cli(
      ['upload', '--dev', '--deploy-folder', dir, '--wallet', keys.arweave],
      workdir(),
    )

    expect(run.status, run.output).toBe(0)
    expect(run.hosts.every((host) => host.endsWith('.ar-io.dev'))).toBe(true)

    const index = await gateway(run.txId!)
    expect(index.status).toBe(200)
    expect(index.body.toString()).toBe(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'))

    const css = await gateway(run.txId!, 'assets/app.css')
    expect(css.type).toMatch(/^text\/css/)

    const unknown = await gateway(run.txId!, 'some/client/route')
    expect(unknown.body.toString()).toContain('not found')
  })

  it('reuses every cached file on a redeploy, uploading only a new manifest', () => {
    const dir = site()
    const cwd = workdir()
    const args = ['upload', '--dev', '--deploy-folder', dir, '--wallet', keys.arweave]

    expect(cli(args, cwd).status).toBe(0)
    const again = cli(args, cwd)

    expect(again.output).toMatch(/0 of 3 files to upload/)
    expect(fs.readdirSync(path.join(cwd, '.ario-deploy'))).toContain(
      'transaction-cache.upload.services.ar-io.dev.json',
    )
  })

  it('serves compressed uploads with Content-Encoding', async () => {
    const dir = site({ 'big.html': `<html>${'compressible text '.repeat(500)}</html>` })
    const run = cli(
      ['upload', '--dev', '--deploy-folder', dir, '--wallet', keys.arweave, '--compress', 'gzip'],
      workdir(),
    )
    expect(run.status, run.output).toBe(0)

    const page = await gateway(run.txId!, 'big.html')
    expect(page.encoding).toBe('gzip')
    // fetch decodes it; what matters is that the gateway labelled it.
    expect(page.body.toString()).toContain('compressible text')
  })
})

describe('every signer type signs a real upload', () => {
  it.each([
    ['ethereum', () => ['--private-key', keys.eth], () => new EthereumSigner(keys.eth).publicKey],
    ['solana', () => ['--wallet', keys.solana], () => keys.solanaPublicKey],
  ])('%s: owned at the address --incremental derives', async (sigType, keyArgs, publicKey) => {
    const file = path.join(site(), 'index.html')
    const run = cli(
      [
        'upload',
        '--dev',
        '--deploy-file',
        file,
        '--sig-type',
        sigType,
        '--no-dedupe',
        ...keyArgs(),
      ],
      workdir(),
    )
    expect(run.status, run.output).toBe(0)

    expect(await ownerOf(run.txId!)).toBe(ownerAddressFromPublicKey(Buffer.from(publicKey())))
  })
})

describe('paying', () => {
  it('refuses, before uploading, a file the wallet cannot pay for', () => {
    // Over the sandbox's 5 MiB free limit, from a wallet with no credits.
    const big = path.join(tmp, 'big.bin')
    fs.writeFileSync(big, crypto.randomBytes(6 * 1024 * 1024))

    const run = cli(
      [
        'upload',
        '--dev',
        '--deploy-file',
        big,
        '--sig-type',
        'ethereum',
        '--private-key',
        keys.eth,
      ],
      workdir(),
    )

    expect(run.status).not.toBe(0)
    expect(run.output).toMatch(
      /Insufficient Turbo credits.*Required: [1-9]\d* winc, available: 0 winc/s,
    )
    expect(run.output).not.toMatch(/uploaded/i)
  })

  it('asks the sandbox payment service when only --uploader names the sandbox', () => {
    const big = path.join(tmp, 'big.bin')
    const run = cli(
      [
        'upload',
        '--uploader',
        SANDBOX_UPLOAD,
        '--deploy-file',
        big,
        '--sig-type',
        'ethereum',
        '--private-key',
        keys.eth,
      ],
      workdir(),
    )

    expect(run.hosts.sort()).toEqual(['https://payment.services.ar-io.dev', SANDBOX_UPLOAD])
  })
})

describe('--incremental', () => {
  it('recovers every file from the chain on a machine with no cache, and only for its own wallet', async () => {
    const dir = site({ 'js/a.js': `console.log(${Date.now()})` })
    const args = ['--deploy-folder', dir, '--incremental', '--incremental-gateway', SANDBOX_GATEWAY]

    const first = cli(['upload', '--dev', '--wallet', keys.arweave, ...args], workdir())
    expect(first.status, first.output).toBe(0)
    const raw = await fetch(`${SANDBOX_GATEWAY}/raw/${first.txId}`)
    const manifest = (await raw.json()) as { paths: Record<string, { id: string }> }
    await waitIndexed([...new Set(Object.values(manifest.paths).map((entry) => entry.id))])

    const fresh = cli(['upload', '--dev', '--wallet', keys.arweave, ...args], workdir())
    expect(fresh.output).toMatch(/0 of 4 files to upload .*4 cached \(4 found on chain\)/)

    // Another wallet must not trust these uploads as its own.
    const other = cli(
      ['upload', '--dev', '--sig-type', 'ethereum', '--private-key', keys.eth, ...args],
      workdir(),
    )
    expect(other.output).toMatch(/4 of 4 files to upload .*0 found on chain/)
  })
})

describe('ArNS, against real Solana RPCs', () => {
  it.each(['devnet', 'mainnet'])(
    'refuses a name that does not exist on %s before uploading',
    (cluster) => {
      const run = cli(
        [
          'deploy',
          '--dev',
          '--deploy-folder',
          site(),
          '--wallet',
          keys.arweave,
          '--arns-name',
          `no-such-name-${crypto.randomBytes(6).toString('hex')}`,
          '--arns-wallet',
          keys.solana,
          '--cluster',
          cluster,
        ],
        workdir(),
      )

      expect(run.output).toMatch(new RegExp(`does not exist on ${cluster}`))
      expect(run.hosts).not.toContain(SANDBOX_UPLOAD)
    },
  )
})
