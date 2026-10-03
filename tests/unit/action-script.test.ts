import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The GitHub Action's deploy step is a bash script inside action.yml. This
 * runs that exact script against a stub `ario-deploy`, so its argument
 * handling and output parsing are tested as shipped.
 */

function stepScript(stepName: string): string {
  const lines = fs.readFileSync(path.join(process.cwd(), 'action.yml'), 'utf8').split('\n')
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`)
  const runAt = lines.findIndex((line, index) => index > start && line.trim() === 'run: |')
  const body: string[] = []
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && !line.startsWith('        ')) break
    body.push(line.slice(8))
  }

  return body.join('\n')
}

const TX_ID = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
/** Another 43-character id the CLI prints before the deploy's own. */
const FUND_TX_ID = 'F'.repeat(43)
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ario-deploy-action-'))
  const stub = path.join(dir, 'ario-deploy')
  // Records its arguments one per line, prints output like the CLI's, exits as told.
  fs.writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$@" > "$ARGS_FILE"',
      // A 43-character id that is not the deploy's, printed first, as a top-up line would.
      'echo "Topped up with 0.1 base-eth (' + FUND_TX_ID + ')"',
      `echo "Tx ID: ${TX_ID}"`,
      // eslint-disable-next-line no-template-curly-in-string -- bash, not a template
      'exit "${STUB_EXIT:-0}"',
    ].join('\n'),
    { mode: 0o755 },
  )
})

afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true })
})

function runDeployStep(inputs: Record<string, string>, stubExit = 0) {
  const outputFile = path.join(dir, 'github-output')
  fs.writeFileSync(outputFile, '')
  let status = 0
  try {
    execFileSync('bash', ['-e', '-o', 'pipefail', '-c', stepScript('Deploy to Permaweb')], {
      cwd: dir,
      env: {
        ARGS_FILE: path.join(dir, 'args'),
        DEPLOY_KEY: 'key',
        GITHUB_OUTPUT: outputFile,
        IN_ARNS_NAME: 'myapp',
        IN_CLUSTER: 'mainnet',
        IN_DEPLOY_FOLDER: './dist',
        IN_SIG_TYPE: 'arweave',
        IN_TTL: '60',
        IN_UNDERNAME: '@',
        PATH: `${dir}:${process.env.PATH}`,
        STUB_EXIT: String(stubExit),
        ...inputs,
      },
      stdio: 'pipe',
    })
  } catch (error) {
    status = (error as { status: number }).status
  }

  const outputs = Object.fromEntries(
    fs
      .readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  )
  const args = fs.existsSync(path.join(dir, 'args'))
    ? fs.readFileSync(path.join(dir, 'args'), 'utf8').split('\n').slice(0, -1)
    : []
  return { args, outputs, status }
}

describe('the action deploy step', () => {
  it('reports the deploy transaction id, not the first 43-character string it sees', () => {
    expect(runDeployStep({}).outputs['tx-id']).toBe(TX_ID)
  })

  it('passes inputs as literal arguments: no word splitting, globbing or command substitution', () => {
    const { args } = runDeployStep({
      IN_COMPRESS: 'gzip',
      IN_COMPRESS_EXCLUDE: 'llms*.txt, *.md',
      IN_PAID_BY: '$(touch pwned)',
    })

    expect(args).toContain('llms*.txt, *.md')
    expect(args).toContain('$(touch pwned)')
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false)
  })

  it('fails the step when the CLI fails, keeping the id if the upload got that far', () => {
    const { outputs, status } = runDeployStep({}, 2)

    expect(status).toBe(2)
    expect(outputs['tx-id']).toBe(TX_ID)
  })
})
