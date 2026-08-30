import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { OnDemandFunding } from '@ardrive/turbo-sdk'
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
  assertDeployInvariantTags,
  type ChainIndex,
  type DataItemTag,
  incrementalCacheKey,
  isArweaveId,
} from './incremental.js'
import type { UploadClient, UploadCost, UploadSize } from './upload-types.js'

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
 * `assertDeployInvariantTags` guards the set on every call, so a future tag
 * added here fails loudly instead of doubling users' costs.
 *
 * @param contentHash - SHA-256 of the file, published so a later run can find
 *   this upload again with no local state.
 * @param mimeType - Content type served for the file.
 * @returns The deploy-invariant tag set for the file.
 */
export function incrementalFileTags(contentHash: string, mimeType: string): DataItemTag[] {
  const tags: DataItemTag[] = [
    { name: 'App-Name', value: APP_NAME },
    { name: 'Content-Type', value: mimeType },
    { name: FILE_HASH_TAG, value: contentHash },
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
  cost?: UploadCost
  size?: UploadSize
  transactionId: string
  updatedCache?: TransactionCache
}

export interface FolderUploadResult extends UploadResult {
  /** Number of files that were cache hits (not re-uploaded) */
  cacheHits: number
  /** Total number of files in the folder */
  totalFiles: number
  /** Number of files that were uploaded */
  uploaded: number
}

export async function uploadFile(
  turbo: UploadClient,
  filePath: string,
  options?: {
    cache?: TransactionCache
    fundingMode?: OnDemandFunding
  },
): Promise<UploadResult> {
  const mimeType = mime.lookup(filePath) || 'application/octet-stream'

  // Compute hash if cache is provided
  const fileHash = options?.cache ? await hashFile(filePath) : undefined

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
      ],
    },
    file: filePath,
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

export interface FileUploadTask {
  /**
   * File size, so a plan can be priced before anything is signed. Zero outside
   * incremental mode, where nothing reads it and a `statSync` per file would
   * be a blocking syscall bought for nothing.
   */
  bytes: number
  cached?: { transactionId: string }
  /**
   * Key this file is remembered under: the bare hash outside incremental mode
   * (unchanged historic behaviour), hash + content type inside it, so that
   * byte-identical files served under different types cannot collapse onto a
   * single upload and be served under the wrong one.
   */
  cacheKey: string
  contentType: string
  fullPath: string
  hash: string
  relativePath: string
}

/**
 * Everything decided about a folder upload before any of it is paid for.
 *
 * Single use. `uploadFolder` marks tasks as resolved on the shared objects it
 * holds but does not recompute `uploadTargets`, so handing the same plan to a
 * second `uploadFolder` call re-uploads everything. Make a new one per call.
 */
export interface FolderUploadPlan {
  cache: TransactionCache
  cacheHits: number
  /**
   * Bytes that will actually be uploaded.
   *
   * The whole point of the feature: a caller can price this instead of the
   * folder, so a redeploy of two changed chunks is not refused for want of
   * credits for the entire bundle.
   */
  pendingBytes: number
  relativePaths: string[]
  tasks: FileUploadTask[]
  uncachedTasks: FileUploadTask[]
  uploadTargets: FileUploadTask[]
}

/**
 * Work out what a folder upload would do, without doing any of it.
 *
 * Hashes the folder, resolves what is already on Arweave, and reports what is
 * left. Split out of `uploadFolder` so the cost of a deploy can be quoted from
 * the files that will really be sent; `uploadFolder` calls it itself when no
 * plan is handed in, so the behaviour is identical either way.
 *
 * @param folderPath - Folder to upload.
 * @param options - Cache, fallback validation and incremental options.
 * @returns The plan, including the cache enriched with anything recovered.
 */
export async function planFolderUpload(
  folderPath: string,
  options?: {
    cache?: TransactionCache
    fallbackFile?: string
    incremental?: IncrementalOptions
  },
): Promise<FolderUploadPlan> {
  const useCache = options?.cache !== undefined
  const incremental = options?.incremental

  // Get all files in the folder
  const relativePaths = getAllFiles(folderPath)

  assertUploadableFolder(relativePaths, options?.fallbackFile)

  /*
   * Hash every file when the local cache is in play, and always in incremental
   * mode — there the hash is not just a cache key, it is published as a tag so
   * a later run with no local state can find this upload again.
   */
  const needHashes = useCache || incremental !== undefined
  const tasks: FileUploadTask[] = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const fullPath = path.join(folderPath, relativePath)
      const hash = needHashes ? await hashFile(fullPath) : ''
      const contentType = mime.lookup(fullPath) || 'application/octet-stream'
      const cacheKey = hash && incremental ? incrementalCacheKey(hash, contentType) : hash
      return {
        // Only a plan is priced, and only an incremental one is.
        bytes: incremental ? fs.statSync(fullPath).size : 0,
        cacheKey,
        contentType,
        fullPath,
        hash,
        relativePath,
      }
    }),
  )

  // Check cache for each file
  let cache = options?.cache ?? {}
  let cacheHits = 0

  for (const task of tasks) {
    if (useCache && task.cacheKey) {
      const cached = getCachedTransaction(cache, task.cacheKey)
      if (cached) {
        task.cached = { transactionId: cached.transactionId }
        cache = touchCacheEntry(cache, task.cacheKey)
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
   * correctness: unresolved hashes simply get uploaded.
   */
  if (incremental?.index) {
    const unknown = new Map(
      tasks
        .filter((t) => !t.cached && t.hash)
        .map((t) => [t.cacheKey, { contentType: t.contentType, hash: t.hash }]),
    )

    if (unknown.size > 0) {
      try {
        const found = await incremental.index.resolve(unknown.values())
        let recovered = 0

        for (const task of tasks) {
          const id = task.cached ? undefined : found[task.cacheKey]
          if (isArweaveId(id)) {
            task.cached = { transactionId: id }
            cache = setCachedTransaction(cache, task.cacheKey, id)
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

  // If all files are cached, we still need to build and upload a new manifest
  // (because the manifest itself has a unique transaction ID each time)
  const uncachedTasks = tasks.filter((t) => !t.cached)

  /*
   * Two files with identical bytes share a single upload in incremental mode:
   * the hash, not the path, is what is being paid for. Outside it the historic
   * one-upload-per-file behaviour is left exactly as it was.
   */
  const uploadTargets = incremental ? dedupeTasksByCacheKey(uncachedTasks) : uncachedTasks

  return {
    cache,
    cacheHits,
    pendingBytes: uploadTargets.reduce((total, task) => total + task.bytes, 0),
    relativePaths,
    tasks,
    uncachedTasks,
    uploadTargets,
  }
}

/**
 * Upload a folder with per-file deduplication.
 * Each file is checked against the cache individually, and only uncached files are uploaded.
 * A manifest is then constructed and uploaded to create the folder structure.
 *
 * @param turbo - Upload client used for file and manifest uploads.
 * @param folderPath - Folder to upload.
 * @param options - Upload options for caching, concurrency, funding, and failure handling.
 * @returns Folder upload result including manifest transaction ID and cache stats.
 */
export async function uploadFolder(
  turbo: UploadClient,
  folderPath: string,
  options?: {
    cache?: TransactionCache
    concurrency?: number
    /**
     * Path, relative to the folder, whose transaction becomes the manifest's
     * `fallback` — what a gateway serves for a path the manifest does not
     * list. Defaults to `404.html` when present.
     */
    fallbackFile?: string
    fundingMode?: OnDemandFunding
    /**
     * Opt in to content-hash incremental uploads: publish each file's hash as
     * a tag, recover ids the local cache is missing from the chain, and
     * persist every id the instant it lands. Omitted, the folder uploads
     * exactly as it always has.
     */
    incremental?: IncrementalOptions
    /**
     * A plan from `planFolderUpload`, when the caller has already made one to
     * quote the cost. Single use, and its cache supersedes `cache` since it
     * carries whatever the chain lookup recovered — passing one is enough to
     * put the cache in play. Omitted, a plan is made here.
     */
    plan?: FolderUploadPlan
    throwOnFailure?: boolean
  },
): Promise<FolderUploadResult> {
  const concurrency = options?.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY
  /*
   * A plan always carries a cache, so passing one counts. Reading only
   * `options.cache` here silently dropped every non-incremental cache update
   * and returned `updatedCache: undefined` to a caller who had done nothing
   * wrong.
   */
  const useCache = options?.cache !== undefined || options?.plan !== undefined
  const incremental = options?.incremental

  const plan = options?.plan ?? (await planFolderUpload(folderPath, options))
  const { relativePaths, tasks, uncachedTasks, uploadTargets } = plan
  let { cache, cacheHits } = plan

  /*
   * Re-checked even when the plan came from outside. These are the cheap
   * guards that stop a typo costing a whole folder upload, and a caller that
   * built its own plan must not be the reason they are skipped.
   */
  assertUploadableFolder(relativePaths, options?.fallbackFile)

  // Upload uncached files with concurrency control using p-limit
  const limit = pLimit(concurrency)

  /*
   * allSettled, not all: `Promise.all` rejects on the first failure while the
   * other workers are still in flight, so their `onCacheUpdate` calls land
   * after the caller has already flushed and given up — ids paid for and
   * thrown away. Everything settles first, then the failure propagates.
   */
  const settled = await Promise.allSettled(
    uploadTargets.map((task) =>
      limit(async () => {
        const mimeType = task.contentType

        const uploadResult = await turbo.uploadFile({
          dataItemOpts: {
            tags: incremental
              ? incrementalFileTags(task.hash, mimeType)
              : [...provenanceTags(), { name: 'Content-Type', value: mimeType }],
          },
          file: task.fullPath,
          ...(options?.fundingMode && { fundingMode: options.fundingMode }),
        })

        if (!uploadResult?.id) {
          if (options?.throwOnFailure) {
            throw new Error(`Failed to upload file: ${task.relativePath}`)
          }

          return { hash: task.cacheKey, task, transactionId: null }
        }

        /*
         * Record the id before anything else can fail. A deploy killed
         * part-way through is the normal case, not the exceptional one, and an
         * upload that is paid for but forgotten is money burnt. Assignment and
         * read are not separated by an await, so the concurrent workers cannot
         * lose each other's writes.
         */
        if (incremental && task.cacheKey) {
          cache = setCachedTransaction(cache, task.cacheKey, uploadResult.id)
          incremental.onCacheUpdate?.(cache)
        }

        return { hash: task.cacheKey, task, transactionId: uploadResult.id }
      }),
    ),
  )

  const uploadResults = settled.flatMap((outcome) =>
    outcome.status === 'fulfilled' ? [outcome.value] : [],
  )

  /*
   * Unconditionally, not gated on throwOnFailure: Promise.all always
   * propagated a thrown error, and that flag only ever governed an upload that
   * came back without an id.
   *
   * Two things do change, deliberately. Which error surfaces: Promise.all
   * reported whichever failed first in time, this reports the lowest-index
   * one. And how long a doomed deploy takes to say so: the whole p-limit queue
   * drains first, so a systemic failure on a large folder is reported at the
   * end rather than within milliseconds. p-limit was never cancelled, so the
   * same uploads were always attempted and the bill is unchanged — the trade
   * is a slower error message in exchange for not stranding ids that nobody
   * will flush.
   */
  const rejection = settled.find((outcome) => outcome.status === 'rejected')
  if (rejection?.status === 'rejected') {
    throw rejection.reason
  }

  // Update cache with all successful uploads (done sequentially to avoid race conditions)
  if (!incremental) {
    for (const result of uploadResults) {
      if (useCache && result.hash && result.transactionId) {
        cache = setCachedTransaction(cache, result.hash, result.transactionId)
      }
    }
  }

  // Point the files that shared an upload at the id it produced
  if (incremental) {
    for (const task of uncachedTasks) {
      if (task.cached || !task.cacheKey) {
        continue
      }

      const id = getCachedTransaction(cache, task.cacheKey)?.transactionId
      if (isArweaveId(id)) {
        task.cached = { transactionId: id }
      }
    }
  }

  // Check for any failed uploads
  const failedUploads = uploadResults.filter((r) => r.transactionId === null)
  if (failedUploads.length > 0 && options?.throwOnFailure) {
    throw new Error(
      `Failed to upload ${failedUploads.length} file(s): ${failedUploads.map((f) => f.task.relativePath).join(', ')}`,
    )
  }

  // Build manifest paths from cached and newly uploaded files
  const manifestPaths: Record<string, { id: string }> = {}

  for (const task of tasks) {
    let transactionId: string | null = null

    if (task.cached) {
      transactionId = task.cached.transactionId
    } else {
      const uploadResult = uploadResults.find((r) => r.task === task)
      transactionId = uploadResult?.transactionId ?? null
    }

    if (transactionId) {
      manifestPaths[task.relativePath] = { id: transactionId }

      // Add directory index support: if file is dir/index.html, also add dir → same ID
      if (task.relativePath.endsWith('/index.html')) {
        const dirPath = task.relativePath.replace(/\/index\.html$/, '')
        manifestPaths[dirPath] = { id: transactionId }
      }
    }
  }

  // Determine the index path (root index.html)
  const indexPath = relativePaths.includes('index.html') ? 'index.html' : undefined

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
    options?.fallbackFile ?? (relativePaths.includes('404.html') ? '404.html' : undefined)

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
    cacheHit: cacheHits === tasks.length,
    cacheHits,
    totalFiles: tasks.length,
    transactionId: manifestUploadResult.id,
    updatedCache: useCache || incremental ? cache : undefined,
    uploaded: uploadTargets.length - failedUploads.length,
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

/**
 * One task per distinct cache key, keeping the first occurrence.
 *
 * The key includes the content type, so two files with identical bytes but
 * different types are still two uploads. Collapsing them would serve one of
 * them under the MIME type of the other.
 *
 * @param tasks - Tasks that still need uploading.
 * @returns The subset that must actually be paid for.
 */
function dedupeTasksByCacheKey(tasks: FileUploadTask[]): FileUploadTask[] {
  const seen = new Set<string>()

  return tasks.filter((task) => {
    if (!task.cacheKey || seen.has(task.cacheKey)) {
      return !task.cacheKey
    }

    seen.add(task.cacheKey)
    return true
  })
}
