import { Command } from '@oclif/core'

import { type UploadConfig, uploadFlagConfigs } from '../constants/flags.js'
import { getWalletConfig } from '../prompts/wallet.js'
import { chalk } from '../utils/chalk.js'
import {
  canPrompt,
  isPromptCancel,
  MISSING_UPLOAD_KEY,
  refuseKeysInUpload,
  refuseWalletInUpload,
  reportFailure,
  resolveKey,
  uploadResultRows,
  uploadWorkflowConfig,
  workflowIo,
} from '../utils/command-helpers.js'
import { defaultedFlags, extractFlags, resolveConfig } from '../utils/config-resolver.js'
import { formatDisplayRows } from '../utils/display.js'
import { runUploadWorkflow } from '../workflows/upload-workflow.js'

export default class Upload extends Command {
  static override args = {}

  static override description = 'Upload a file or folder to Arweave via Turbo without updating ArNS'

  static override examples = [
    '<%= config.bin %> upload --wallet ./wallet.json',
    '<%= config.bin %> upload --wallet ./wallet.json --deploy-folder ./dist',
    '<%= config.bin %> upload --wallet ./wallet.json --deploy-folder ./dist --incremental',
    '<%= config.bin %> upload --wallet ./wallet.json --deploy-file ./dist/index.html',
    '<%= config.bin %> upload --wallet ./id.json --sig-type solana --on-demand ario --max-token-amount 1.5',
    '<%= config.bin %> upload --wallet ./wallet.json --dev',
    '<%= config.bin %> upload --wallet ./wallet.json --paid-by <payer-address>',
    '<%= config.bin %> upload --wallet ./id.json --sig-type solana',
  ]

  static override flags = extractFlags(uploadFlagConfigs)

  public async run(): Promise<void> {
    const { flags, metadata } = await this.parse(Upload)

    try {
      // Prompt only where someone can answer: never in CI, never without a terminal.
      const hasKey = Boolean(flags.wallet || flags['private-key'] || process.env.DEPLOY_KEY?.trim())
      const interactive = !hasKey && canPrompt()
      if (interactive) {
        this.log(chalk.bold(chalk.cyan('\nInteractive upload mode\n')))
      }

      const baseConfig = (await resolveConfig(uploadFlagConfigs, flags, {
        defaulted: defaultedFlags(metadata),
        interactive,
      })) as UploadConfig

      let key = { privateKey: baseConfig['private-key'], wallet: baseConfig.wallet }
      if (interactive) {
        const answer = await getWalletConfig({
          envVar: 'DEPLOY_KEY',
          label: 'upload key',
          purpose: 'pays for the upload',
        })
        key = { privateKey: answer.privateKey, wallet: answer.wallet }
        this.log('')
      }

      const config = uploadWorkflowConfig(baseConfig)
      if (typeof config === 'string') {
        this.error(config)
      }

      refuseWalletInUpload(config, [key.wallet])

      const deployKey = resolveKey({
        envVar: 'DEPLOY_KEY',
        missing: MISSING_UPLOAD_KEY,
        privateKey: key.privateKey,
        sigType: config['sig-type'],
        walletPath: key.wallet,
      })

      await refuseKeysInUpload(config, {
        privateKeys: [key.privateKey, deployKey],
        walletPaths: [key.wallet],
      })

      this.log(chalk.bold(chalk.cyan('\nStarting upload...\n')))
      // Already searched above, so the workflow does not read every file twice.
      const result = await runUploadWorkflow(deployKey, config, {
        ...workflowIo,
        keyScanner: false,
      })

      this.log('')
      this.log(chalk.bold(chalk.green('Upload successful!')))
      this.log(formatDisplayRows(uploadResultRows(result, config)))
    } catch (error) {
      if (isPromptCancel(error)) {
        this.log(chalk.yellow('\n\nUpload cancelled'))
        this.exit(130)
      }

      reportFailure(this, error, 'Upload failed')
    }
  }
}
