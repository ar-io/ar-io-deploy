import fs from 'node:fs'

import { TTL_MAX, TTL_MIN } from './constants.js'
import { expandPath } from './path.js'

/**
 * Validate TTL seconds
 */
export function validateTtl(value: string): string | true {
  if (!/^\d+$/.test(value.trim())) {
    return 'TTL must be a whole number of seconds'
  }

  const num = Number.parseInt(value, 10)

  if (num < TTL_MIN || num > TTL_MAX) {
    return `TTL must be between ${TTL_MIN} and ${TTL_MAX} seconds`
  }

  return true
}

/**
 * Validate a token amount in whole tokens: a positive decimal such as 0.5.
 * Decimal strings only, so the amount converts to base units exactly.
 */
export function validateTokenAmount(value: string): string | true {
  const trimmed = value.trim()
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(trimmed) || !/[1-9]/.test(trimmed)) {
    return 'Token amount must be a positive decimal number, e.g. 0.5'
  }

  return true
}

/**
 * Validate undername
 */
export function validateUndername(value: string): string | true {
  /*
   * The ANT program's own rule (ar-io-solana-contracts, is_valid_undername):
   * `@`, or up to 61 characters that start alphanumeric and continue with
   * alphanumerics, `-` or `_`. Checked here so a bad undername is refused
   * before the upload is paid for, not by the program afterwards.
   */
  if (value === '@') {
    return true
  }

  if (!/^[\da-z][\w-]{0,60}$/i.test(value)) {
    return 'Undername must be @, or 1-61 letters, digits, "-" or "_" starting with a letter or digit'
  }

  return true
}

/**
 * Validate file path exists
 */
export function validateFileExists(value: string): string | true {
  const filePath = expandPath(value)
  if (!fs.existsSync(filePath)) {
    return `File ${value} does not exist`
  }

  return true
}

/**
 * Validate folder path exists
 */
export function validateFolderExists(value: string): string | true {
  const folderPath = expandPath(value)
  if (!fs.existsSync(folderPath)) {
    return `Folder ${value} does not exist`
  }

  return true
}

/**
 * Validate that incremental uploads are not asked for alongside a disabled
 * dedupe cache.
 *
 * There are three spellings of "no dedupe cache" — `--no-dedupe`,
 * `--dedupe-cache-max-entries 0`, and the action inputs that map to them — and
 * they must all mean the same thing next to `--incremental`, which exists to
 * reuse previous uploads. `--no-dedupe` is refused by oclif exclusivity; this
 * covers the other spelling with the same outcome.
 */
export function validateIncrementalDedupe(
  incremental: boolean,
  dedupeCacheMaxEntries: number,
): string | true {
  if (incremental && dedupeCacheMaxEntries <= 0) {
    return (
      '--incremental reuses previous uploads and cannot be combined with deduplication turned off. ' +
      'Drop --no-dedupe, or raise --dedupe-cache-max-entries above 0.'
    )
  }

  return true
}

/**
 * Validate ArNS name is not empty
 */
export function validateArnsName(value: string): string | true {
  if (value.length === 0) {
    return 'ArNS name is required'
  }

  return true
}
