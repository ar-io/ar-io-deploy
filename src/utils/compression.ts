import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

const gzip = promisify(zlib.gzip)
const brotliCompress = promisify(zlib.brotliCompress)

export const CONTENT_ENCODINGS = ['gzip', 'br'] as const
export type ContentEncoding = (typeof CONTENT_ENCODINGS)[number]

export interface CompressionConfig {
  encoding: ContentEncoding
  /** Paths (relative to the deploy folder, `/`-separated) to upload uncompressed. */
  exclude: RegExp[]
}

/**
 * Formats that are already compressed. Compressing them again saves nothing
 * and would only cost CPU, so they are always uploaded as-is.
 */
const PRECOMPRESSED_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.br',
  '.bz2',
  '.gif',
  '.gz',
  '.heic',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.mp3',
  '.mp4',
  '.ogg',
  '.opus',
  '.png',
  '.rar',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.xz',
  '.zip',
  '.zst',
])

/**
 * Convert a glob to a RegExp matched against a `/`-separated relative path.
 *
 * Supports `**` (any number of directories), `*` (anything but `/`) and `?`.
 * A pattern without a `/` matches the file name in any directory, as in
 * `.gitignore`: `llms*.txt` matches both `llms.txt` and `sdks/x/llms.txt`.
 */
export function globToRegExp(glob: string): RegExp {
  const anyDirectory = !glob.includes('/')
  let source = ''

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]

    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replaceAll(/[$()+.[\\\]^{|}]/g, String.raw`\$&`)
    }
  }

  return new RegExp(anyDirectory ? `(?:^|/)${source}$` : `^${source}$`)
}

export function parseCompressionConfig(
  encoding?: string,
  exclude?: string,
): CompressionConfig | undefined {
  if (!encoding || encoding === 'none') return undefined

  if (!CONTENT_ENCODINGS.includes(encoding as ContentEncoding)) {
    throw new Error(
      `Unsupported compression: ${encoding}. Use one of: ${CONTENT_ENCODINGS.join(', ')}, none.`,
    )
  }

  const patterns = (exclude ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)

  return {
    encoding: encoding as ContentEncoding,
    exclude: patterns.map((pattern) => globToRegExp(pattern)),
  }
}

export function shouldCompress(relativePath: string, config: CompressionConfig): boolean {
  if (PRECOMPRESSED_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) return false
  return !config.exclude.some((pattern) => pattern.test(relativePath))
}

/**
 * Compress `data` with the given encoding.
 *
 * Settings are fixed, so repeat runs on one machine yield the same bytes.
 * (gzip records the OS in its header, so output can differ across
 * platforms.) Deduplication does not depend on this: the cache keys on the
 * original file's hash plus the encoding.
 */
export async function compress(data: Buffer, encoding: ContentEncoding): Promise<Buffer> {
  if (encoding === 'gzip') {
    return gzip(data, { level: zlib.constants.Z_BEST_COMPRESSION })
  }

  return brotliCompress(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  })
}
