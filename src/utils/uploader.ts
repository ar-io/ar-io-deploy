import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { OnDemandFunding } from '@ardrive/turbo-sdk'
import * as mime from 'mime-types'
import pLimit from 'p-limit'

import {
  getAllFiles,
  getCachedTransaction,
  hashFile,
  setCachedTransaction,
  touchCacheEntry,
  type TransactionCache,
} from './cache.js'
import {
  compress,
  type CompressionConfig,
  type ContentEncoding,
  shouldCompress,
} from './compression.js'
import type { UploadClient, UploadCost, UploadSize } from './upload-types.js'

type DataItemTag = { name: string; value: string }

/**
 * Provenance tags stamped on every uploaded data item. In CI (GitHub Actions)
 * the deploying commit SHA is attached as a GIT-HASH tag; locally, where
 * GITHUB_SHA is unset, it is omitted.
 */
export function provenanceTags(): DataItemTag[] {
  const tags: DataItemTag[] = [{ name: 'App-Name', value: 'ARIO-Deploy' }]
  if (process.env.GITHUB_SHA) {
    tags.push({ name: 'GIT-HASH', value: process.env.GITHUB_SHA })
  }

  return tags
}

export interface UploadResult {
  cacheHit: boolean
  cost?: UploadCost
  size?: UploadSize
  transactionId: string
  updatedCache?: TransactionCache
}

export interface FolderUploadResult extends UploadResult {
  /** Number of files that were cache hits (not re-uploaded) */
  cacheHits: number
  /** Number of files identical to another file in this run (sharing its upload) */
  duplicates: number
  /** Total number of files in the folder */
  totalFiles: number
  /** Number of files that were uploaded */
  uploaded: number
  /** Bytes sent for those files (after compression), excluding the manifest */
  uploadedBytes: number
}

export async function uploadFile(
  turbo: UploadClient,
  filePath: string,
  options?: {
    cache?: TransactionCache
    compression?: CompressionConfig
    fundingMode?: OnDemandFunding
  },
): Promise<UploadResult> {
  const mimeType = mime.lookup(filePath) || 'application/octet-stream'
  let encoding =
    options?.compression && shouldCompress(path.basename(filePath), options.compression)
      ? options.compression.encoding
      : undefined

  // Compute hash if cache is provided; compressed uploads get their own key
  const rawHash = options?.cache ? await hashFile(filePath) : undefined
  const fileHash = rawHash && encoding ? `${encoding}:${rawHash}` : rawHash

  // Check cache for hit
  if (fileHash && options?.cache) {
    const cached = getCachedTransaction(options.cache, fileHash)
    if (cached) {
      const updatedCache = touchCacheEntry(options.cache, fileHash)
      return {
        cacheHit: true,
        transactionId: cached.transactionId,
        updatedCache,
      }
    }
  }

  let compressed: Buffer | undefined
  if (encoding) {
    const raw = fs.readFileSync(filePath)
    compressed = await compress(raw, encoding)
    // Tiny files can grow; upload those as-is, without the encoding tag.
    if (compressed.length >= raw.length) {
      compressed = undefined
      encoding = undefined
    }
  }

  const body = compressed

  // Upload file
  const uploadResult = await turbo.uploadFile({
    dataItemOpts: {
      tags: [
        ...provenanceTags(),
        {
          name: 'anchor',
          value: new Date().toISOString(),
        },
        {
          name: 'Content-Type',
          value: mimeType,
        },
        ...(body && encoding ? [{ name: 'Content-Encoding', value: encoding }] : []),
      ],
    },
    ...(body
      ? { fileSizeFactory: () => body.length, fileStreamFactory: () => Readable.from(body) }
      : { file: filePath }),
    ...(options?.fundingMode && { fundingMode: options.fundingMode }),
  })

  if (!uploadResult?.id) {
    throw new Error('Failed to upload file: upload result missing transaction ID')
  }

  // Store in cache if provided
  if (fileHash && options?.cache) {
    const updatedCache = setCachedTransaction(options.cache, fileHash, uploadResult.id)
    return {
      cacheHit: false,
      cost: uploadResult.cost,
      size: uploadResult.size,
      transactionId: uploadResult.id,
      updatedCache,
    }
  }

  return {
    cacheHit: false,
    cost: uploadResult.cost,
    size: uploadResult.size,
    transactionId: uploadResult.id,
  }
}

/** Default concurrency for parallel file uploads */
const DEFAULT_UPLOAD_CONCURRENCY = 10

/** Length of an Arweave transaction ID, used to estimate the manifest size. */
const TRANSACTION_ID_LENGTH = 43

export interface PlannedFile {
  /** Compressed bytes to upload, when compression applies and actually helps. */
  body?: Buffer
  /** Dedupe-cache key: the file's SHA-256, prefixed with the encoding when compressed. */
  cacheKey: string
  cached?: { transactionId: string }
  /**
   * Relative path of an identical file earlier in this run. The file is not
   * uploaded; it shares that file's transaction.
   */
  duplicateOf?: string
  encoding?: ContentEncoding
  fullPath: string
  relativePath: string
  /** Bytes this file adds to the upload: 0 when cached or a duplicate. */
  uploadBytes: number
}

export interface FolderUploadPlan {
  /** Updated dedupe cache (cache hits touched), or undefined when dedupe is off. */
  cache?: TransactionCache
  cacheHits: number
  duplicates: number
  files: PlannedFile[]
  /** Estimated size of the manifest, which is always uploaded. */
  manifestBytes: number
  /** Total bytes that uploading this plan will send, excluding the manifest. */
  uploadBytes: number
}

/**
 * Work out what uploading a folder will actually send, without uploading.
 *
 * - Files whose content is in the dedupe cache reuse their transaction.
 * - Files identical to another file in this run share one upload, so e.g. a
 *   static export that writes the same payload under two names pays once.
 * - With `compression`, eligible files are compressed; the cache key includes
 *   the encoding so compressed and uncompressed uploads never mix.
 *
 * `uploadBytes` is what the credit check should price.
 */
export async function planFolderUpload(
  folderPath: string,
  options?: {
    cache?: TransactionCache
    compression?: CompressionConfig
    concurrency?: number
  },
): Promise<FolderUploadPlan> {
  const useCache = options?.cache !== undefined
  const compression = options?.compression

  const relativePaths = getAllFiles(folderPath)

  if (relativePaths.length === 0) {
    throw new Error('Folder is empty, nothing to upload')
  }

  const files: PlannedFile[] = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const fullPath = path.join(folderPath, relativePath)
      const encoding =
        compression && shouldCompress(relativePath, compression) ? compression.encoding : undefined
      const hash = useCache ? await hashFile(fullPath) : ''
      const cacheKey = hash && encoding ? `${encoding}:${hash}` : hash
      return { cacheKey, encoding, fullPath, relativePath, uploadBytes: 0 }
    }),
  )

  let cache = options?.cache
  let cacheHits = 0
  let duplicates = 0
  const firstUpload = new Map<string, PlannedFile>()

  for (const file of files) {
    if (!cache || !file.cacheKey) continue

    const cached = getCachedTransaction(cache, file.cacheKey)
    if (cached) {
      file.cached = { transactionId: cached.transactionId }
      cache = touchCacheEntry(cache, file.cacheKey)
      cacheHits++
      continue
    }

    // Share only between files that would also get the same Content-Type
    // tag: identical bytes named data.json and data.txt must stay separate.
    const shareKey = `${mime.lookup(file.fullPath) || ''}|${file.cacheKey}`
    const first = firstUpload.get(shareKey)
    if (first) {
      file.duplicateOf = first.relativePath
      duplicates++
    } else {
      firstUpload.set(shareKey, file)
    }
  }

  // Size (and compress) only the files that will actually be uploaded.
  const toUpload = files.filter((file) => !file.cached && !file.duplicateOf)
  const limit = pLimit(options?.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY)

  await Promise.all(
    toUpload.map((file) =>
      limit(async () => {
        if (!file.encoding) {
          file.uploadBytes = fs.statSync(file.fullPath).size
          return
        }

        const raw = fs.readFileSync(file.fullPath)
        const compressed = await compress(raw, file.encoding)

        // Tiny files can grow; upload those as-is, without the encoding tag.
        if (compressed.length < raw.length) {
          file.body = compressed
          file.uploadBytes = compressed.length
        } else {
          file.encoding = undefined
          file.uploadBytes = raw.length
        }
      }),
    ),
  )

  return {
    cache,
    cacheHits,
    duplicates,
    files,
    manifestBytes: estimateManifestBytes(relativePaths),
    uploadBytes: toUpload.reduce((sum, file) => sum + file.uploadBytes, 0),
  }
}

/** Manifest paths for a set of files: each file, plus `dir` for every `dir/index.html`. */
function manifestPathKeys(relativePath: string): string[] {
  return relativePath.endsWith('/index.html')
    ? [relativePath, relativePath.replace(/\/index\.html$/, '')]
    : [relativePath]
}

function estimateManifestBytes(relativePaths: string[]): number {
  const placeholder = { id: 'x'.repeat(TRANSACTION_ID_LENGTH) }
  const paths = Object.fromEntries(
    relativePaths
      .flatMap((relativePath) => manifestPathKeys(relativePath))
      .map((key) => [key, placeholder]),
  )
  const manifest = {
    fallback: placeholder,
    index: { path: 'index.html' },
    manifest: 'arweave/paths',
    paths,
    version: '0.2.0',
  }
  return Buffer.byteLength(JSON.stringify(manifest))
}

/**
 * Upload a folder with per-file deduplication.
 * Each file is checked against the cache individually, identical files in the
 * same run are uploaded once, and only what is left is uploaded (compressed,
 * when `compression` is set). A manifest is then constructed and uploaded to
 * create the folder structure.
 *
 * @param turbo - Upload client used for file and manifest uploads.
 * @param folderPath - Folder to upload.
 * @param options - Upload options for caching, compression, concurrency, funding, and failure handling.
 * @returns Folder upload result including manifest transaction ID and cache stats.
 */
export async function uploadFolder(
  turbo: UploadClient,
  folderPath: string,
  options?: {
    cache?: TransactionCache
    compression?: CompressionConfig
    concurrency?: number
    /**
     * Path, relative to the folder, whose transaction becomes the manifest's
     * `fallback` — what a gateway serves for a path the manifest does not
     * list. Defaults to `404.html` when present.
     */
    fallbackFile?: string
    fundingMode?: OnDemandFunding
    /** A plan from `planFolderUpload`, reused instead of planning again. */
    plan?: FolderUploadPlan
    throwOnFailure?: boolean
  },
): Promise<FolderUploadResult> {
  const concurrency = options?.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY

  const plan =
    options?.plan ??
    (await planFolderUpload(folderPath, {
      cache: options?.cache,
      compression: options?.compression,
      concurrency,
    }))
  const { cacheHits, duplicates, files } = plan
  const relativePaths = new Set(files.map((file) => file.relativePath))

  /*
   * Validate before uploading anything: every check below this point happens
   * after files have been paid for, and a mistyped fallback should cost
   * nothing.
   */
  if (options?.fallbackFile !== undefined && !relativePaths.has(options.fallbackFile)) {
    throw new Error(
      `Fallback file not found in folder: ${options.fallbackFile}. ` +
        `It must be a path relative to the deploy folder, e.g. "404.html".`,
    )
  }

  const useCache = plan.cache !== undefined
  let cache = plan.cache ?? {}

  // If all files are cached, we still need to build and upload a new manifest
  // (because the manifest itself has a unique transaction ID each time)
  const toUpload = files.filter((file) => !file.cached && !file.duplicateOf)

  // Upload with concurrency control using p-limit
  const limit = pLimit(concurrency)

  const uploadResults = await Promise.all(
    toUpload.map((file) =>
      limit(async () => {
        const mimeType = mime.lookup(file.fullPath) || 'application/octet-stream'
        const tags = [...provenanceTags(), { name: 'Content-Type', value: mimeType }]
        const { body } = file

        const uploadResult = await turbo.uploadFile({
          dataItemOpts: {
            tags:
              body && file.encoding
                ? [...tags, { name: 'Content-Encoding', value: file.encoding }]
                : tags,
          },
          ...(body
            ? { fileSizeFactory: () => body.length, fileStreamFactory: () => Readable.from(body) }
            : { file: file.fullPath }),
          ...(options?.fundingMode && { fundingMode: options.fundingMode }),
        })

        if (!uploadResult?.id) {
          if (options?.throwOnFailure) {
            throw new Error(`Failed to upload file: ${file.relativePath}`)
          }

          return { file, transactionId: null }
        }

        return { file, transactionId: uploadResult.id }
      }),
    ),
  )

  // Update cache with all successful uploads (done sequentially to avoid race conditions)
  const uploadedIds = new Map<string, string>()
  for (const result of uploadResults) {
    if (!result.transactionId) continue

    uploadedIds.set(result.file.relativePath, result.transactionId)
    if (useCache && result.file.cacheKey) {
      cache = setCachedTransaction(cache, result.file.cacheKey, result.transactionId)
    }
  }

  // Check for any failed uploads
  const failedUploads = uploadResults.filter((r) => r.transactionId === null)
  if (failedUploads.length > 0 && options?.throwOnFailure) {
    throw new Error(
      `Failed to upload ${failedUploads.length} file(s): ${failedUploads.map((f) => f.file.relativePath).join(', ')}`,
    )
  }

  // Build manifest paths from cached, shared and newly uploaded files
  const manifestPaths: Record<string, { id: string }> = {}

  for (const file of files) {
    const transactionId =
      file.cached?.transactionId ?? uploadedIds.get(file.duplicateOf ?? file.relativePath)

    if (transactionId) {
      // Directory index support: dir/index.html is also served at dir
      for (const key of manifestPathKeys(file.relativePath)) {
        manifestPaths[key] = { id: transactionId }
      }
    }
  }

  // Determine the index path (root index.html)
  const indexPath = relativePaths.has('index.html') ? 'index.html' : undefined

  /*
   * Determine the fallback — the transaction a gateway serves for any path the
   * manifest does not list.
   *
   * Without one, an `arweave/paths` manifest 404s every route that is not a
   * real file, which breaks deep links into any single-page app: the root
   * loads and `/settings` does not. An explicit `fallbackFile` wins; otherwise
   * `404.html` is used when the build emits one, matching the convention
   * static hosts already use.
   *
   * Note the shape: `fallback` takes an `{ id }`, not the `{ path }` that
   * `index` takes. The v0.2.0 spec differs between the two.
   */
  const fallbackPath =
    options?.fallbackFile ?? (relativePaths.has('404.html') ? '404.html' : undefined)

  const fallbackId = fallbackPath ? manifestPaths[fallbackPath]?.id : undefined

  // Build the manifest
  const manifest = {
    manifest: 'arweave/paths',
    version: '0.2.0',
    ...(indexPath && { index: { path: indexPath } }),
    ...(fallbackId && { fallback: { id: fallbackId } }),
    paths: manifestPaths,
  }

  // Upload the manifest
  const manifestBuffer = Buffer.from(JSON.stringify(manifest))
  const manifestUploadResult = await turbo.uploadFile({
    dataItemOpts: {
      tags: [
        ...provenanceTags(),
        { name: 'Content-Type', value: 'application/x.arweave-manifest+json' },
        { name: 'Device', value: 'manifest@1.0' },
      ],
    },
    fileSizeFactory: () => manifestBuffer.length,
    fileStreamFactory: () => Readable.from(manifestBuffer),
    ...(options?.fundingMode && { fundingMode: options.fundingMode }),
  })

  if (!manifestUploadResult?.id) {
    throw new Error('Failed to upload manifest: upload result missing transaction ID')
  }

  return {
    cacheHit: cacheHits === files.length,
    cacheHits,
    duplicates,
    totalFiles: files.length,
    transactionId: manifestUploadResult.id,
    updatedCache: useCache ? cache : undefined,
    uploaded: toUpload.length - failedUploads.length,
    uploadedBytes: plan.uploadBytes,
  }
}
