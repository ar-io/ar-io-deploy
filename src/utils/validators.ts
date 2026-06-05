import fs from 'node:fs'

import { TTL_MAX, TTL_MIN } from './constants.js'
import { expandPath } from './path.js'

/**
 * Validate TTL seconds
 */
export function validateTtl(value: string): string | true {
  const num = Number.parseInt(value, 10)
  if (Number.isNaN(num)) {
    return 'TTL must be a valid number'
  }

  if (num < TTL_MIN || num > TTL_MAX) {
    return `TTL must be between ${TTL_MIN} and ${TTL_MAX} seconds`
  }

  return true
}

/**
 * Validate undername
 */
export function validateUndername(value: string): string | true {
  if (value.length === 0) {
    return 'Undername must not be empty'
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
 * Validate ArNS name is not empty
 */
export function validateArnsName(value: string): string | true {
  if (value.length === 0) {
    return 'ArNS name is required'
  }

  return true
}
