import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import bs58 from 'bs58'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  assertNoPrivateKeys,
  createKeyScanner,
  isSolanaKeypair,
  type KeyScanner,
} from '../../src/utils/key-scan.js'
import { generateSolanaWallet } from '../../src/utils/keygen.js'

/**
 * Regression cases from an adversarial review: every way it got a key into
 * the upload set. All keys are generated here; none is a real wallet.
 */

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-key-scan-'))
})

afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true })
})

const sol = generateSolanaWallet().idJson
const solBytes = Buffer.from(sol)
const solB58 = bs58.encode(solBytes)
const solHex = solBytes.toString('hex')
const arr = JSON.stringify(sol)
const jwkObject = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  format: 'jwk',
}) as Record<string, string>
const jwk = JSON.stringify(jwkObject)
/** A second key, held by nobody, for files that must pass. */
const otherJwk = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  format: 'jwk',
}) as Record<string, string>
const jwk64 = Buffer.from(jwk).toString('base64')
const evmHex = crypto.randomBytes(32).toString('hex')

async function refusal(
  files: Record<string, Buffer | string>,
  scanner?: KeyScanner,
): Promise<string | undefined> {
  const entries = Object.entries(files).map(([name, content]) => {
    const fullPath = path.join(dir, name)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
    return { fullPath, name }
  })
  try {
    await assertNoPrivateKeys(entries, scanner)
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

const pad = ' '.repeat(70 * 1024)

/** A zip file with the given entries. CRCs are left at zero; the scan does not check them. */
function makeZip(
  entries: Array<{ data: Buffer; encrypted?: boolean; method: 0 | 8; name: string }>,
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const body = entry.method === 8 ? zlib.deflateRawSync(entry.data) : entry.data
    const flags = entry.encrypted ? 1 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04_03_4b_50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02_01_4b_50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06_05_4b_50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** Like an Orama search index: many documents with 32-number embedding vectors. */
function oramaLike(): string {
  const docs = Array.from({ length: 2000 }, (_, i) => ({
    id: `doc-${i}`,
    ints: [...crypto.randomBytes(32)],
    vector: Array.from({ length: 32 }, () => Math.round(Math.random() * 1e6) / 1e6),
  }))
  return JSON.stringify({ docs, index: { vectors: docs.map((doc) => doc.ints) } })
}

/** Keys the run does not hold: the shape checks must catch each one. */
const unheld: Array<[string, Record<string, Buffer | string>]> = [
  ['a Solana id.json', { 'id.json': arr }],
  ['an Arweave JWK', { 'w.json': jwk }],
  ['.env with a base58 key', { '.env': `DEPLOY_KEY=${solB58}\n` }],
  ['.env.local with an ArNS key', { '.env.local': `ARNS_KEY=${solB58}\n` }],
  ['a JWK as a JSON string inside JSON', { 'config.json': JSON.stringify({ key: jwk }) }],
  ['a base64 JWK inside JSON', { 'config.json': JSON.stringify({ DEPLOY_KEY: jwk64 }) }],
  ['a pretty-printed id.json', { 'id.json': JSON.stringify(sol, null, 2) }],
  ['an id.json with a BOM', { 'id.json': `\uFEFF${arr}` }],
  ['an id.json with trailing space', { 'id.json': `${arr}   \n\t` }],
  ['an id.json with CRLF', { 'id.json': JSON.stringify(sol, null, 2).replaceAll('\n', '\r\n') }],
  ['an id.json of numeric strings', { 'id.json': JSON.stringify(sol.map(String)) }],
  ['a nested secretKey', { 'id.json': JSON.stringify({ secretKey: sol }) }],
  ['an id.json padded past 64 KiB', { 'id.json': arr + pad }],
  ['an id.json of floats', { 'id.json': `[${sol.map((byte) => `${byte}.0`).join(',')}]` }],
  ['a UTF-16LE id.json', { 'id.json': Buffer.from(`\uFEFF${arr}`, 'utf16le') }],
  ['a UTF-16BE id.json', { 'id.json': Buffer.from(`\uFEFF${arr}`, 'utf16le').swap16() }],
  ['a wrapped id.json', { 'id.json': `[${arr}]` }],
  ['a JWK with extra fields', { 'w.json': JSON.stringify({ ...jwkObject, foo: 1, kid: 'x' }) }],
  ['a pretty JWK', { 'w.json': JSON.stringify(jwkObject, null, 4) }],
  ['a JWK without kty', { 'w.json': JSON.stringify({ ...jwkObject, kty: undefined }) }],
  [
    'a JWK in reverse order',
    { 'w.json': JSON.stringify(Object.fromEntries(Object.entries(jwkObject).reverse())) },
  ],
  ['a JWK in a .txt', { 'notes.txt': jwk }],
  ['a JWK in an HTML comment', { 'page.html': `<html><!-- ${jwk} --></html>` }],
  ['a base64 JWK file', { 'key.txt': jwk64 }],
  ['a JWK padded past 64 KiB', { 'w.json': JSON.stringify(jwkObject, null, 4) + pad }],
  ['a JWK in an array', { 'w.json': JSON.stringify([jwkObject]) }],
  ['a JWK with lowercase kty', { 'w.json': JSON.stringify({ ...jwkObject, kty: 'rsa' }) }],
  [
    'a JWK with only n, e and d',
    { 'w.json': JSON.stringify({ d: jwkObject.d, e: jwkObject.e, n: jwkObject.n }) },
  ],
  ['a base58 key in a .txt', { 'key.txt': solB58 }],
  ['a hex key in a README', { 'README.md': `# key\n${solHex}\n` }],
  ['a base58 key in an HTML comment', { 'a.html': `<!-- ${solB58} -->` }],
  ['an id.json inside JavaScript', { 'app.js': `const k=${arr};` }],
  [
    'a key past the first chunk, across a chunk boundary',
    { 'big.txt': `${'a'.repeat(1024 * 1024 - 40)} ${solB58} ` },
  ],
]

describe('keys the run does not hold', () => {
  it.each(unheld)('refuses %s', async (_, files) => {
    const message = await refusal(files)
    expect(message).toMatch(/looks like a private key|is an environment file/)
    expect(message).not.toContain(solB58)
    expect(message).not.toContain(jwkObject.d)
  })
})

const held = (key: string): KeyScanner => createKeyScanner([key])

describe('keys the run holds', () => {
  it.each([
    ['a bare EVM hex copy', evmHex, { 'eth.key': evmHex }],
    ['an EVM key as uppercase hex', evmHex, { 'k.txt': evmHex.toUpperCase() }],
    ['an EVM key as base64', evmHex, { 'k.txt': Buffer.from(evmHex, 'hex').toString('base64') }],
    ['an EVM key as raw bytes', evmHex, { 'k.bin': Buffer.from(evmHex, 'hex') }],
    ['an EVM key in UTF-16', `0x${evmHex}`, { 'k.txt': Buffer.from(evmHex, 'utf16le') }],
    ['a Solana seed in base58', solB58, { 'k.txt': bs58.encode(solBytes.subarray(0, 32)) }],
    [
      'a Solana seed in base64url',
      arr,
      { 'k.txt': solBytes.subarray(0, 32).toString('base64url') },
    ],
    ['the private exponent alone', jwk, { 'd.txt': jwkObject.d }],
    ['a prime alone', jwk64, { 'p.txt': `p=${jwkObject.p}` }],
    [
      'the private part of the base64 JWK (DEPLOY_KEY form)',
      jwk64,
      { 'k.txt': jwk64.slice(Math.floor(jwk.indexOf('"d"') / 3) * 4) },
    ],
    ['a 32-byte seed array', arr, { 'id.json': JSON.stringify(sol.slice(0, 32)) }],
    [
      'a seed as a decimal list in code',
      arr,
      { 'k.js': `const k = Uint8Array.from([${sol.slice(0, 32).join(', ')}])` },
    ],
    ['a labelled EVM key', evmHex, { 'config.js': `export const PRIVATE_KEY = "0x${evmHex}"` }],
    [
      'a base58 key broken across lines',
      solB58,
      { 'k.txt': solB58.replaceAll(/(.{20})/g, '$1\n') },
    ],
    [
      'an EVM key in mixed-case hex',
      evmHex,
      { 'k.txt': [...evmHex].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('') },
    ],
    [
      'a percent-encoded base64 key',
      arr,
      { 'u.txt': `?k=${encodeURIComponent(solBytes.toString('base64'))}` },
    ],
    [
      'a base64 key with escaped slashes',
      arr,
      { 'k.json': `{"k":"${solBytes.toString('base64').replaceAll('/', String.raw`\/`)}"}` },
    ],
    ['an EVM key in a .gz file', evmHex, { 'k.txt.gz': zlib.gzipSync(evmHex) }],
    ['an EVM key gzipped under another name', evmHex, { 'data.bin': zlib.gzipSync(evmHex) }],
    ['an EVM key in a .br file', evmHex, { 'k.txt.br': zlib.brotliCompressSync(evmHex) }],
    [
      'an EVM key in a deflated zip entry',
      evmHex,
      { 'a.zip': makeZip([{ data: Buffer.from(evmHex), method: 8, name: 'k.txt' }]) },
    ],
    [
      'an EVM key in a stored zip entry',
      evmHex,
      { 'a.zip': makeZip([{ data: Buffer.from(evmHex), method: 0, name: 'k.txt' }]) },
    ],
    [
      'an EVM key in the name of a zip entry',
      evmHex,
      { 'a.zip': makeZip([{ data: Buffer.from('x'), method: 0, name: `${evmHex}.txt` }]) },
    ],
    [
      'an EVM key past 64 KiB, across a chunk boundary',
      evmHex,
      { 'big.bin': Buffer.concat([Buffer.alloc(1024 * 1024 - 20, 7), Buffer.from(evmHex)]) },
    ],
  ])('refuses %s', async (_, key, files) => {
    // None of these has a shape the generic checks recognize.
    expect(await refusal(files)).toBeUndefined()
    fs.rmSync(dir, { force: true, recursive: true })
    fs.mkdirSync(dir)

    const message = await refusal(files, held(key))
    expect(message).toMatch(/contains the private key of a wallet this command is using/)
    expect(message).not.toContain(evmHex)
  })

  it('recognizes a hard link to a wallet file by identity', async () => {
    const wallet = path.join(dir, 'payer.key')
    fs.writeFileSync(wallet, 'not a key, so only identity can match')
    fs.linkSync(wallet, path.join(dir, 'copy.txt'))

    const message = await refusal({})
    expect(message).toBeUndefined()
    await expect(
      assertNoPrivateKeys(
        [{ fullPath: path.join(dir, 'copy.txt'), name: 'copy.txt' }],
        createKeyScanner([], [wallet]),
      ),
    ).rejects.toThrow(/copy\.txt is the wallet file/)
  })
})

describe('file names', () => {
  it('refuses a held key in any path segment, without printing it', async () => {
    const message = await refusal({ [`assets/${solB58}/a.txt`]: 'x' }, held(solB58))
    expect(message).toMatch(
      /A file name in the upload contains a private key: assets\/\[name hidden]\/a\.txt/,
    )
    expect(message).not.toContain(solB58)
  })

  it('refuses a provable keypair in a name the run does not hold', async () => {
    expect(await refusal({ [`${solB58}.txt`]: 'x' })).toMatch(
      /A file name in the upload contains a private key/,
    )
  })
})

describe('compressed files that cannot be checked', () => {
  it.each([
    ['one that expands past the cap', { 'big.gz': zlib.gzipSync(Buffer.alloc(100_000)) }],
    ['a damaged gzip file', { 'bad.gz': Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5]) }],
    [
      'an encrypted zip entry',
      { 'a.zip': makeZip([{ data: Buffer.from('x'), encrypted: true, method: 0, name: 'k.txt' }]) },
    ],
  ])('refuses %s', async (_, files) => {
    const scanner = { ...createKeyScanner([evmHex]), decompressedMaxBytes: 10_000 }
    expect(await refusal(files, scanner)).toMatch(
      /is compressed and could not be checked for private keys/,
    )
  })

  it('finds a key the run does not hold inside a gzip file', async () => {
    expect(await refusal({ 'id.json.gz': zlib.gzipSync(arr) })).toMatch(/looks like a private key/)
  })
})

describe('ordinary files', () => {
  it.each([
    ['random binary data', { 'img.png': crypto.randomBytes(2 * 1024 * 1024) }],
    [
      'a bundle with a sha256 hex',
      { 'app.js': `const hash="${crypto.randomBytes(32).toString('hex')}"` },
    ],
    [
      'a sha256 in JSON',
      { 'm.json': JSON.stringify({ sha256: crypto.randomBytes(32).toString('hex') }) },
    ],
    ['a git hash', { 'v.txt': crypto.randomBytes(20).toString('hex') }],
    ['a Solana address', { 'a.html': `<p>${generateSolanaWallet().address}</p>` }],
    ['a transaction signature', { 'tx.html': `<a>${bs58.encode(crypto.randomBytes(64))}</a>` }],
    [
      'a JWT',
      {
        't.js': `const t="${Buffer.from(JSON.stringify({ alg: 'HS256', sub: 'x'.repeat(120) })).toString('base64url')}"`,
      },
    ],
    ['a small palette', { 'p.json': JSON.stringify(Array.from({ length: 32 }, (_, i) => i % 4)) }],
    [
      'a public JWK',
      { 'pub.json': JSON.stringify({ e: jwkObject.e, kty: 'RSA', n: jwkObject.n }) },
    ],
    ['a 63-entry array', { 'a.json': JSON.stringify([...crypto.randomBytes(63)]) }],
    [
      'a 64-entry byte array that is not a keypair',
      { 'a.json': JSON.stringify([...crypto.randomBytes(64)]) },
    ],
    ['a search index of 32-number vectors', { 'search.json': oramaLike() }],
    [
      'd and n in different objects',
      { 'm.json': JSON.stringify([{ d: otherJwk.d }, { n: otherJwk.n }]) },
    ],
    [
      'd and n in different objects, as text',
      { 'm.js': `const a={"d":"${otherJwk.d}"};const b={"n":"${otherJwk.n}"}` },
    ],
    [
      'an ordinary zip',
      {
        'site.zip': makeZip([{ data: Buffer.from('<h1>hi</h1>'), method: 8, name: 'index.html' }]),
      },
    ],
    ['an ordinary gzip file', { 'app.js.gz': zlib.gzipSync('console.log(1)') }],
  ])('passes %s', async (_, files) => {
    expect(await refusal(files, createKeyScanner([evmHex, solB58, jwk]))).toBeUndefined()
  })
})

describe('isSolanaKeypair', () => {
  it('confirms a keypair and rejects 64 random bytes', () => {
    expect(isSolanaKeypair(solBytes)).toBe(true)
    expect(isSolanaKeypair(crypto.randomBytes(64))).toBe(false)
  })
})
