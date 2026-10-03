import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { CACHE_DIR, CACHE_FILE } from '../constants/cache.js'
import { ARWEAVE_TX_ID_REGEX } from './constants.js'

export interface TransactionCacheEntry {
  createdAtTimestamp: number
  lastUsedTimestamp: number
  transactionId: string
}

export type TransactionCache = Record<string, TransactionCacheEntry>

/**
 * Get the path to the cache file in the current working directory.
 *
 * @param scope - Which Turbo network the ids belong to. Production uses the
 *   historic file; any other network (the development sandbox, a self-hosted
 *   bundler) gets its own, because an id from one network can point at data
 *   the other's gateways never serve.
 */
export function getCachePath(scope?: string): string {
  const file = scope ? CACHE_FILE.replace(/\.json$/, `.${scope}.json`) : CACHE_FILE
  return path.join(process.cwd(), CACHE_DIR, file)
}

/**
 * Load the transaction cache from disk.
 *
 * Returns an empty cache if the file is missing or unparseable, and drops any
 * entry whose id is not a well-formed Arweave id: a manifest built from one
 * would silently omit the file.
 */
export function loadCache(scope?: string): TransactionCache {
  const cachePath = getCachePath(scope)

  try {
    if (!fs.existsSync(cachePath)) {
      return {}
    }

    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, entry]) =>
          typeof entry === 'object' &&
          entry !== null &&
          ARWEAVE_TX_ID_REGEX.test(String((entry as TransactionCacheEntry).transactionId)),
      ),
    ) as TransactionCache
  } catch {
    // If the cache is corrupted or unreadable, start fresh
    return {}
  }
}

/**
 * Save the transaction cache to disk
 * Creates the cache directory if it doesn't exist
 *
 * Written to a sibling temp file and renamed into place. `loadCache` treats an
 * unparseable file as an empty one, so a process interrupted mid-write would
 * otherwise discard every transaction id it had already paid for — silently,
 * and precisely when the cache matters most. `renameSync` is atomic within a
 * directory on both POSIX and Windows.
 */
export function saveCache(cache: TransactionCache, scope?: string): void {
  const cachePath = getCachePath(scope)
  const cacheDir = path.dirname(cachePath)

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
  }

  const tempPath = `${cachePath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tempPath, JSON.stringify(cache, null, 2), 'utf8')
    fs.renameSync(tempPath, cachePath)
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
      // The temp file is already gone, or unremovable; the original stands.
    }

    throw error
  }
}

/**
 * Compute the SHA-256 hash of a file using streaming
 */
export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)

    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Recursively get all files in a directory.
 *
 * Returns paths relative to the base directory, always separated by `/`.
 * `path.relative` yields backslashes on Windows, and these strings become
 * manifest keys — a gateway looks up `assets/app.js`, so a manifest written
 * as `assets\app.js` 404s every nested asset. Normalizing here also keeps
 * the `dir/index.html` directory-index check working on every platform.
 *
 * Symlinks are followed only while they stay inside the folder. A link out of
 * it (to `~/.ssh`, say) would publish that file permanently and publicly, so
 * it is refused before anything is uploaded.
 */
export function getAllFiles(dirPath: string, basePath: string = dirPath): string[] {
  const files: string[] = []
  const root = fs.realpathSync(basePath)

  for (const item of fs.readdirSync(dirPath)) {
    const fullPath = path.join(dirPath, item)
    const stats = fs.statSync(fullPath)

    if (fs.lstatSync(fullPath).isSymbolicLink()) {
      const target = fs.realpathSync(fullPath)
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(
          `${path.relative(basePath, fullPath)} links outside the deploy folder (to ${target}); refusing to publish it. Remove the link or copy the file in.`,
        )
      }
    }

    if (stats.isDirectory()) {
      files.push(...getAllFiles(fullPath, basePath))
    } else {
      // Store relative path for consistent hashing
      files.push(path.relative(basePath, fullPath).split(path.sep).join('/'))
    }
  }

  return files
}

/**
 * Get a cached transaction entry by its file hash
 */
export function getCachedTransaction(
  cache: TransactionCache,
  hash: string,
): TransactionCacheEntry | undefined {
  return cache[hash]
}

/**
 * Add or update a cache entry for a file hash
 * Updates lastUsedTimestamp if the entry already exists
 */
export function setCachedTransaction(
  cache: TransactionCache,
  hash: string,
  transactionId: string,
): TransactionCache {
  const now = Date.now()
  const existing = cache[hash]

  return {
    ...cache,
    [hash]: {
      createdAtTimestamp: existing?.createdAtTimestamp ?? now,
      lastUsedTimestamp: now,
      transactionId,
    },
  }
}

/**
 * Update the lastUsedTimestamp for an existing cache entry
 */
export function touchCacheEntry(cache: TransactionCache, hash: string): TransactionCache {
  const existing = cache[hash]
  if (!existing) {
    return cache
  }

  return {
    ...cache,
    [hash]: {
      ...existing,
      lastUsedTimestamp: Date.now(),
    },
  }
}

/**
 * Clean up the cache by keeping only the most recently used entries
 * Entries are sorted by lastUsedTimestamp descending, keeping the newest maxEntries
 */
export function cleanupCache(cache: TransactionCache, maxEntries: number): TransactionCache {
  const entries = Object.entries(cache)

  if (entries.length <= maxEntries) {
    return cache
  }

  // Sort by lastUsedTimestamp descending (newest first)
  const sorted = entries.sort(([, a], [, b]) => b.lastUsedTimestamp - a.lastUsedTimestamp)

  // Keep only the newest maxEntries
  const kept = sorted.slice(0, maxEntries)

  return Object.fromEntries(kept)
}
