import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CACHE_DIR, CACHE_FILE } from '../../src/constants/cache.js'
import { CACHE_FLUSH_INTERVAL_MS } from '../../src/constants/incremental.js'
import type { TransactionCache } from '../../src/utils/cache.js'
import { createCacheWriter } from '../../src/workflows/upload-workflow.js'

/**
 * The writer is the only thing standing between a killed deploy and paying
 * twice for files it already bought.
 *
 * The property is easy to lose one layer above the uploader, which is where it
 * was lost once already: a leading-edge throttle looks like a debounce until
 * ten uploads land at once, and then the last nine sit in memory until
 * something else happens to them. Ctrl-C is what usually happens next, and a
 * bare SIGINT runs no `finally`.
 */

let workdir: string
let cwdSpy: ReturnType<typeof vi.spyOn>

function cachePath(): string {
  return path.join(workdir, CACHE_DIR, CACHE_FILE)
}

function onDisk(): TransactionCache {
  if (!fs.existsSync(cachePath())) return {}
  return JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as TransactionCache
}

/** A cache holding `count` entries, named so they can be counted on disk. */
function cacheOf(count: number): TransactionCache {
  const entries: TransactionCache = {}
  for (let i = 0; i < count; i++) {
    entries[`key-${i}`] = {
      createdAtTimestamp: 1,
      lastUsedTimestamp: 1,
      transactionId: `tx${String(i).padStart(41, '0')}`,
    }
  }

  return entries
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-writer-'))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workdir)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cwdSpy.mockRestore()
  try {
    fs.rmSync(workdir, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 })
  } catch {
    // Best effort; losing a temp directory is not worth failing a run over.
  }
})

describe('createCacheWriter', () => {
  it('writes the first record straight through', () => {
    const writer = createCacheWriter(10_000)

    writer.record(cacheOf(1))

    expect(Object.keys(onDisk())).toHaveLength(1)
    writer.dispose()
  })

  it('flushes a burst after a quiet period, with no further record()', () => {
    const writer = createCacheWriter(10_000)

    // Ten uploads landing together: the first goes straight to disk, the rest
    // are coalesced. Nothing else is going to call record() afterwards.
    for (let i = 1; i <= 10; i++) {
      writer.record(cacheOf(i))
    }

    expect(Object.keys(onDisk())).toHaveLength(1)

    // A throttle would leave nine ids in memory here, forever.
    vi.advanceTimersByTime(CACHE_FLUSH_INTERVAL_MS + 1)

    expect(Object.keys(onDisk())).toHaveLength(10)
    writer.dispose()
  })

  it('does not rewrite the file once per record inside the interval', () => {
    const writer = createCacheWriter(10_000)
    const writeSpy = vi.spyOn(fs, 'writeFileSync')

    for (let i = 1; i <= 20; i++) {
      writer.record(cacheOf(i))
    }

    // One leading-edge write, and one trailing write for the whole burst.
    expect(writeSpy).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(CACHE_FLUSH_INTERVAL_MS + 1)
    expect(writeSpy).toHaveBeenCalledTimes(2)

    writeSpy.mockRestore()
    writer.dispose()
  })

  it('flush() writes what is outstanding immediately', () => {
    const writer = createCacheWriter(10_000)

    writer.record(cacheOf(1))
    writer.record(cacheOf(5))
    expect(Object.keys(onDisk())).toHaveLength(1)

    writer.flush()

    expect(Object.keys(onDisk())).toHaveLength(5)
    writer.dispose()
  })

  it('flush() is a no-op when nothing is outstanding', () => {
    const writer = createCacheWriter(10_000)

    writer.record(cacheOf(3))
    const writeSpy = vi.spyOn(fs, 'writeFileSync')
    writer.flush()
    writer.flush()

    expect(writeSpy).not.toHaveBeenCalled()
    writeSpy.mockRestore()
    writer.dispose()
  })

  it('writes nothing at all when the cache is disabled', () => {
    const writer = createCacheWriter(0)

    writer.record(cacheOf(3))
    vi.advanceTimersByTime(CACHE_FLUSH_INTERVAL_MS + 1)
    writer.flush()

    expect(fs.existsSync(cachePath())).toBe(false)
    writer.dispose()
  })

  it('applies the LRU bound before writing', () => {
    const writer = createCacheWriter(2)

    writer.record(cacheOf(5))

    expect(Object.keys(onDisk())).toHaveLength(2)
    writer.dispose()
  })

  it('does not hold the process open on its own', () => {
    const writer = createCacheWriter(10_000)
    const unref = vi.spyOn(globalThis, 'setTimeout')

    writer.record(cacheOf(1))
    writer.record(cacheOf(2))

    // An outstanding write must never be the reason a CLI refuses to exit.
    const timer = unref.mock.results.at(-1)?.value as NodeJS.Timeout | undefined
    expect(timer).toBeDefined()
    expect(timer?.hasRef?.()).toBe(false)

    unref.mockRestore()
    writer.dispose()
  })

  it('dispose() cancels a pending trailing write', () => {
    const writer = createCacheWriter(10_000)

    writer.record(cacheOf(1))
    writer.record(cacheOf(9))
    writer.dispose()

    vi.advanceTimersByTime(CACHE_FLUSH_INTERVAL_MS * 4)

    expect(Object.keys(onDisk())).toHaveLength(1)
  })
})

/** How many handlers are currently registered for a signal. */
function listenersFor(signal: NodeJS.Signals): number {
  return process.listenerCount(signal)
}

describe('createCacheWriter on a signal', () => {
  it('flushes on SIGINT and re-raises so the exit code stays right', () => {
    const raise = vi.fn()
    const writer = createCacheWriter(10_000, { raise })

    writer.record(cacheOf(1))
    writer.record(cacheOf(7))
    expect(Object.keys(onDisk())).toHaveLength(1)

    // Ctrl-C. No `finally` runs for this, which is the whole point.
    process.emit('SIGINT')

    expect(Object.keys(onDisk())).toHaveLength(7)
    expect(raise).toHaveBeenCalledWith('SIGINT')

    writer.dispose()
  })

  it('still re-raises when the flush itself fails', () => {
    const raise = vi.fn()
    const writer = createCacheWriter(10_000, { raise })
    writer.record(cacheOf(1))
    writer.record(cacheOf(2))

    // A full disk or a read-only mount. If this escapes the handler it becomes
    // an uncaughtException, the re-raise never runs, and the process reports
    // exit 1 instead of death by signal.
    const failing = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })

    expect(() => process.emit('SIGINT')).not.toThrow()
    expect(raise).toHaveBeenCalledWith('SIGINT')

    failing.mockRestore()
    writer.dispose()
  })

  it('flushes on SIGTERM too', () => {
    const raise = vi.fn()
    const writer = createCacheWriter(10_000, { raise })

    writer.record(cacheOf(1))
    writer.record(cacheOf(4))
    process.emit('SIGTERM')

    expect(Object.keys(onDisk())).toHaveLength(4)
    expect(raise).toHaveBeenCalledWith('SIGTERM')

    writer.dispose()
  })

  it('leaves no handlers behind after dispose()', () => {
    const before = { int: listenersFor('SIGINT'), term: listenersFor('SIGTERM') }

    const writer = createCacheWriter(10_000, { raise: vi.fn() })
    expect(listenersFor('SIGINT')).toBe(before.int + 1)
    expect(listenersFor('SIGTERM')).toBe(before.term + 1)

    writer.dispose()

    // A deploy per process is the normal case, but uploadFolder is exported
    // and a long-lived caller would otherwise leak a handler per run.
    expect(listenersFor('SIGINT')).toBe(before.int)
    expect(listenersFor('SIGTERM')).toBe(before.term)
  })
})

/**
 * The suite above runs on fake timers, which cannot distinguish a real unref'd
 * timer from a ref'd one — it would stay green if the trailing write were the
 * only thing keeping the process alive. This one uses the real event loop.
 */
describe('createCacheWriter on real timers', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('flushes a burst after a real quiet period', async () => {
    const writer = createCacheWriter(10_000)

    writer.record(cacheOf(1))
    writer.record(cacheOf(6))
    expect(Object.keys(onDisk())).toHaveLength(1)

    await new Promise((resolve) => {
      setTimeout(resolve, CACHE_FLUSH_INTERVAL_MS + 100)
    })

    expect(Object.keys(onDisk())).toHaveLength(6)
    writer.dispose()
  })

  it('leaves nothing on the event loop that would keep a CLI running', () => {
    const writer = createCacheWriter(10_000)

    writer.record(cacheOf(1))
    writer.record(cacheOf(2))

    // An unref'd handle is not counted among the things holding the loop open.
    const held = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles()
    const timers = held.filter((handle) => handle?.constructor?.name === 'Timeout')

    expect(timers).toHaveLength(0)
    writer.dispose()
  })
})
