import zlib from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  compress,
  globToRegExp,
  parseCompressionConfig,
  shouldCompress,
} from '../../src/utils/compression.js'

describe('globToRegExp', () => {
  it('matches a bare file-name pattern in any directory, like .gitignore', () => {
    const re = globToRegExp('llms*.txt')
    expect(re.test('llms.txt')).toBe(true)
    expect(re.test('llms-full.txt')).toBe(true)
    expect(re.test('sdks/turbo/llms.txt')).toBe(true)
    expect(re.test('notes.txt')).toBe(false)
  })

  it('anchors a pattern containing a slash to the deploy folder root', () => {
    const re = globToRegExp('docs/*.md')
    expect(re.test('docs/intro.md')).toBe(true)
    expect(re.test('docs/nested/intro.md')).toBe(false)
    expect(re.test('other/docs/intro.md')).toBe(false)
  })

  it('lets ** span directories', () => {
    const re = globToRegExp('api/**/*.json')
    expect(re.test('api/a.json')).toBe(true)
    expect(re.test('api/v1/deep/a.json')).toBe(true)
    expect(re.test('apix/a.json')).toBe(false)
  })

  it('treats regex metacharacters literally', () => {
    const re = globToRegExp('file(1).txt')
    expect(re.test('file(1).txt')).toBe(true)
    expect(re.test('file1.txt')).toBe(false)
  })
})

describe('parseCompressionConfig', () => {
  it('returns undefined when compression is off', () => {
    expect(parseCompressionConfig()).toBeUndefined()
    expect(parseCompressionConfig('none', 'llms*.txt')).toBeUndefined()
  })

  it('rejects an unknown encoding', () => {
    expect(() => parseCompressionConfig('zstd')).toThrow(/Unsupported compression/)
  })

  it('splits and trims the exclude list', () => {
    const config = parseCompressionConfig('gzip', ' llms*.txt , *.md ,')
    expect(config?.encoding).toBe('gzip')
    expect(config?.exclude).toHaveLength(2)
  })
})

describe('shouldCompress', () => {
  const config = parseCompressionConfig('gzip', 'llms*.txt')!

  it('compresses text formats', () => {
    expect(shouldCompress('index.html', config)).toBe(true)
    expect(shouldCompress('_next/static/chunks/app.js', config)).toBe(true)
    expect(shouldCompress('api/search', config)).toBe(true)
  })

  it('skips formats that are already compressed', () => {
    expect(shouldCompress('brand/logo.PNG', config)).toBe(false)
    expect(shouldCompress('fonts/inter.woff2', config)).toBe(false)
    expect(shouldCompress('video/demo.mp4', config)).toBe(false)
  })

  it('skips excluded paths', () => {
    expect(shouldCompress('llms-full.txt', config)).toBe(false)
    expect(shouldCompress('sdks/x/llms.txt', config)).toBe(false)
  })
})

describe('compress', () => {
  const input = Buffer.from('<div class="flex items-center gap-2">'.repeat(500))

  it('round-trips with gzip and is deterministic', async () => {
    const a = await compress(input, 'gzip')
    const b = await compress(input, 'gzip')
    expect(a.equals(b)).toBe(true)
    expect(zlib.gunzipSync(a).equals(input)).toBe(true)
    expect(a.length).toBeLessThan(input.length)
  })

  it('round-trips with brotli and is deterministic', async () => {
    const a = await compress(input, 'br')
    const b = await compress(input, 'br')
    expect(a.equals(b)).toBe(true)
    expect(zlib.brotliDecompressSync(a).equals(input)).toBe(true)
  })
})
