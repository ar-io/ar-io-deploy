import { afterEach, describe, expect, it, vi } from 'vitest'

import { chalk } from '../../src/utils/chalk.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('chalk', () => {
  it('writes plain text when NO_COLOR is set, so captured output carries no escape codes', () => {
    vi.stubEnv('FORCE_COLOR', undefined as unknown as string)
    vi.stubEnv('NO_COLOR', '1')
    expect(chalk.green('Tx ID')).toBe('Tx ID')
  })

  it('colours when FORCE_COLOR is set', () => {
    vi.stubEnv('FORCE_COLOR', '1')
    expect(chalk.green('ok')).toBe('\u001B[32mok\u001B[0m')
  })
})
