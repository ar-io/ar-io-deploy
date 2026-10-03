import { describe, expect, it, vi } from 'vitest'

import { createFlagConfig, resolveConfig } from '../../src/utils/config-resolver.js'

describe('resolveConfig', () => {
  const configs = {
    folder: createFlagConfig<string>({
      flag: { default: './dist' },
      prompt: vi.fn(async () => './build'),
    }),
    signer: createFlagConfig<string>({
      flag: { default: 'arweave' },
      prompt: vi.fn(async () => 'solana'),
    }),
  }

  it('prompts for flags oclif only defaulted, instead of treating the default as typed', async () => {
    // oclif fills defaults in before the command sees its flags.
    const parsed = { folder: './dist', signer: 'arweave' }

    const resolved = await resolveConfig(configs, parsed, {
      defaulted: new Set(['folder', 'signer']),
      interactive: true,
    })

    expect(resolved).toEqual({ folder: './build', signer: 'solana' })
  })

  it('never prompts over a value the user typed', async () => {
    const resolved = await resolveConfig(
      configs,
      { folder: './out', signer: 'arweave' },
      { defaulted: new Set(['signer']), interactive: true },
    )

    expect(resolved.folder).toBe('./out')
  })

  it('keeps the default when a prompt has no answer for it', async () => {
    const resolved = await resolveConfig(
      {
        folder: createFlagConfig<string>({
          flag: { default: './dist' },
          async prompt() {},
        }),
      },
      { folder: './dist' },
      { defaulted: new Set(['folder']), interactive: true },
    )

    expect(resolved.folder).toBe('./dist')
  })

  it('asks a shared question once for every prompt that needs it', async () => {
    const ask = vi.fn(async () => 'answer')
    const shared = (context: { memo: Map<string, Promise<unknown>> }) => {
      if (!context.memo.has('q')) context.memo.set('q', ask())
      return context.memo.get('q') as Promise<string>
    }

    await resolveConfig(
      {
        a: createFlagConfig<string>({ flag: {}, prompt: shared }),
        b: createFlagConfig<string>({ flag: {}, prompt: shared }),
      },
      {},
      { interactive: true },
    )

    expect(ask).toHaveBeenCalledTimes(1)
  })
})
