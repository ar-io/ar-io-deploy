import { describe, expect, it } from 'vitest'

import { formatDisplayRows, formatUploadError } from '../display.js'

const escapeCode = String.fromCodePoint(27)
const stripAnsi = (value: string): string =>
  value.replaceAll(new RegExp(`${escapeCode}\\[[\\d;]*m`, 'g'), '')

describe('formatDisplayRows', () => {
  it('formats rows as plain console labels', () => {
    expect(
      formatDisplayRows([
        ['Tx ID', 'abc123'],
        ['Arweave URL', 'https://turbo-gateway.com/abc123'],
      ]),
    ).toBe('Tx ID: abc123\nArweave URL: https://turbo-gateway.com/abc123')
  })
})

describe('formatUploadError', () => {
  it('formats upload errors without box or table characters', () => {
    const output = stripAnsi(
      formatUploadError('Upload rejected\n\nRequired upload credit: 0.25 AO'),
    )

    expect(output).toBe('Upload failed\n\nError: Upload rejected\nRequired upload credit: 0.25 AO')
    expect(output).not.toMatch(/[─│┌┐└┘]/)
  })
})
