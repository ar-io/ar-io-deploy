import { afterEach, describe, expect, it } from 'vitest'

import { provenanceTags } from '../../src/utils/uploader.js'

const originalSha = process.env.GITHUB_SHA

afterEach(() => {
  if (originalSha === undefined) {
    delete process.env.GITHUB_SHA
  } else {
    process.env.GITHUB_SHA = originalSha
  }
})

describe('provenanceTags', () => {
  it('always includes the App-Name tag', () => {
    delete process.env.GITHUB_SHA
    expect(provenanceTags()).toContainEqual({ name: 'App-Name', value: 'ARIO-Deploy' })
  })

  it('omits GIT-HASH when GITHUB_SHA is unset (local runs)', () => {
    delete process.env.GITHUB_SHA
    expect(provenanceTags().some((t) => t.name === 'GIT-HASH')).toBe(false)
  })

  it('stamps the commit SHA as GIT-HASH when GITHUB_SHA is set (CI runs)', () => {
    process.env.GITHUB_SHA = 'abc123def'
    expect(provenanceTags()).toContainEqual({ name: 'GIT-HASH', value: 'abc123def' })
  })
})
