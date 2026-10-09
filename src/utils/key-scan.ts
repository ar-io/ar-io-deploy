/**
 * Find private keys in what is about to be uploaded. An Arweave upload is
 * permanent and public, so a key that lands in it can never be taken back.
 *
 * Two kinds of check, both run before any network request:
 *
 * - **The keys this run holds.** Every key the command was given (`--wallet`,
 *   `--arns-wallet`, `--private-key`, `--arns-private-key`, `DEPLOY_KEY`,
 *   `ARNS_KEY`) is turned into the forms it could be stored in: raw bytes,
 *   hex, base64, base64url, base58, the JWK's private fields and the base64
 *   JWK. Every file is searched for each of them, at any size, also as UTF-16.
 *   A match is exact, so it is never a false alarm.
 * - **Keys this run does not hold.** Shapes that are almost always a key:
 *   a `.env` file; a Solana keypair written as a byte array, base58 or hex
 *   (confirmed by checking the public half against the seed); a JWK with a
 *   private exponent (`d` with `n` or `crv`), as JSON, escaped inside a
 *   string, or base64-encoded; a 32- or 64-entry byte array in JSON; a
 *   64- or 128-character hex or an 86 to 88-character base58 value written
 *   after a label such as `KEY=`, `secret:` or `private_key`.
 *
 * Not detected when the run does not hold the key: PEM files, a bare 32-byte
 * seed written as base58 or hex with no label (it looks like an address or a
 * hash), keys inside compressed or binary formats, and keys split across
 * lines or strings.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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

/** What to search every uploaded file for. Build one with {@link createKeyScanner}. */
export interface KeyScanner {
  /** Byte strings: raw secrets and the ASCII encodings of them. */
  needles: Buffer[]
  /** The ASCII needles as text, searched in UTF-16 decodings. */
  textNeedles: string[]
  /** Wallet files by identity, so a hard link to one is recognized. */
  wallets: Array<{ dev: bigint; ino: bigint; label: string }>
}

const MIN_NEEDLE = 24

/** Every encoding a secret could be stored in, as needles of a useful length. */
function encodingsOf(secret: Uint8Array): string[] {
  const bytes = Buffer.from(secret)
  const head32 = bytes.subarray(0, 32)
  // 30 bytes is a whole number of base64 groups, so the prefix is stable.
  const head30 = bytes.subarray(0, 30)
  const b58 = bs58.encode(bytes)
  return [
    head32.toString('hex'),
    head32.toString('hex').toUpperCase(),
    head30.toString('base64'),
    head30.toString('base64url'),
    b58.length > 64 ? b58.slice(0, 64) : b58,
  ]
}

const JWK_PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi'] as const

/** The secret parts of a key string, whatever form it is in. */
function secretsOf(key: string): { secrets: Uint8Array[]; text: string[] } {
  const trimmed = key.replace(/^\uFEFF/, '').trim()
  const secrets: Uint8Array[] = []
  const text: string[] = []

  const addJwk = (json: string): boolean => {
    let jwk: Record<string, unknown>
    try {
      jwk = JSON.parse(json) as Record<string, unknown>
    } catch {
      return false
    }

    if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return false
    let found = false
    for (const field of JWK_PRIVATE_FIELDS) {
      const value = jwk[field]
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

    return found
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
    text.push(trimmed.slice(0, 64))
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

  for (const key of keys) {
    if (!key?.trim()) continue
    const { secrets, text: strings } = secretsOf(key)
    for (const secret of secrets) {
      if (secret.length >= 32) {
        raw.push(Buffer.from(secret.subarray(0, 32)))
      }

      for (const encoding of encodingsOf(secret)) text.add(encoding)
    }

    for (const string of strings) text.add(string)
  }

  const textNeedles = [...text].filter((needle) => needle.length >= MIN_NEEDLE)
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
    needles: [...raw, ...textNeedles.map((needle) => Buffer.from(needle, 'latin1'))],
    textNeedles,
    wallets,
  }
}

const B58 = '1-9A-HJ-NP-Za-km-z'
const BYTE = String.raw`\s*"?\d{1,3}(?:\.0+)?"?\s*`
const BYTE_ARRAY_64 = new RegExp(String.raw`\[(?:${BYTE},){63}${BYTE}\]`, 'g')
const BASE58_KEY = new RegExp(`^[${B58}]{86,88}$`)
const HEX_KEY = /^(?:0x)?[\dA-Fa-f]{128}$/
const LABELLED_VALUE =
  /(?:private|secret|(?<![\da-z])key)[\w-]{0,30}\\?["']?\s*[:=]\s*\\?["']?(?:0x)?([\da-z]{64,130})(?![\da-z])/gi
const LABELLED_KEY = new RegExp(String.raw`^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{128}|[${B58}]{86,88})$`)
const JWK_D = /\\?["']d\\?["']\s*:\s*\\?["'][\w-]{40,}/
const JWK_PUBLIC = /\\?["'](?:n\\?["']\s*:\s*\\?["'][\w-]{40,}|crv\\?["']\s*:)/
const BASE64_JSON = /eyJ[\w+/-]{100,}={0,2}/g

/** Per-file state carried across chunks. */
interface TextState {
  jwkD: boolean
  jwkPublic: boolean
}

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

/** Why a piece of text holds a key the run does not know, or undefined. */
function textReason(text: string, state: TextState): string | undefined {
  for (const match of text.matchAll(BYTE_ARRAY_64)) {
    const bytes = match[0]
      .slice(1, -1)
      .split(',')
      .map((value) => Number(value.replaceAll('"', '')))
    if (bytes.every((byte) => byte <= 255) && isSolanaKeypair(Uint8Array.from(bytes))) {
      return 'a Solana keypair as a byte array'
    }
  }

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

  for (const match of text.matchAll(LABELLED_VALUE)) {
    if (LABELLED_KEY.test(match[1])) return 'a key written after a key label'
  }

  if (JWK_D.test(text)) state.jwkD = true
  if (JWK_PUBLIC.test(text)) state.jwkPublic = true
  if (state.jwkD && state.jwkPublic) return 'a JWK private key'

  for (const [token] of text.matchAll(BASE64_JSON)) {
    const decoded = Buffer.from(token.slice(0, 64 * 1024), 'base64').toString('latin1')
    if (JWK_D.test(decoded) && JWK_PUBLIC.test(decoded)) return 'a base64-encoded JWK private key'
  }

  return undefined
}

/** Entries that are all whole numbers from 0 to 255, as numbers or numeric strings. */
function isByteArray(value: unknown[]): boolean {
  if (value.length !== 32 && value.length !== 64) return false
  const bytes = value.map((entry) =>
    typeof entry === 'number' || (typeof entry === 'string' && /^\d+(?:\.0+)?$/.test(entry))
      ? Number(entry)
      : Number.NaN,
  )
  if (!bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return false
  // A random 32-byte secret has about 30 distinct values; a palette or a flag list has few.
  return new Set(bytes).size >= value.length / 2
}

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
    if (isByteArray(value)) return `a ${value.length}-byte array`
    for (const entry of value) {
      const reason = jsonReason(entry, depth + 1)
      if (reason) return reason
    }

    return undefined
  }

  const object = value as Record<string, unknown>
  if (typeof object.d === 'string' && (object.n !== undefined || object.crv !== undefined)) {
    return 'a JWK private key'
  }

  for (const entry of Object.values(object)) {
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

type Encoding = 'utf16be' | 'utf16le' | undefined

/** UTF-16 when the file starts with a byte-order mark or every other byte is zero. */
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

export type ScanFinding = { kind: 'generic'; reason: string } | { kind: 'held' }

/**
 * Search one file. Reads it in chunks with an overlap, so a key anywhere in
 * a file of any size is found.
 */
export async function scanFile(
  fullPath: string,
  scanner: KeyScanner,
): Promise<ScanFinding | undefined> {
  const handle = await fs.promises.open(fullPath, 'r')
  try {
    const { size } = await handle.stat()
    const state: TextState = { jwkD: false, jwkPublic: false }
    let keep: Buffer | undefined
    let tail = Buffer.alloc(0)
    let encoding: Encoding
    let position = 0

    while (position < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) break
      const read = chunk.subarray(0, bytesRead)
      if (position === 0) {
        encoding = detectUtf16(read)
        // Only what could be JSON is kept whole, to be parsed at the end.
        const start = (
          encoding ? decodeUtf16(read.subarray(0, 64), encoding) : read.toString('latin1', 0, 64)
        )
          .replace(/^(?:\uFEFF|\u00EF\u00BB\u00BF)/, '')
          .trimStart()
        if (size <= JSON_PARSE_MAX_BYTES && /^[[{]/.test(start)) keep = Buffer.alloc(size)
      }

      keep?.set(read, position)
      position += bytesRead

      const window = tail.length > 0 ? Buffer.concat([tail, read]) : read
      for (const needle of scanner.needles) {
        if (window.includes(needle)) return { kind: 'held' }
      }

      /*
       * A chunk with zero bytes that is not UTF-16 is binary (an image, a
       * font): the shape checks look for text, and running them over binary
       * data costs most of the scan. The held keys are still searched.
       */
      const texts = encoding || !read.includes(0) ? [window.toString('latin1')] : []
      if (encoding) {
        const decoded = decodeUtf16(window, encoding)
        if (scanner.textNeedles.some((needle) => decoded.includes(needle))) return { kind: 'held' }
        texts.push(decoded)
      }

      for (const text of texts) {
        const reason = textReason(text, state)
        if (reason) return { kind: 'generic', reason }
      }

      // Keep an even number of bytes so UTF-16 stays aligned.
      const from = Math.max(0, window.length - OVERLAP_BYTES)
      tail = window.subarray(from - (from % 2))
    }

    if (keep) {
      const text = encoding ? decodeUtf16(keep, encoding) : keep.toString('utf8')
      const trimmed = text.replace(/^\uFEFF/, '').trim()
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const reason = jsonReason(JSON.parse(trimmed))
          if (reason) return { kind: 'generic', reason }
        } catch {
          // Not JSON.
        }
      }
    }

    return undefined
  } finally {
    await handle.close()
  }
}

const SCAN_CONCURRENCY = 8

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
  if (/^\.env/i.test(path.basename(file.name))) {
    return `${file.name} is an environment file, which usually holds secrets, and will not be published. Arweave uploads are permanent and public. Move it out of what you upload.`
  }

  if (scanner.wallets.length > 0) {
    const stats = await fs.promises.stat(file.fullPath, { bigint: true })
    const wallet = scanner.wallets.find(
      (entry) => entry.dev === stats.dev && entry.ino === stats.ino,
    )
    if (wallet) {
      return `${file.name} is the wallet file ${wallet.label} (a link to it). A wallet will not be published: Arweave uploads are permanent and public.`
    }
  }

  const finding = await scanFile(file.fullPath, scanner)
  if (finding?.kind === 'held') {
    return `${file.name} contains the private key of a wallet this command is using, and will not be published. Arweave uploads are permanent and public. Move the file out of what you upload.`
  }

  if (finding) {
    return `${file.name} looks like a private key (${finding.reason}) and will not be published. Arweave uploads are permanent and public. Move the file out of what you upload.`
  }

  return undefined
}
