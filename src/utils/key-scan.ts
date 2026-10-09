/**
 * Find private keys in what is about to be uploaded. An Arweave upload is
 * permanent and public, so a key that lands in it can never be taken back.
 *
 * Two kinds of check, both run before any network request:
 *
 * - **The keys this run holds.** Every key the command was given (`--wallet`,
 *   `--arns-wallet`, `--private-key`, `--arns-private-key`, `DEPLOY_KEY`,
 *   `ARNS_KEY`) is turned into the forms it could be stored in: raw bytes,
 *   hex in any case, base64 and base64url (also percent-encoded or with `\/`),
 *   base58, a decimal byte list, the JWK's private fields and the base64 JWK.
 *   Every file, file name and the contents of gzip, brotli and zip files are
 *   searched for each of them, at any size, also as UTF-16, with whitespace
 *   and line breaks removed. A match is exact, so it is never a false alarm.
 * - **Keys this run does not hold.** Only what can be proved to be a key: a
 *   `.env` file; a Solana keypair written as a byte array, base58 or hex,
 *   confirmed by deriving the public half from the seed; a JWK object with a
 *   private exponent `d` and a modulus `n` in the same object, as JSON,
 *   escaped inside a string, or base64-encoded.
 *
 * Not detected when the run does not hold the key: PEM files, a 32-byte seed
 * on its own in any form (it cannot be told from a hash or an address), keys
 * inside binary formats, and keys split across strings.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import zlib from 'node:zlib'

import bs58 from 'bs58'
import pLimit from 'p-limit'

/** PKCS#8 DER header for an ed25519 private key; the 32-byte seed follows it. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** The ed25519 public key for a 32-byte seed. */
export function ed25519PublicKeyFromSeed(seed: Uint8Array): Buffer {
  const privateKey = createPrivateKey({
    format: 'der',
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    type: 'pkcs8',
  })
  return Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url')
}

/** True when 64 bytes are an ed25519 seed followed by its own public key. */
export function isSolanaKeypair(bytes: Uint8Array): boolean {
  if (bytes.length !== 64) return false
  try {
    return ed25519PublicKeyFromSeed(bytes.subarray(0, 32)).equals(Buffer.from(bytes.subarray(32)))
  } catch {
    return false
  }
}

const BOM = String.fromCodePoint(0xfe_ff)
const UTF8_BOM_LATIN1 = String.fromCodePoint(0xef, 0xbb, 0xbf)

function stripBom(text: string): string {
  if (text.startsWith(BOM)) return text.slice(1)
  if (text.startsWith(UTF8_BOM_LATIN1)) return text.slice(3)
  return text
}

/** What to search every uploaded file for. Build one with {@link createKeyScanner}. */
export interface KeyScanner {
  /** The most a compressed file may expand to; {@link DECOMPRESSED_MAX_BYTES} when unset. */
  decompressedMaxBytes?: number
  /** Hex needles, lowercase; searched in lowercased text. */
  hex: string[]
  /** Raw secret bytes. */
  raw: Buffer[]
  /** Case-sensitive text needles with no whitespace in them. */
  text: string[]
  /** Wallet files by identity, so a hard link to one is recognized. */
  wallets: Array<{ dev: bigint; ino: bigint; label: string }>
}

const MIN_NEEDLE = 24

/** Every text encoding a secret could be stored in, as needles of a useful length. */
function encodingsOf(secret: Uint8Array): { hex: string[]; text: string[] } {
  const bytes = Buffer.from(secret)
  // 30 bytes is a whole number of base64 groups, so the prefix is stable.
  const head30 = bytes.subarray(0, 30)
  const b58 = bs58.encode(bytes)
  const b64 = head30.toString('base64')
  const text = [
    b64,
    b64.replaceAll('/', String.raw`\/`),
    b64.replaceAll('+', '%2B').replaceAll('/', '%2F'),
    b64.replaceAll('+', '%2b').replaceAll('/', '%2f'),
    head30.toString('base64url'),
    b58.length > 64 ? b58.slice(0, 64) : b58,
    // A byte list, `[12,34,...]` or `Uint8Array.from([12, 34, ...])`, once spaces are removed.
    [...bytes.subarray(0, 16)].join(','),
  ]
  return { hex: [bytes.subarray(0, 32).toString('hex')], text }
}

const JWK_PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi'] as const

/** The secret parts of a key string, whatever form it is in. */
function secretsOf(key: string): { secrets: Uint8Array[]; text: string[] } {
  const trimmed = stripBom(key).trim()
  const secrets: Uint8Array[] = []
  const text: string[] = []

  const addJwk = (json: string): void => {
    let jwk: unknown
    try {
      jwk = JSON.parse(json)
    } catch {
      return
    }

    if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return
    let found = false
    for (const field of JWK_PRIVATE_FIELDS) {
      const value = (jwk as Record<string, unknown>)[field]
      if (typeof value === 'string' && value.length >= 40) {
        secrets.push(Buffer.from(value, 'base64url'))
        text.push(value.slice(0, 64))
        found = true
      }
    }

    if (found) {
      // The DEPLOY_KEY form: base64 of the JWK text. Take the prefix and the
      // slice that starts where the private exponent does.
      const b64 = Buffer.from(json).toString('base64')
      text.push(b64.slice(0, 64))
      const at = json.indexOf('"d"')
      if (at >= 0) {
        const start = Math.floor(at / 3) * 4
        text.push(b64.slice(start, start + 64))
      }
    }
  }

  // A JSON byte array (id.json), possibly as strings.
  if (trimmed.startsWith('[')) {
    try {
      const array = (JSON.parse(trimmed) as unknown[]).map(Number)
      if (array.length >= 32 && array.every((byte) => Number.isInteger(byte))) {
        const bytes = Uint8Array.from(array)
        secrets.push(bytes.subarray(0, 32))
        if (bytes.length === 64) secrets.push(bytes)
      }
    } catch {
      // Not an array after all.
    }
  }

  if (trimmed.startsWith('{')) {
    addJwk(trimmed)
  } else if (/^[\w+/-]+=*$/.test(trimmed) && trimmed.startsWith('eyJ')) {
    addJwk(Buffer.from(trimmed, 'base64').toString('utf8'))
  }

  // Base58: a Solana secret key.
  if (/^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(trimmed)) {
    try {
      const bytes = bs58.decode(trimmed)
      if (bytes.length === 64 || bytes.length === 32) {
        secrets.push(bytes.subarray(0, 32))
        if (bytes.length === 64) secrets.push(bytes)
      }
    } catch {
      // Not base58.
    }
  }

  // Hex: an Ethereum or Polygon key, or a Solana key written as hex.
  const hex = trimmed.replace(/^0x/i, '')
  if (/^(?:[\dA-Fa-f]{64}|[\dA-Fa-f]{128})$/.test(hex)) {
    const bytes = Buffer.from(hex, 'hex')
    secrets.push(bytes.subarray(0, 32))
    if (bytes.length === 64) secrets.push(bytes)
  }

  // The string as given, whatever it is.
  if (trimmed.length >= MIN_NEEDLE && !trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    text.push(trimmed.slice(0, 64).replaceAll(/\s/g, ''))
  }

  return { secrets, text }
}

/**
 * Build the scanner for one run.
 *
 * @param keys - Every key string the command holds: wallet file contents,
 *   private-key flags and key environment variables. Empty or unreadable
 *   values are skipped.
 * @param walletFiles - Wallet file paths, recognized by identity as well.
 */
export function createKeyScanner(
  keys: Array<string | undefined> = [],
  walletFiles: Array<string | undefined> = [],
): KeyScanner {
  const raw: Buffer[] = []
  const text = new Set<string>()
  const hex = new Set<string>()

  for (const key of keys) {
    if (!key?.trim()) continue
    const { secrets, text: strings } = secretsOf(key)
    for (const secret of secrets) {
      if (secret.length >= 32) raw.push(Buffer.from(secret.subarray(0, 32)))
      const encodings = encodingsOf(secret)
      for (const needle of encodings.text) text.add(needle)
      for (const needle of encodings.hex) hex.add(needle)
    }

    for (const string of strings) text.add(string)
  }

  const wallets: KeyScanner['wallets'] = []
  for (const file of walletFiles) {
    if (!file) continue
    try {
      const stats = fs.statSync(file, { bigint: true })
      if (stats.ino !== 0n) wallets.push({ dev: stats.dev, ino: stats.ino, label: file })
    } catch {
      // A missing wallet is reported when the key is read.
    }
  }

  return {
    hex: [...hex],
    raw,
    text: [...text].filter((needle) => needle.length >= MIN_NEEDLE),
    wallets,
  }
}

/** True when text, with whitespace removed, holds a needle. */
function holdsKey(view: string, scanner: KeyScanner): boolean {
  if (scanner.text.length === 0 && scanner.hex.length === 0) return false
  const flat = view.replaceAll(/[\t\n\r ]+/g, '')
  if (scanner.text.some((needle) => flat.includes(needle))) return true
  if (scanner.hex.length === 0) return false
  const lower = flat.toLowerCase()
  return scanner.hex.some((needle) => lower.includes(needle))
}

const B58 = '1-9A-HJ-NP-Za-km-z'
const BYTE = String.raw`\s*"?\d{1,3}(?:\.0+)?"?\s*`
const BYTE_ARRAY_64 = new RegExp(String.raw`\[(?:${BYTE},){63}${BYTE}\]`, 'g')
const BASE58_KEY = new RegExp(`^[${B58}]{86,88}$`)
const HEX_KEY = /^(?:0x)?[\dA-Fa-f]{128}$/
const JWK_D = /\\?["']d\\?["']\s*:\s*\\?["'][\w-]{40,}/g
const JWK_N = /\\?["']n\\?["']\s*:\s*\\?["'][\w-]{40,}/
const BASE64_JSON = /eyJ[\w+/-]{100,}={0,2}/g

/**
 * Runs of letters and digits 86 to 130 characters long: the lengths of a
 * Solana secret key in base58 (86 to 88) or hex (128, or 130 with `0x`).
 * One pass over the text; a regular expression for the same thing re-reads
 * every short run and was most of the scan time on JavaScript bundles.
 */
function keyLengthRuns(text: string): string[] {
  const runs: string[] = []
  let start = -1
  for (let i = 0; i <= text.length; i++) {
    const code = i < text.length ? (text.codePointAt(i) ?? 0) : 0
    const alnum =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    if (alnum) {
      if (start < 0) start = i
    } else if (start >= 0) {
      const length = i - start
      if (length >= 86 && length <= 130) runs.push(text.slice(start, i))
      start = -1
    }
  }

  return runs
}

/** A Solana keypair in base58 or hex among the runs of `text`, confirmed. */
function solanaKeypairToken(text: string): string | undefined {
  for (const token of keyLengthRuns(text)) {
    if (BASE58_KEY.test(token)) {
      try {
        if (isSolanaKeypair(bs58.decode(token))) return 'a Solana keypair in base58'
      } catch {
        // Not base58 after all.
      }
    } else if (
      HEX_KEY.test(token) &&
      isSolanaKeypair(Buffer.from(token.replace(/^0x/, ''), 'hex'))
    ) {
      return 'a Solana keypair in hex'
    }
  }

  return undefined
}

/**
 * True when a `d` field and an `n` field sit in the same flat object. JWK
 * values are base64url and hold no braces, so the object around `d` runs
 * from the nearest `{` before it to the nearest `}` after it.
 */
function jwkInText(text: string): boolean {
  for (const match of text.matchAll(JWK_D)) {
    const open = text.lastIndexOf('{', match.index)
    const close = text.indexOf('}', match.index)
    if (open >= 0 && close >= 0 && JWK_N.test(text.slice(open, close))) return true
  }

  return false
}

/** Why a piece of text holds a key the run does not know, or undefined. */
function textReason(text: string): string | undefined {
  for (const match of text.matchAll(BYTE_ARRAY_64)) {
    const bytes = match[0]
      .slice(1, -1)
      .split(',')
      .map((value) => Number(value.replaceAll('"', '')))
    if (bytes.every((byte) => byte <= 255) && isSolanaKeypair(Uint8Array.from(bytes))) {
      return 'a Solana keypair as a byte array'
    }
  }

  const token = solanaKeypairToken(text)
  if (token) return token

  if (jwkInText(text)) return 'a JWK private key'

  for (const [encoded] of text.matchAll(BASE64_JSON)) {
    if (jwkInText(Buffer.from(encoded.slice(0, 64 * 1024), 'base64').toString('latin1'))) {
      return 'a base64-encoded JWK private key'
    }
  }

  return undefined
}

/** A 64-entry list of bytes, as numbers or numeric strings, that is a Solana keypair. */
function isKeypairArray(value: unknown[]): boolean {
  if (value.length !== 64) return false
  const bytes = value.map((entry) =>
    typeof entry === 'number' || (typeof entry === 'string' && /^\d+(?:\.0+)?$/.test(entry))
      ? Number(entry)
      : Number.NaN,
  )
  return (
    bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) &&
    isSolanaKeypair(Uint8Array.from(bytes))
  )
}

const BASE64URL_VALUE = /^[\w-]{40,}$/

/** Why a parsed JSON value holds a key, or undefined. Walks every depth. */
function jsonReason(value: unknown, depth = 0): string | undefined {
  if (depth > 64 || value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 40 && /^\s*[[{]/.test(value)) {
      try {
        return jsonReason(JSON.parse(value), depth + 1)
      } catch {
        return undefined
      }
    }

    return undefined
  }

  if (Array.isArray(value)) {
    if (isKeypairArray(value)) return 'a Solana keypair as a byte array'
    for (const entry of value) {
      const reason = jsonReason(entry, depth + 1)
      if (reason) return reason
    }

    return undefined
  }

  const { d, n } = value as Record<string, unknown>
  if (
    typeof d === 'string' &&
    typeof n === 'string' &&
    BASE64URL_VALUE.test(d) &&
    BASE64URL_VALUE.test(n)
  ) {
    return 'a JWK private key'
  }

  for (const entry of Object.values(value)) {
    const reason = jsonReason(entry, depth + 1)
    if (reason) return reason
  }

  return undefined
}

const CHUNK_BYTES = 1024 * 1024
/** Longer than any single needle or pattern, so nothing is lost at a chunk edge. */
const OVERLAP_BYTES = 16 * 1024
/** JSON files up to this size are also parsed and walked. */
const JSON_PARSE_MAX_BYTES = 32 * 1024 * 1024
/** The most a compressed file may expand to before it is refused as uncheckable. */
export const DECOMPRESSED_MAX_BYTES = 1024 * 1024 * 1024

type Encoding = 'utf16be' | 'utf16le' | undefined

/** UTF-16 when the data starts with a byte-order mark or every other byte is zero. */
function detectUtf16(head: Buffer): Encoding {
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf16le'
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf16be'
  const sample = head.subarray(0, 4096)
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i + 1 < sample.length; i += 2) {
    if (sample[i] === 0) evenZero++
    if (sample[i + 1] === 0) oddZero++
  }

  const pairs = Math.floor(sample.length / 2)
  if (pairs >= 8 && oddZero > pairs * 0.4 && evenZero < pairs * 0.1) return 'utf16le'
  if (pairs >= 8 && evenZero > pairs * 0.4 && oddZero < pairs * 0.1) return 'utf16be'
  return undefined
}

function decodeUtf16(window: Buffer, encoding: 'utf16be' | 'utf16le'): string {
  const even = window.subarray(0, window.length - (window.length % 2))
  if (encoding === 'utf16le') return even.toString('utf16le')
  return Buffer.from(even).swap16().toString('utf16le')
}

export type ScanFinding =
  | { kind: 'generic'; reason: string }
  | { kind: 'held' }
  | { kind: 'unchecked'; reason: string }

/**
 * Searches a byte stream fed to it in pieces. Each piece is searched together
 * with the end of the one before, so a key across a boundary is found.
 */
class StreamSearch {
  private encoding: Encoding
  private started = false
  private tail = Buffer.alloc(0)

  constructor(private readonly scanner: KeyScanner) {}

  push(read: Buffer): ScanFinding | undefined {
    if (!this.started) {
      this.started = true
      this.encoding = detectUtf16(read)
    }

    const window = this.tail.length > 0 ? Buffer.concat([this.tail, read]) : read
    // Keep an even number of bytes so UTF-16 stays aligned.
    const from = Math.max(0, window.length - OVERLAP_BYTES)
    this.tail = Buffer.from(window.subarray(from - (from % 2)))

    for (const needle of this.scanner.raw) {
      if (window.includes(needle)) return { kind: 'held' }
    }

    const views = [window.toString('latin1')]
    if (this.encoding) views.push(decodeUtf16(window, this.encoding))
    if (views.some((view) => holdsKey(view, this.scanner))) return { kind: 'held' }

    /*
     * A piece with zero bytes that is not UTF-16 is binary (an image, a
     * font): the shape checks look for text, and running them over binary
     * data costs most of the scan. The held keys are still searched.
     */
    if (!this.encoding && read.includes(0)) return undefined
    for (const view of views) {
      const reason = textReason(view)
      if (reason) return { kind: 'generic', reason }
    }

    return undefined
  }
}

/** Search a stream, in pieces of about {@link CHUNK_BYTES}, within a byte budget. */
async function searchStream(
  stream: Readable,
  scanner: KeyScanner,
  budget: { left: number; limit: number },
): Promise<ScanFinding | undefined> {
  const search = new StreamSearch(scanner)
  let pending: Buffer[] = []
  let pendingBytes = 0
  const flush = (): ScanFinding | undefined => {
    if (pendingBytes === 0) return undefined
    const piece = Buffer.concat(pending)
    pending = []
    pendingBytes = 0
    return search.push(piece)
  }

  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer
      budget.left -= buffer.length
      if (budget.left < 0) {
        return { kind: 'unchecked', reason: `it expands to more than ${budget.limit} bytes` }
      }

      pending.push(buffer)
      pendingBytes += buffer.length
      if (pendingBytes >= CHUNK_BYTES) {
        const finding = flush()
        if (finding) return finding
      }
    }

    return flush()
  } finally {
    stream.destroy()
  }
}

interface ZipEntry {
  compressedSize: number
  dataStart: number
  method: number
  name: string
}

/** The entries of a zip file from its central directory, or why they cannot be read. */
async function zipEntries(
  handle: fs.promises.FileHandle,
  size: number,
): Promise<string | ZipEntry[]> {
  const tailLength = Math.min(size, 65_557)
  const tail = Buffer.alloc(tailLength)
  await handle.read(tail, 0, tailLength, size - tailLength)
  let end = -1
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06_05_4b_50) {
      end = i
      break
    }
  }

  if (end < 0) return 'it is not a readable zip file'
  const count = tail.readUInt16LE(end + 10)
  const directorySize = tail.readUInt32LE(end + 12)
  const directoryOffset = tail.readUInt32LE(end + 16)
  if (count === 0xff_ff || directorySize === 0xff_ff_ff_ff || directoryOffset === 0xff_ff_ff_ff) {
    return 'ZIP64 archives are not supported'
  }

  if (directoryOffset + directorySize > size) return 'it is not a readable zip file'
  const directory = Buffer.alloc(directorySize)
  await handle.read(directory, 0, directorySize, directoryOffset)

  const entries: ZipEntry[] = []
  let at = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02_01_4b_50) {
      return 'it is not a readable zip file'
    }

    const flags = directory.readUInt16LE(at + 8)
    const method = directory.readUInt16LE(at + 10)
    const compressedSize = directory.readUInt32LE(at + 20)
    const nameLength = directory.readUInt16LE(at + 28)
    const extraLength = directory.readUInt16LE(at + 30)
    const commentLength = directory.readUInt16LE(at + 32)
    const localOffset = directory.readUInt32LE(at + 42)
    const name = directory.toString('utf8', at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue
    if (flags % 2 === 1) return `${name} inside it is encrypted`
    if (method !== 0 && method !== 8)
      return `${name} inside it uses a compression method this check cannot read`

    const local = Buffer.alloc(30)
    await handle.read(local, 0, 30, localOffset)
    if (local.readUInt32LE(0) !== 0x04_03_4b_50) return 'it is not a readable zip file'
    const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
    entries.push({ compressedSize, dataStart, method, name })
  }

  return entries
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/** Search what a compressed file expands to: gzip and zip by content, brotli by name. */
async function searchCompressed(
  file: {
    fullPath: string
    handle: fs.promises.FileHandle
    /** The first bytes, for the signature. */
    head: Buffer
    name: string
    size: number
  },
  scanner: KeyScanner,
): Promise<ScanFinding | undefined> {
  const { fullPath, handle, head, name, size } = file
  const limit = scanner.decompressedMaxBytes ?? DECOMPRESSED_MAX_BYTES
  const budget = { left: limit, limit }

  if (head.subarray(0, 2).equals(GZIP_MAGIC)) {
    const finding = await searchStream(
      fs.createReadStream(fullPath).pipe(zlib.createGunzip()),
      scanner,
      budget,
    ).catch((error: unknown) => ({
      kind: 'unchecked' as const,
      reason: `it could not be decompressed (${error instanceof Error ? error.message : String(error)})`,
    }))
    return finding
  }

  if (head.subarray(0, 4).equals(ZIP_MAGIC)) {
    const entries = await zipEntries(handle, size)
    if (typeof entries === 'string') return { kind: 'unchecked', reason: entries }
    for (const entry of entries) {
      if (nameHoldsKey(entry.name, scanner)) return { kind: 'held' }
      if (entry.compressedSize === 0) continue
      const raw = fs.createReadStream(fullPath, {
        end: entry.dataStart + entry.compressedSize - 1,
        start: entry.dataStart,
      })
      const finding = await searchStream(
        entry.method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw,
        scanner,
        budget,
      ).catch((error: unknown) => ({
        kind: 'unchecked' as const,
        reason: `${entry.name} inside it could not be decompressed (${error instanceof Error ? error.message : String(error)})`,
      }))
      if (finding) return finding
    }

    return undefined
  }

  // Brotli has no signature. A .br file that does not decode is not brotli.
  if (path.extname(name).toLowerCase() === '.br') {
    try {
      return await searchStream(
        fs.createReadStream(fullPath).pipe(zlib.createBrotliDecompress()),
        scanner,
        budget,
      )
    } catch {
      return undefined
    }
  }

  return undefined
}

/**
 * Search one file. Reads it in chunks with an overlap, so a key anywhere in
 * a file of any size is found, then searches what it expands to when it is
 * compressed.
 */
export async function scanFile(
  fullPath: string,
  scanner: KeyScanner,
  name: string = path.basename(fullPath),
): Promise<ScanFinding | undefined> {
  const handle = await fs.promises.open(fullPath, 'r')
  try {
    const { size } = await handle.stat()
    const search = new StreamSearch(scanner)
    let keep: Buffer | undefined
    let head = Buffer.alloc(0)
    let position = 0

    while (position < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) break
      const read = chunk.subarray(0, bytesRead)
      if (position === 0) {
        head = Buffer.from(read.subarray(0, 64))
        const encoding = detectUtf16(read)
        // Only what could be JSON is kept whole, to be parsed at the end.
        const start = stripBom(
          encoding ? decodeUtf16(read.subarray(0, 64), encoding) : read.toString('latin1', 0, 64),
        ).trimStart()
        if (size <= JSON_PARSE_MAX_BYTES && /^[[{]/.test(start)) keep = Buffer.alloc(size)
      }

      keep?.set(read, position)
      position += bytesRead

      const finding = search.push(read)
      if (finding) return finding
    }

    if (keep) {
      const encoding = detectUtf16(keep)
      const trimmed = stripBom(
        encoding ? decodeUtf16(keep, encoding) : keep.toString('utf8'),
      ).trim()
      try {
        const reason = jsonReason(JSON.parse(trimmed))
        if (reason) return { kind: 'generic', reason }
      } catch {
        // Not JSON.
      }
    }

    return await searchCompressed({ fullPath, handle, head, name, size }, scanner)
  } finally {
    await handle.close()
  }
}

/** True when a name, or a path inside an archive, holds a key the run holds or a provable one. */
function nameHoldsKey(name: string, scanner: KeyScanner): boolean {
  return holdsKey(name, scanner) || solanaKeypairToken(name) !== undefined
}

/** The path with every segment that holds a key replaced, so the error never prints the key. */
function redactedName(name: string, scanner: KeyScanner): string {
  return name
    .split('/')
    .map((segment) => (nameHoldsKey(segment, scanner) ? '[name hidden]' : segment))
    .join('/')
}

const SCAN_CONCURRENCY = 8
const PERMANENT = 'Arweave uploads are permanent and public.'

/**
 * Refuse an upload set that holds a private key. Runs before anything is
 * hashed, looked up or sent.
 *
 * @param files - Each file's path on disk and the name to report it by.
 * @param scanner - The run's keys; omitted, only the shape checks run.
 * @throws Naming the first file found, never the key itself.
 */
export async function assertNoPrivateKeys(
  files: Array<{ fullPath: string; name: string }>,
  scanner: KeyScanner = createKeyScanner(),
): Promise<void> {
  const limit = pLimit(SCAN_CONCURRENCY)
  let stop = false
  const problems = await Promise.all(
    files.map((file) =>
      limit(async () => {
        if (stop) return
        const problem = await checkFile(file, scanner)
        if (problem) stop = true
        return problem
      }),
    ),
  )

  const problem = problems.find(Boolean)
  if (problem) {
    throw new Error(problem)
  }
}

async function checkFile(
  file: { fullPath: string; name: string },
  scanner: KeyScanner,
): Promise<string | undefined> {
  if (nameHoldsKey(file.name, scanner)) {
    return `A file name in the upload contains a private key: ${redactedName(file.name, scanner)}. It will not be published. ${PERMANENT} Rename or remove the file.`
  }

  if (/^\.env/i.test(path.basename(file.name))) {
    return `${file.name} is an environment file, which usually holds secrets, and will not be published. ${PERMANENT} Move it out of what you upload.`
  }

  if (scanner.wallets.length > 0) {
    const stats = await fs.promises.stat(file.fullPath, { bigint: true })
    const wallet = scanner.wallets.find(
      (entry) => entry.dev === stats.dev && entry.ino === stats.ino,
    )
    if (wallet) {
      return `${file.name} is the wallet file ${wallet.label} (a link to it). A wallet will not be published: ${PERMANENT}`
    }
  }

  const finding = await scanFile(file.fullPath, scanner, file.name)
  if (finding?.kind === 'held') {
    return `${file.name} contains the private key of a wallet this command is using, and will not be published. ${PERMANENT} Move the file out of what you upload.`
  }

  if (finding?.kind === 'unchecked') {
    return `${file.name} is compressed and could not be checked for private keys: ${finding.reason}. It will not be published. Remove it from what you upload.`
  }

  if (finding) {
    return `${file.name} looks like a private key (${finding.reason}) and will not be published. ${PERMANENT} Move the file out of what you upload.`
  }

  return undefined
}
