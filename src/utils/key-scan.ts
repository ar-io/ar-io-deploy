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
import { Readable } from 'node:stream'
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

/**
 * Base64 and base64url needles for bytes stored at any alignment. Base64
 * works in groups of three bytes, so bytes that start one or two bytes into
 * a group encode differently; skipping the first group leaves characters
 * that depend on these bytes alone.
 */
function base64Needles(bytes: Buffer): string[] {
  const needles: string[] = []
  for (const offset of [0, 1, 2]) {
    const shifted = Buffer.concat([Buffer.alloc(offset), bytes.subarray(0, 33)])
    const start = offset === 0 ? 0 : 4
    for (const encoding of ['base64', 'base64url'] as const) {
      needles.push(shifted.toString(encoding).slice(start, start + 40))
    }
  }

  return needles
}

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
    ...base64Needles(bytes),
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

  // The file or string itself base64-encoded, as in a data: URI.
  if (trimmed.length >= 30) {
    text.push(...base64Needles(Buffer.from(trimmed)))
    if (trimmed.startsWith('[')) {
      try {
        text.push(...base64Needles(Buffer.from(JSON.stringify(JSON.parse(trimmed)))))
      } catch {
        // Not JSON.
      }
    }
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

/** True when text holds a needle as it is, with hex in lower or upper case. */
function holdsKeyVerbatim(view: string, scanner: KeyScanner): boolean {
  return (
    scanner.text.some((needle) => view.includes(needle)) ||
    scanner.hex.some((needle) => view.includes(needle) || view.includes(needle.toUpperCase()))
  )
}

/** `"abc" +` and a line break and `"def"`: a string split across lines in code. */
const CONCATENATION = /(["'`])\s*\+\s*\1/g
const WHITESPACE = /[\t\n\r ]+/g
const ESCAPED_WHITESPACE = /\\[nrt]/g
const UNICODE_ESCAPE = /\\u([\dA-Fa-f]{4})/g
const HEX_ESCAPE = /\\x([\dA-Fa-f]{2})/g
const PERCENT_ESCAPE = /%([\dA-Fa-f]{2})/g
/** What sits between the bytes of a hex list: `0x0c, 0x22`, `\x0c\x22`, `0c:22`. */
const HEX_SEPARATORS = /0x|\\x|[\s"',:[\]-]/g

const fromHex = (_: string, hex: string): string => String.fromCodePoint(Number.parseInt(hex, 16))

/** Escapes decoded and escaped line breaks removed, so a key written inside a string is plain. */
function unescape(flat: string): string {
  return flat
    .replaceAll(ESCAPED_WHITESPACE, '')
    .replaceAll(UNICODE_ESCAPE, fromHex)
    .replaceAll(HEX_ESCAPE, fromHex)
    .replaceAll(PERCENT_ESCAPE, fromHex)
}

/**
 * True when text holds a needle once whitespace, line breaks and string
 * concatenation are removed, once escapes are decoded, or, for hex, once the
 * separators of a byte list are removed and case is ignored.
 */
function holdsKey(view: string, scanner: KeyScanner): boolean {
  if (scanner.text.length === 0 && scanner.hex.length === 0) return false
  const flat = view.replaceAll(CONCATENATION, '').replaceAll(WHITESPACE, '')
  if (scanner.text.some((needle) => flat.includes(needle))) return true
  if (flat.includes('\\') || flat.includes('%')) {
    const decoded = unescape(flat)
    if (scanner.text.some((needle) => decoded.includes(needle))) return true
  }

  if (scanner.hex.length === 0) return false
  const hex = flat.toLowerCase().replaceAll(HEX_SEPARATORS, '')
  return scanner.hex.some((needle) => hex.includes(needle))
}

const B58 = '1-9A-HJ-NP-Za-km-z'
const BYTE = String.raw`\s*"?\d{1,3}(?:\.0+)?"?\s*`
const BYTE_ARRAY_64 = new RegExp(String.raw`\[(?:${BYTE},){63}${BYTE}\]`, 'g')
const BASE58_KEY = new RegExp(`^[${B58}]{86,88}$`)
const HEX_KEY = /^(?:0x)?[\dA-Fa-f]{128}$/
const JWK_D = /\\?["']d\\?["']\s*:\s*\\?["'][\w-]{40,}/g
/** A modulus of 2048 bits or more: at least 342 base64url characters. */
const JWK_N = /\\?["']n\\?["']\s*:\s*\\?["'][\w-]{340,}/
const BASE64_JSON = /eyJ[\w+/-]{100,}={0,2}/g
const PEM_PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/
/** Runs of printable text inside binary data. */
const PRINTABLE_RUN = /[\t\n\r -~]{40,}/g

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
 * True when a `d` field and an RSA-sized `n` field sit in the same flat
 * object. JWK values are base64url and hold no braces, so the object around
 * `d` runs from the nearest `{` before it to the nearest `}` after it.
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
  if (PEM_PRIVATE_KEY.test(text)) return 'a PEM private key'

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
const RSA_MODULUS = /^[\w-]{340,}$/

export type ScanFinding =
  | { kind: 'generic'; reason: string }
  | { kind: 'held' }
  | { kind: 'unchecked'; reason: string }

/**
 * Why a parsed JSON value holds a key, or undefined. Walks every depth, and
 * searches every string as text, so a key inside an escaped string (a source
 * map's `sourcesContent`) is found.
 */
function jsonFinding(value: unknown, scanner: KeyScanner, depth = 0): ScanFinding | undefined {
  if (depth > 64 || value === null) return undefined
  if (typeof value === 'string') {
    if (value.length < 40) return undefined
    if (holdsKey(value, scanner)) return { kind: 'held' }
    // Also with whitespace removed: a byte list folded across lines can split a number.
    const reason = textReason(value) ?? textReason(value.replaceAll(WHITESPACE, ''))
    if (reason) return { kind: 'generic', reason }
    if (/^\s*[[{]/.test(value)) {
      try {
        return jsonFinding(JSON.parse(value), scanner, depth + 1)
      } catch {
        return undefined
      }
    }

    return undefined
  }

  if (typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    if (isKeypairArray(value))
      return { kind: 'generic', reason: 'a Solana keypair as a byte array' }
    for (const entry of value) {
      const finding = jsonFinding(entry, scanner, depth + 1)
      if (finding) return finding
    }

    return undefined
  }

  const { d, n } = value as Record<string, unknown>
  if (
    typeof d === 'string' &&
    typeof n === 'string' &&
    BASE64URL_VALUE.test(d) &&
    RSA_MODULUS.test(n)
  ) {
    return { kind: 'generic', reason: 'a JWK private key' }
  }

  for (const entry of Object.values(value)) {
    const finding = jsonFinding(entry, scanner, depth + 1)
    if (finding) return finding
  }

  return undefined
}

const CHUNK_BYTES = 1024 * 1024
/** Longer than any single needle or pattern, so nothing is lost at a chunk edge. */
const OVERLAP_BYTES = 16 * 1024
/** JSON up to this size is also parsed and walked. */
const JSON_PARSE_MAX_BYTES = 32 * 1024 * 1024
/** The most a compressed file may expand to before it is refused as uncheckable. */
export const DECOMPRESSED_MAX_BYTES = 1024 * 1024 * 1024
/** The largest archive inside another that is held in memory to be read. */
const NESTED_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024
/** Archives inside archives are opened this many layers deep. */
const MAX_DEPTH = 3

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

    /*
     * A piece with zero bytes that is not UTF-16 is binary (an image, a
     * font, a wasm module). It is searched as it is, and its runs of
     * printable text get the full checks; running them over all of the
     * binary data would cost most of the scan.
     */
    if (!this.encoding && read.includes(0)) {
      if (holdsKeyVerbatim(views[0], this.scanner)) return { kind: 'held' }
      views[0] = [...views[0].matchAll(PRINTABLE_RUN)].map(([run]) => run).join('\n')
    }

    if (views.some((view) => holdsKey(view, this.scanner))) return { kind: 'held' }
    for (const view of views) {
      const reason = textReason(view)
      if (reason) return { kind: 'generic', reason }
    }

    return undefined
  }
}

/** Read access to a file or to bytes in memory, for archive formats that need it. */
interface Reader {
  read(offset: number, length: number): Promise<Buffer>
  size: number
  stream(start: number, end: number): Readable
}

function fileReader(handle: fs.promises.FileHandle, fullPath: string, size: number): Reader {
  return {
    async read(offset, length) {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)))
      await handle.read(buffer, 0, buffer.length, offset)
      return buffer
    },
    size,
    stream: (start, end) => fs.createReadStream(fullPath, { end, start }),
  }
}

function bufferReader(bytes: Buffer): Reader {
  return {
    read: async (offset, length) => bytes.subarray(offset, offset + length),
    size: bytes.length,
    stream: (start, end) => Readable.from([bytes.subarray(start, end + 1)]),
  }
}

type Container = 'brotli' | 'gzip' | 'tar' | 'zip' | { unsupported: string }

const SIGNATURES: Array<[string, Buffer]> = [
  ['7z', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
  ['RAR', Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])],
  ['xz', Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
  ['Zstandard', Buffer.from([0x28, 0xb5, 0x2f, 0xfd])],
  ['cabinet', Buffer.from([0x4d, 0x53, 0x43, 0x46, 0, 0, 0, 0])],
]
const BZIP2_BLOCK = Buffer.from([0x31, 0x41, 0x59, 0x26, 0x53, 0x59])
const BZIP2_END = Buffer.from([0x17, 0x72, 0x45, 0x38, 0x50, 0x90])

/** What kind of archive or compressed stream the bytes are, by signature; brotli by name. */
function sniff(head: Buffer, name: string): Container | undefined {
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip'
  if (head.readUInt32LE(0) === 0x04_03_4b_50) return 'zip'
  if (head.length >= 262 && head.toString('latin1', 257, 262) === 'ustar') return 'tar'
  for (const [format, signature] of SIGNATURES) {
    if (head.subarray(0, signature.length).equals(signature)) return { unsupported: format }
  }

  const bzip2 =
    head.toString('latin1', 0, 3) === 'BZh' &&
    head[3] >= 0x31 &&
    head[3] <= 0x39 &&
    (head.subarray(4, 10).equals(BZIP2_BLOCK) || head.subarray(4, 10).equals(BZIP2_END))
  if (bzip2) return { unsupported: 'bzip2' }
  if (/\.br$/i.test(name)) return 'brotli'
  return undefined
}

class TooLarge extends Error {}

interface Context {
  budget: { left: number; limit: number }
  scanner: KeyScanner
}

/** Count what a decompressed or archived stream yields against the budget. */
async function* counted(stream: Readable, context: Context): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer
      context.budget.left -= buffer.length
      if (context.budget.left < 0) throw new TooLarge()
      yield buffer
    }
  } finally {
    stream.destroy()
  }
}

async function* prepend(head: Buffer, rest: AsyncIterator<Buffer>): AsyncGenerator<Buffer> {
  if (head.length > 0) yield head
  for (let next = await rest.next(); !next.done; next = await rest.next()) yield next.value
}

/**
 * Search content that came out of an archive or a decompressor: look at its
 * first bytes, open it when it is itself an archive, and search it as a file
 * when it is not.
 */
async function searchContent(
  stream: Readable,
  name: string,
  context: Context,
  depth: number,
): Promise<ScanFinding | undefined> {
  const chunks = counted(stream, context)
  const iterator = chunks[Symbol.asyncIterator]()
  const headParts: Buffer[] = []
  let headBytes = 0
  while (headBytes < 1024) {
    const next = await iterator.next()
    if (next.done) break
    headParts.push(next.value)
    headBytes += next.value.length
  }

  const head = Buffer.concat(headParts)
  const container = head.length >= 4 ? sniff(head, name) : undefined
  if (container !== undefined) {
    if (typeof container === 'object') {
      return {
        kind: 'unchecked',
        reason: `${name} is a ${container.unsupported} archive, which this check cannot read`,
      }
    }

    if (depth >= MAX_DEPTH) {
      return { kind: 'unchecked', reason: `it holds archives nested more than ${MAX_DEPTH} deep` }
    }

    const content = Readable.from(prepend(head, iterator))
    if (container === 'gzip' || container === 'brotli') {
      const decompress = container === 'gzip' ? zlib.createGunzip() : zlib.createBrotliDecompress()
      return searchContent(
        content.pipe(decompress),
        name.replace(/\.(?:gz|tgz|br)$/i, ''),
        context,
        depth + 1,
      )
    }

    const parts: Buffer[] = []
    let total = 0
    for await (const part of content) {
      total += (part as Buffer).length
      if (total > NESTED_ARCHIVE_MAX_BYTES) {
        return {
          kind: 'unchecked',
          reason: `${name} inside it is larger than ${NESTED_ARCHIVE_MAX_BYTES} bytes`,
        }
      }

      parts.push(part as Buffer)
    }

    return searchArchive(bufferReader(Buffer.concat(parts)), container, context, depth + 1)
  }

  const search = new StreamSearch(context.scanner)
  const keep: Buffer[] | undefined = /^[[{]/.test(
    stripBom(head.toString('latin1', 0, 64)).trimStart(),
  )
    ? []
    : undefined
  let kept = 0
  let pending: Buffer[] = []
  let pendingBytes = 0
  const flush = (): ScanFinding | undefined => {
    if (pendingBytes === 0) return undefined
    const piece = Buffer.concat(pending)
    pending = []
    pendingBytes = 0
    return search.push(piece)
  }

  for await (const part of prepend(head, iterator)) {
    if (keep && kept + part.length <= JSON_PARSE_MAX_BYTES) {
      keep.push(part)
      kept += part.length
    }

    pending.push(part)
    pendingBytes += part.length
    if (pendingBytes >= CHUNK_BYTES) {
      const finding = flush()
      if (finding) return finding
    }
  }

  const finding = flush()
  if (finding) return finding
  return keep ? parsedJsonFinding(Buffer.concat(keep), context.scanner) : undefined
}

/** Parse bytes as JSON and walk them; undefined when they are not JSON. */
function parsedJsonFinding(bytes: Buffer, scanner: KeyScanner): ScanFinding | undefined {
  const encoding = detectUtf16(bytes)
  const text = stripBom(encoding ? decodeUtf16(bytes, encoding) : bytes.toString('utf8')).trim()
  if (!text.startsWith('[') && !text.startsWith('{')) return undefined
  try {
    return jsonFinding(JSON.parse(text), scanner)
  } catch {
    return undefined
  }
}

interface Member {
  name: string
  stream: () => Readable
}

/** The entries of a zip file from its central directory, or why they cannot be read. */
async function zipMembers(reader: Reader): Promise<Member[] | string> {
  const tailLength = Math.min(reader.size, 65_557)
  const tail = await reader.read(reader.size - tailLength, tailLength)
  let end = -1
  for (let i = tail.length - 22; i >= 0; i--) {
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

  if (directoryOffset + directorySize > reader.size) return 'it is not a readable zip file'
  const directory = await reader.read(directoryOffset, directorySize)

  const members: Member[] = []
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
    if (method !== 0 && method !== 8) {
      return `${name} inside it uses a compression method this check cannot read`
    }

    const local = await reader.read(localOffset, 30)
    if (local.length < 30 || local.readUInt32LE(0) !== 0x04_03_4b_50) {
      return 'it is not a readable zip file'
    }

    const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
    members.push({
      name,
      stream() {
        if (compressedSize === 0) return Readable.from([])
        const raw = reader.stream(dataStart, dataStart + compressedSize - 1)
        return method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw
      },
    })
  }

  return members
}

/** A tar number field: octal text, or base-256 when the high bit is set. */
function tarNumber(field: Buffer): number {
  if (field[0] >= 0x80) {
    let value = 0
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]
    return value
  }

  return Number.parseInt(field.toString('latin1').replaceAll(/[\0 ]/g, '') || '0', 8)
}

const cString = (field: Buffer): string => {
  const end = field.indexOf(0)
  return field.toString('utf8', 0, end < 0 ? field.length : end)
}

/** The regular files of a tar archive (ustar, pax and GNU long names). */
async function tarMembers(reader: Reader): Promise<Member[] | string> {
  const members: Member[] = []
  let offset = 0
  let longName: string | undefined
  while (offset + 512 <= reader.size) {
    const header = await reader.read(offset, 512)
    if (header.every((byte) => byte === 0)) break
    const size = tarNumber(header.subarray(124, 136))
    if (!Number.isFinite(size) || size < 0) return 'it is not a readable tar file'
    const type = String.fromCodePoint(header[156])
    const start = offset + 512
    offset = start + Math.ceil(size / 512) * 512

    if (type === 'L') {
      longName = cString(await reader.read(start, size))
      continue
    }

    const prefix = cString(header.subarray(345, 500))
    const name = longName ?? (prefix ? `${prefix}/` : '') + cString(header.subarray(0, 100))
    longName = undefined
    if (type !== '0' && type !== '\0' && type !== '7') continue
    members.push({
      name,
      stream: () => (size === 0 ? Readable.from([]) : reader.stream(start, start + size - 1)),
    })
  }

  return members
}

/** Search every member of a zip or tar archive, its name and its content. */
async function searchArchive(
  reader: Reader,
  kind: 'tar' | 'zip',
  context: Context,
  depth: number,
): Promise<ScanFinding | undefined> {
  const members = kind === 'zip' ? await zipMembers(reader) : await tarMembers(reader)
  if (typeof members === 'string') return { kind: 'unchecked', reason: members }
  for (const member of members) {
    if (nameHoldsKey(member.name, context.scanner)) return { kind: 'held' }
    const finding = await searchContent(member.stream(), member.name, context, depth)
    if (finding) return finding
  }

  return undefined
}

/** Turn a failure while opening an archive into a refusal: what cannot be read is not published. */
function uncheckable(error: unknown, budget: { limit: number }): ScanFinding {
  if (error instanceof TooLarge) {
    return { kind: 'unchecked', reason: `it expands to more than ${budget.limit} bytes` }
  }

  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'unchecked', reason: `it could not be decompressed (${message})` }
}

/**
 * Search one file. Reads it in chunks with an overlap, so a key anywhere in
 * a file of any size is found, then opens it when it is an archive or
 * compressed, and searches what is inside.
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
        head = Buffer.from(read.subarray(0, 1024))
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
      const finding = parsedJsonFinding(keep, scanner)
      if (finding) return finding
    }

    if (head.length < 4) return undefined
    const container = sniff(head, name)
    if (container === undefined) return undefined
    if (typeof container === 'object') {
      return {
        kind: 'unchecked',
        reason: `it is a ${container.unsupported} archive, which this check cannot read`,
      }
    }

    const limit = scanner.decompressedMaxBytes ?? DECOMPRESSED_MAX_BYTES
    const context: Context = { budget: { left: limit, limit }, scanner }
    try {
      if (container === 'zip' || container === 'tar') {
        return await searchArchive(fileReader(handle, fullPath, size), container, context, 1)
      }

      const decompress = container === 'gzip' ? zlib.createGunzip() : zlib.createBrotliDecompress()
      return await searchContent(
        fs.createReadStream(fullPath).pipe(decompress),
        name.replace(/\.(?:gz|tgz|br)$/i, ''),
        context,
        1,
      )
    } catch (error) {
      // Brotli has no signature: a .br file that does not decode is not brotli.
      if (container === 'brotli' && !(error instanceof TooLarge)) return undefined
      return uncheckable(error, context.budget)
    }
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

/**
 * An environment file: `.env`, `.env.local`, `prod.env`, `.ENV`. Scripts and
 * pages named like one (`env.js`, `env.html`) are runtime configuration
 * that sites publish on purpose, so they are left to the content checks.
 */
function isEnvironmentFile(name: string): boolean {
  const base = path.basename(name)
  return /(?:^|\.)env(?:\.|$)/i.test(base) && !/\.(?:c?js|mjs|ts|map|html?|css|json)$/i.test(base)
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

  if (isEnvironmentFile(file.name)) {
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
