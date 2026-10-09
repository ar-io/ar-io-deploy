import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import * as mime from 'mime-types'
import pLimit from 'p-limit'

import { APP_NAME, FILE_HASH_TAG } from '../constants/incremental.js'
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
import {
  assertDeployInvariantTags,
  type ChainIndex,
  type DataItemTag,
  type FileIdentity,
  incrementalCacheKey,
  isArweaveId,
} from './incremental.js'
import { assertNoPrivateKeys, type KeyScanner } from './key-scan.js'
import type { UploadClient } from './upload-types.js'

/**
 * Provenance tags stamped on every uploaded data item. In CI (GitHub Actions)
 * the deploying commit SHA is attached as a GIT-HASH tag; locally, where
 * GITHUB_SHA is unset, it is omitted.
 */
export function provenanceTags(): DataItemTag[] {
  const tags: DataItemTag[] = [{ name: 'App-Name', value: APP_NAME }]
  if (process.env.GITHUB_SHA) {
    tags.push({ name: 'GIT-HASH', value: process.env.GITHUB_SHA })
  }

  return tags
}

/**
 * Tags for one file in incremental mode.
 *
 * Deliberately *not* `provenanceTags()`: a data item's id covers its tags, so
 * the commit SHA that changes every deploy would move every file's id and
 * defeat deduplication — silently, since the upload still succeeds and only
 * the bill notices. Provenance still rides on the manifest, which is rewritten
 * every deploy regardless.
 *
 * `Content-Encoding` is allowed: it is decided by the deploy's configuration,
 * not by the deploy, so identical bytes uploaded with the same settings still
 * get identical tags. It is also what lets the chain index tell a compressed
 * upload from an uncompressed one of the same file.
 *
 * `assertDeployInvariantTags` guards the set on every call, so a future tag
 * added here fails loudly instead of doubling users' costs.
 *
 * @param contentHash - SHA-256 of the file as it is on disk (before any
 *   compression), published so a later run can find this upload again with no
 *   local state.
 * @param mimeType - Content type served for the file.
 * @param encoding - Content-Encoding the uploaded bytes carry, if compressed.
 * @returns The deploy-invariant tag set for the file.
 */
export function incrementalFileTags(
  contentHash: string,
  mimeType: string,
  encoding?: ContentEncoding,
): DataItemTag[] {
  const tags: DataItemTag[] = [
    { name: 'App-Name', value: APP_NAME },
    { name: 'Content-Type', value: mimeType },
    { name: FILE_HASH_TAG, value: contentHash },
    ...(encoding ? [{ name: 'Content-Encoding', value: encoding }] : []),
  ]

  assertDeployInvariantTags(tags)

  return tags
}

export interface IncrementalOptions {
  /**
   * Chain-backed index consulted for hashes the local cache does not know.
   * Omitted (or failing) simply means fewer reuses, never a wrong manifest.
   */
  index?: ChainIndex
  /**
   * Called with the updated cache after every single upload.
   *
   * An upload that is paid for but forgotten is money burnt, and a deploy
   * killed part-way through is the normal case, not the exceptional one.
   */
  onCacheUpdate?: (cache: TransactionCache) => void
  /** Surfaced when the chain index cannot be reached. */
  onWarning?: (message: string) => void
}

export interface UploadResult {
  cacheHit: boolean
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
}

/**
 * The bytes to upload for one file, and the encoding they carry.
 *
 * Eligible files are always compressed, even the rare tiny one gzip makes a
 * few bytes larger. The encoding is part of the file's cache key and, in
 * incremental mode, of the tags the chain index matches on; uploading some
 * "compressed" files uncompressed would make them unfindable on a fresh
 * machine and re-upload them on every deploy.
 */
async function encodeForUpload(
  filePath: string,
  encoding: ContentEncoding | undefined,
): Promise<{ body?: Buffer; size: number }> {
  if (!encoding) {
    return { size: fs.statSync(filePath).size }
  }

  const body = await compress(fs.readFileSync(filePath), encoding)
  return { body, size: body.length }
}

/** SHA-256 of zero bytes, which every empty file shares whatever its type. */
const EMPTY_FILE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/**
 * Key a file's upload is remembered under: content hash, content type and,
 * when compressed, encoding. The type is part of the key because identical
 * bytes served as two types are two different uploads (see
 * `incrementalCacheKey`).
 */
export function fileCacheKey(hash: string, contentType: string, encoding?: string): string {
  return incrementalCacheKey(hash, contentType, encoding)
}

/**
 * Find a reusable upload for a file in the local cache.
 *
 * Caches written before 2.0 keyed uploads by hash alone (`<hash>`, or
 * `<encoding>:<hash>`). Outside incremental mode those entries are still
 * honoured, so upgrading does not re-upload a whole site; the typed key is
 * then written alongside. The one exception is the empty file: its hash is
 * shared by every empty file of every type, so a hash-only entry for it says
 * nothing about which Content-Type was uploaded.
 *
 * @returns The id and the cache with the entry touched (and migrated), or
 *   undefined on a miss.
 */
function lookupCachedUpload(
  cache: TransactionCache,
  file: { cacheKey: string; encoding?: string; hash: string },
  allowLegacy: boolean,
): { cache: TransactionCache; transactionId: string } | undefined {
  const typed = getCachedTransaction(cache, file.cacheKey)
  if (typed && isArweaveId(typed.transactionId)) {
    return { cache: touchCacheEntry(cache, file.cacheKey), transactionId: typed.transactionId }
  }

  if (!allowLegacy || file.hash === EMPTY_FILE_SHA256) {
    return undefined
  }

  const legacyKey = file.encoding ? `${file.encoding}:${file.hash}` : file.hash
  const legacy = getCachedTransaction(cache, legacyKey)
  if (legacy && isArweaveId(legacy.transactionId)) {
    return {
      cache: setCachedTransaction(cache, file.cacheKey, legacy.transactionId),
      transactionId: legacy.transactionId,
    }
  }

  return undefined
}

/** Everything decided about a single-file upload before it is paid for. */
export interface FileUploadPlan {
  /** Compressed bytes to upload, when compression applies. */
  body?: Buffer
  /** The cache, touched or migrated on a hit. Undefined when caching is off. */
  cache?: TransactionCache
  cacheKey: string
  /** Set when the file is already on Arweave and nothing will be uploaded. */
  cached?: { transactionId: string }
  contentType: string
  encoding?: ContentEncoding
  fullPath: string
  /** Bytes the upload will send: 0 on a cache hit. */
  uploadBytes: number
}

/** A folder's files, relative and `/`-separated, and the `.git` folders left out. */
export interface ListedFolder {
  relativePaths: string[]
  skipped: string[]
}

/** List a folder once, for the key search and the plan to share. */
export function listFolder(folderPath: string): ListedFolder {
  const skipped: string[] = []
  return { relativePaths: getAllFiles(folderPath, folderPath, skipped), skipped }
}

/**
 * Work out what uploading one file will send, without uploading: hash it,
 * check the cache, and compress it if it will be sent. Pricing this plan, not
 * the file on disk, means a cached file is never paid for again.
 */
export async function planFileUpload(
  filePath: string,
  options?: {
    cache?: TransactionCache
    compression?: CompressionConfig
    keyScanner?: false | KeyScanner
  },
): Promise<FileUploadPlan> {
  if (options?.keyScanner !== false) {
    await assertNoPrivateKeys([{ fullPath: filePath, name: filePath }], options?.keyScanner)
  }

  const contentType = mime.lookup(filePath) || 'application/octet-stream'
  const encoding =
    options?.compression && shouldCompress(path.basename(filePath), options.compression)
      ? options.compression.encoding
      : undefined

  if (!options?.cache) {
    const { body, size } = await encodeForUpload(filePath, encoding)
    return { body, cacheKey: '', contentType, encoding, fullPath: filePath, uploadBytes: size }
  }

  const hash = await hashFile(filePath)
  const cacheKey = fileCacheKey(hash, contentType, encoding)
  const hit = lookupCachedUpload(options.cache, { cacheKey, encoding, hash }, true)
  if (hit) {
    return {
      cache: hit.cache,
      cacheKey,
      cached: { transactionId: hit.transactionId },
      contentType,
      encoding,
      fullPath: filePath,
      uploadBytes: 0,
    }
  }

  const { body, size } = await encodeForUpload(filePath, encoding)
  return {
    body,
    cache: options.cache,
    cacheKey,
    contentType,
    encoding,
    fullPath: filePath,
    uploadBytes: size,
  }
}

/**
 * Upload one file from its plan, or reuse the cached upload the plan found.
 *
 * @param turbo - Upload client.
 * @param plan - From `planFileUpload`.
 * @param options - Payers for the data item.
 */
export async function uploadFile(
  turbo: UploadClient,
  plan: FileUploadPlan,
  options?: {
    /** Payers for the data item: credit-share approvals the bundler may spend. */
    paidBy?: string[]
  },
): Promise<UploadResult> {
  if (plan.cached) {
    return { cacheHit: true, transactionId: plan.cached.transactionId, updatedCache: plan.cache }
  }

  const { body } = plan
  const uploadResult = await turbo.uploadFile({
    dataItemOpts: {
      tags: [
        ...provenanceTags(),
        { name: 'Content-Type', value: plan.contentType },
        ...(plan.encoding ? [{ name: 'Content-Encoding', value: plan.encoding }] : []),
      ],
      ...(options?.paidBy && { paidBy: options.paidBy }),
    },
    ...(body
      ? { fileSizeFactory: () => body.length, fileStreamFactory: () => Readable.from(body) }
      : { file: plan.fullPath }),
  })

  if (!uploadResult?.id) {
    throw new Error('Failed to upload file: upload result missing transaction ID')
  }

  return {
    cacheHit: false,
    transactionId: uploadResult.id,
    updatedCache:
      plan.cache && plan.cacheKey
        ? setCachedTransaction(plan.cache, plan.cacheKey, uploadResult.id)
        : undefined,
  }
}

/** Default concurrency for parallel file uploads */
const DEFAULT_UPLOAD_CONCURRENCY = 10

/** Length of an Arweave transaction ID, used to estimate the manifest size. */
const TRANSACTION_ID_LENGTH = 43

export interface PlannedFile {
  /** Compressed bytes to upload, when compression applies. */
  body?: Buffer
  /**
   * Key this file is remembered under, empty when nothing is being cached.
   *
   * Outside incremental mode: the SHA-256, prefixed with the encoding when
   * compressed (`gzip:<hash>`) -- the historic format, so existing caches stay
   * valid. Inside it: hash + content type (+ encoding), so byte-identical files
   * served under different types, or with different encodings, can never
   * collapse onto one upload.
   */
  cacheKey: string
  cached?: { transactionId: string }
  contentType: string
  /**
   * Relative path of an identical file earlier in this run. The file is not
   * uploaded; it shares that file's transaction.
   */
  duplicateOf?: string
  encoding?: ContentEncoding
  fullPath: string
  /** SHA-256 of the file on disk, empty when nothing needed it. */
  hash: string
  relativePath: string
  /** Bytes this file adds to the upload: 0 when cached or a duplicate. */
  uploadBytes: number
}

/**
 * Everything decided about a folder upload before any of it is paid for.
 *
 * Single use: `uploadFolder` uploads whatever the plan says is missing, so
 * handing the same plan to a second call uploads those files again.
 */
export interface FolderUploadPlan {
  /**
   * The cache, touched for every hit and enriched with anything the chain
   * index recovered. Undefined when neither a cache nor incremental mode is in
   * play.
   */
  cache?: TransactionCache
  /** Files already on Arweave: local cache hits plus chain-index recoveries. */
  cacheHits: number
  duplicates: number
  files: PlannedFile[]
  /** Estimated size of the manifest, which is always uploaded. */
  manifestBytes: number
  /** Of `cacheHits`, how many the chain index recovered. */
  recovered: number
  /** Folders left out of the upload (`.git`), relative to the deploy folder. */
  skipped: string[]
  /**
   * Total bytes that uploading this plan will send, excluding the manifest.
   * This is what the credit check prices, so a redeploy of two changed chunks
   * is not refused for want of credits for the whole folder.
   */
  uploadBytes: number
}

/**
 * Work out what uploading a folder will actually send, without uploading.
 *
 * - Files whose content is in the dedupe cache reuse their transaction.
 * - In incremental mode, files the local cache does not know are looked up
 *   among this wallet's own past uploads on chain.
 * - Files identical to another file in this run (same bytes and content type)
 *   share one upload, so e.g. a static export that writes the same payload
 *   under two names pays once.
 * - With `compression`, eligible files are compressed; the cache key includes
 *   the encoding so compressed and uncompressed uploads never mix.
 *
 * @param folderPath - Folder to upload.
 * @param options - Cache, compression, fallback validation and incremental options.
 * @returns The plan, including the cache enriched with anything recovered.
 */
export async function planFolderUpload(
  folderPath: string,
  options?: {
    cache?: TransactionCache
    compression?: CompressionConfig
    concurrency?: number
    fallbackFile?: string
    incremental?: IncrementalOptions
    /** The run's keys, searched for in every file; omitted, only the shape checks run. */
    keyScanner?: KeyScanner
    /**
     * The files the caller already listed and searched for keys. The plan
     * uploads exactly these, so a file added after the search is never sent.
     */
    listed?: ListedFolder
  },
): Promise<FolderUploadPlan> {
  const incremental = options?.incremental
  const compression = options?.compression
  // Incremental mode always keeps a cache: it is where recovered ids go.
  const useCache = options?.cache !== undefined || incremental !== undefined

  const listed = options?.listed ?? listFolder(folderPath)
  const { relativePaths, skipped } = listed
  assertUploadableFolder(relativePaths, options?.fallbackFile)

  // Before anything is hashed, looked up or sent: a key is never published.
  if (!options?.listed) {
    await assertNoPrivateKeys(
      relativePaths.map((relativePath) => ({
        fullPath: path.join(folderPath, relativePath),
        name: relativePath,
      })),
      options?.keyScanner,
    )
  }

  /*
   * Hash every file when a cache is in play. In incremental mode the hash is
   * not just a cache key, it is published as a tag so a later run with no
   * local state can find this upload again.
   */
  const files: PlannedFile[] = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const fullPath = path.join(folderPath, relativePath)
      const contentType = mime.lookup(fullPath) || 'application/octet-stream'
      const encoding =
        compression && shouldCompress(relativePath, compression) ? compression.encoding : undefined
      const hash = useCache ? await hashFile(fullPath) : ''
      const cacheKey = hash ? fileCacheKey(hash, contentType, encoding) : ''
      return { cacheKey, contentType, encoding, fullPath, hash, relativePath, uploadBytes: 0 }
    }),
  )

  let cache = useCache ? (options?.cache ?? {}) : undefined
  let cacheHits = 0
  let recovered = 0

  if (cache) {
    for (const file of files) {
      if (!file.cacheKey) continue
      // Incremental mode has only ever written typed keys; see lookupCachedUpload.
      const hit = lookupCachedUpload(cache, file, !incremental)
      if (hit) {
        file.cached = { transactionId: hit.transactionId }
        cache = hit.cache
        cacheHits++
      }
    }
  }

  /*
   * Chain-backed lookup for whatever the local cache could not answer. This is
   * the layer that matters in CI, where a fresh checkout has no cache file at
   * all and every redeploy would otherwise pay for the whole bundle again.
   *
   * A gateway that is unreachable, slow or lagging behind costs reuse, never
   * correctness: unresolved files simply get uploaded.
   */
  if (incremental?.index && cache) {
    const unknown = new Map<string, FileIdentity>()
    for (const file of files) {
      if (!file.cached && file.hash) {
        unknown.set(file.cacheKey, {
          contentType: file.contentType,
          encoding: file.encoding,
          hash: file.hash,
        })
      }
    }

    if (unknown.size > 0) {
      try {
        const found = await incremental.index.resolve(unknown.values())

        for (const file of files) {
          const id = file.cached ? undefined : found[file.cacheKey]
          if (isArweaveId(id)) {
            file.cached = { transactionId: id }
            cache = setCachedTransaction(cache, file.cacheKey, id)
            cacheHits++
            recovered++
          }
        }

        if (recovered > 0) {
          incremental.onCacheUpdate?.(cache)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        incremental.onWarning?.(`Could not read past uploads from the gateway: ${message}`)
      }
    }
  }

  /*
   * Files identical to one earlier in this run share its upload. The share key
   * includes the content type, so identical bytes named data.json and data.txt
   * stay separate and each keeps its own Content-Type tag.
   */
  let duplicates = 0
  const firstUpload = new Map<string, PlannedFile>()
  for (const file of files) {
    if (file.cached || !file.cacheKey) continue

    const shareKey = `${file.contentType}|${file.cacheKey}`
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
        const { body, size } = await encodeForUpload(file.fullPath, file.encoding)
        file.body = body
        file.uploadBytes = size
      }),
    ),
  )

  return {
    cache,
    cacheHits,
    duplicates,
    files,
    manifestBytes: estimateManifestBytes(relativePaths),
    recovered,
    skipped,
    uploadBytes: toUpload.reduce((sum, file) => sum + file.uploadBytes, 0),
  }
}

/** Manifest paths for a file: the file, plus `dir` for every `dir/index.html`. */
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
 * Each file is checked against the cache (and, in incremental mode, the chain
 * index), identical files in the same run are uploaded once, and only what is
 * left is uploaded (compressed, when `compression` is set). A manifest is then
 * constructed and uploaded to create the folder structure.
 *
 * @param turbo - Upload client used for file and manifest uploads.
 * @param folderPath - Folder to upload.
 * @param options - Upload options for caching, compression, incremental reuse,
 *   concurrency, funding, and failure handling.
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
    /**
     * Opt in to content-hash incremental uploads: publish each file's hash as
     * a tag, recover ids the local cache is missing from the chain, and
     * persist every id the instant it lands. Omitted, the folder uploads
     * exactly as it always has.
     */
    incremental?: IncrementalOptions
    /**
     * A plan from `planFolderUpload`, when the caller has already made one to
     * quote the cost. Single use; its cache supersedes `cache`, since it
     * carries whatever the chain lookup recovered. Omitted, a plan is made here.
     */
    plan?: FolderUploadPlan
    /**
     * Called with the updated cache the moment each file lands, in every mode,
     * so a run that fails or is interrupted part-way keeps the ids it paid for.
     */
    onCacheUpdate?: (cache: TransactionCache) => void
    /** Payers for every data item: credit-share approvals the bundler may spend. */
    paidBy?: string[]
  },
): Promise<FolderUploadResult> {
  const concurrency = options?.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY
  const incremental = options?.incremental

  const plan =
    options?.plan ??
    (await planFolderUpload(folderPath, {
      cache: options?.cache,
      compression: options?.compression,
      concurrency,
      fallbackFile: options?.fallbackFile,
      incremental,
    }))
  const { cacheHits, duplicates, files } = plan
  const relativePaths = files.map((file) => file.relativePath)

  /*
   * Re-checked even when the plan came from outside. These are the cheap
   * guards that stop a typo costing a whole folder upload, and a caller that
   * built its own plan must not be the reason they are skipped.
   */
  assertUploadableFolder(relativePaths, options?.fallbackFile)

  const useCache = plan.cache !== undefined
  let cache = plan.cache ?? {}

  // If all files are cached, we still need to build and upload a new manifest
  // (because the manifest itself has a unique transaction ID each time)
  const toUpload = files.filter((file) => !file.cached && !file.duplicateOf)

  // Upload with concurrency control using p-limit
  const limit = pLimit(concurrency)

  /*
   * allSettled, not all: `Promise.all` rejects on the first failure while the
   * other workers are still in flight, and their ids would land after the
   * caller had given up -- paid for and thrown away. In-flight uploads settle
   * and are recorded; uploads that have not started yet are skipped, so an
   * outage costs one round of retries, not one per remaining file.
   */
  const recordCache = options?.onCacheUpdate ?? incremental?.onCacheUpdate
  let failed = false
  const uploadedIds = new Map<string, string>()
  const settled = await Promise.allSettled(
    toUpload.map((file) =>
      limit(async () => {
        if (failed) return

        const tags = incremental
          ? incrementalFileTags(file.hash, file.contentType, file.encoding)
          : [
              ...provenanceTags(),
              { name: 'Content-Type', value: file.contentType },
              ...(file.encoding ? [{ name: 'Content-Encoding', value: file.encoding }] : []),
            ]
        const { body } = file

        try {
          const uploadResult = await turbo.uploadFile({
            dataItemOpts: { tags, ...(options?.paidBy && { paidBy: options.paidBy }) },
            ...(body
              ? { fileSizeFactory: () => body.length, fileStreamFactory: () => Readable.from(body) }
              : { file: file.fullPath }),
          })

          if (!uploadResult?.id) {
            throw new Error('upload result missing transaction ID')
          }

          /*
           * Record the id before anything else can fail. Assignment and read
           * are not separated by an await, so the concurrent workers cannot
           * lose each other's writes.
           */
          uploadedIds.set(file.relativePath, uploadResult.id)
          if (useCache && file.cacheKey) {
            cache = setCachedTransaction(cache, file.cacheKey, uploadResult.id)
            recordCache?.(cache)
          }
        } catch (error) {
          failed = true
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`Failed to upload ${file.relativePath}: ${message}`, { cause: error })
        }
      }),
    ),
  )

  const rejection = settled.find((outcome) => outcome.status === 'rejected')
  if (rejection?.status === 'rejected') {
    throw rejection.reason
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
  const pathSet = new Set(relativePaths)
  const indexPath = pathSet.has('index.html') ? 'index.html' : undefined

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
  const fallbackPath = options?.fallbackFile ?? (pathSet.has('404.html') ? '404.html' : undefined)

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
      ...(options?.paidBy && { paidBy: options.paidBy }),
    },
    fileSizeFactory: () => manifestBuffer.length,
    fileStreamFactory: () => Readable.from(manifestBuffer),
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
    uploaded: toUpload.length,
  }
}

/**
 * The two checks worth making before a single byte is paid for.
 *
 * @param relativePaths - Every file found in the folder.
 * @param fallbackFile - The manifest fallback, when one was asked for.
 * @throws If the folder is empty or the fallback is not in it.
 */
function assertUploadableFolder(relativePaths: string[], fallbackFile?: string): void {
  if (relativePaths.length === 0) {
    throw new Error('Folder is empty, nothing to upload')
  }

  if (fallbackFile !== undefined && !relativePaths.includes(fallbackFile)) {
    throw new Error(
      `Fallback file not found in folder: ${fallbackFile}. ` +
        `It must be a path relative to the deploy folder, e.g. "404.html".`,
    )
  }
}
