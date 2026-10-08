import { Command, Flags } from '@oclif/core'

import { chalk } from '../utils/chalk.js'
import { reportFailure } from '../utils/command-helpers.js'
import { formatBytes } from '../utils/display.js'
import { generateSolanaWallet, ignoreInGit, writeWalletFile } from '../utils/keygen.js'
import { fetchFreeBytesRemaining, resolveTurboServices } from '../utils/turbo.js'

export default class Keygen extends Command {
  static override args = {}

  static override description =
    'Create a new Solana wallet file (solana-keygen id.json format) to sign and pay for uploads'

  static override examples = [
    '<%= config.bin %> keygen',
    '<%= config.bin %> keygen --out ./my-wallet.json',
    '<%= config.bin %> keygen --dev',
  ]

  static override flags = {
    dev: Flags.boolean({
      default: false,
      description:
        "Look up the free allowance on Turbo's development sandbox instead of production.",
    }),
    out: Flags.string({
      default: './ario-deploy-wallet.json',
      description: 'Where to write the wallet file. An existing file is never overwritten.',
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(Keygen)

    try {
      const wallet = generateSolanaWallet()
      writeWalletFile(flags.out, wallet)
      const ignored = ignoreInGit(flags.out)

      this.log(`Wallet file: ${chalk.green(flags.out)}`)
      this.log(`Address: ${chalk.cyan(wallet.address)}`)
      if (ignored) {
        this.log(`Added the file to ${ignored} so it is not committed.`)
      }

      this.log(await this.freeAllowanceLine(wallet.address, flags.dev))
      this.log('\nNext, deploy a folder with:')
      this.log(
        `  ario-deploy deploy --sig-type solana --wallet ${flags.out} --deploy-folder ./dist${flags.dev ? ' --dev' : ''}`,
      )
    } catch (error) {
      reportFailure(this, error, 'Key generation failed')
    }
  }

  private async freeAllowanceLine(address: string, dev: boolean): Promise<string> {
    try {
      const { paymentUrl } = resolveTurboServices({ dev })
      const remaining = await fetchFreeBytesRemaining(paymentUrl, address, 'solana')
      return `Free upload allowance: ${remaining === null ? 'unlimited' : formatBytes(Number(remaining))}`
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return `Could not read the free upload allowance (${reason}).`
    }
  }
}
