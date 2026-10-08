import path from 'node:path'

import { Command, Flags } from '@oclif/core'

import { chalk } from '../utils/chalk.js'
import { reportFailure } from '../utils/command-helpers.js'
import { formatBytes } from '../utils/display.js'
import { isSameOrInside, realOrResolved } from '../utils/key-safety.js'
import {
  BACKUP_LINE,
  createWalletFolder,
  defaultWalletFolder,
  generateSolanaWallet,
  ignoreInGit,
  resolveOutPath,
  restrictToCurrentUser,
  writeWalletFile,
} from '../utils/keygen.js'
import { fetchFreeBytesRemaining, resolveTurboServices } from '../utils/turbo.js'

export default class Keygen extends Command {
  static override args = {}

  static override description =
    'Create a new Solana wallet file (solana-keygen id.json format) to sign and pay for uploads'

  static override examples = [
    '<%= config.bin %> keygen',
    '<%= config.bin %> keygen --out ~/wallets/my-wallet.json',
    '<%= config.bin %> keygen --dev',
  ]

  static override flags = {
    dev: Flags.boolean({
      default: false,
      description:
        "Look up the free allowance on Turbo's development sandbox instead of production.",
    }),
    out: Flags.string({
      description:
        'Where to write the wallet file. Defaults to ~/.ario-deploy/wallets/<address>.json. Never inside a folder you deploy. An existing file is never overwritten.',
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(Keygen)

    try {
      const wallet = generateSolanaWallet()
      const warnings: string[] = []
      let file: string

      if (flags.out === undefined) {
        const folder = defaultWalletFolder()
        createWalletFolder(folder)
        const folderProblem = restrictToCurrentUser(folder, { directory: true })
        if (folderProblem) {
          warnings.push(
            `Could not limit ${folder} to your Windows account (${folderProblem}). Other users of this computer may be able to read the wallets in it.`,
          )
        }

        file = path.join(folder, `${wallet.address}.json`)
      } else {
        file = resolveOutPath(flags.out)
      }

      writeWalletFile(file, wallet)

      const fileProblem = restrictToCurrentUser(file)
      if (fileProblem) {
        warnings.push(
          `Could not limit ${file} to your Windows account (${fileProblem}). Other users of this computer may be able to read it.`,
        )
      }

      if (flags.out !== undefined && isSameOrInside(realOrResolved(file), realOrResolved('.'))) {
        warnings.push(
          'The wallet is inside the current folder. It must never be inside a folder you deploy: ario-deploy refuses to upload it, and anything else that publishes the folder would leak it.',
        )
      }

      const git = ignoreInGit(file)
      warnings.push(...git.warnings)

      this.log(`Wallet file: ${chalk.green(file)}`)
      this.log(`Address: ${chalk.cyan(wallet.address)}`)
      this.log(chalk.yellow(BACKUP_LINE))
      if (git.addedTo) {
        this.log(`Added the file to ${git.addedTo}, and git now ignores it.`)
      }

      for (const warning of warnings) {
        this.warn(warning)
      }

      this.log(await this.freeAllowanceLine(wallet.address, flags.dev))
      this.log('\nNext, deploy a folder with:')
      this.log(
        `  ario-deploy deploy --sig-type solana --wallet ${/\s/.test(file) ? `"${file}"` : file} --deploy-folder ./dist${flags.dev ? ' --dev' : ''}`,
      )
    } catch (error) {
      reportFailure(this, error, 'Key generation failed')
    }
  }

  private async freeAllowanceLine(address: string, dev: boolean): Promise<string> {
    try {
      const { paymentUrl } = resolveTurboServices({ dev })
      const remaining = await fetchFreeBytesRemaining(paymentUrl, address)
      return `Free upload allowance: ${remaining === null ? 'unlimited' : formatBytes(Number(remaining))}`
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return `Free upload allowance: unknown (${reason}).`
    }
  }
}
