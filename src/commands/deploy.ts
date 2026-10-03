import { ARIO, SolanaANTReadable, SolanaANTWriteable } from '@ar.io/sdk'
import { Command } from '@oclif/core'
import ora from 'ora'

import { type DeployConfig, deployFlagConfigs } from '../constants/flags.js'
import { promptAdvancedOptions, promptUpdateArns } from '../prompts/arns.js'
import { getWalletConfig } from '../prompts/wallet.js'
import { chalk } from '../utils/chalk.js'
import {
  canPrompt,
  isPromptCancel,
  MISSING_UPLOAD_KEY,
  reportFailure,
  resolveKey,
  uploadResultRows,
  uploadWorkflowConfig,
  workflowIo,
} from '../utils/command-helpers.js'
import { defaultedFlags, extractFlags, resolveConfig } from '../utils/config-resolver.js'
import { type DisplayRow, formatDisplayRows } from '../utils/display.js'
import {
  clusterProgramIds,
  createArioRpc,
  createArioRpcSubscriptions,
  createSolanaArnsSigner,
  type SolanaCluster,
} from '../utils/solana.js'
import { resolveTurboServices } from '../utils/turbo.js'
import { runUploadWorkflow } from '../workflows/upload-workflow.js'

/** Whether the upload goes to Turbo's development sandbox. */
function usesTurboSandbox(config: {
  dev?: boolean
  'payment-url'?: string
  uploader?: string
}): boolean {
  try {
    return resolveTurboServices({
      dev: config.dev,
      paymentUrl: config['payment-url'],
      uploadUrl: config.uploader,
    }).development
  } catch {
    return false // An invalid URL is refused by the upload workflow itself.
  }
}

export default class Deploy extends Command {
  static override args = {}

  static override description = 'Deploy an application to the permaweb with optional ArNS update'

  static override examples = [
    '<%= config.bin %> deploy --wallet ./wallet.json',
    '<%= config.bin %> deploy --wallet ./wallet.json --deploy-folder ./dist',
    '<%= config.bin %> deploy --wallet ./wallet.json --deploy-folder ./dist --incremental',
    '<%= config.bin %> deploy --wallet ./wallet.json --deploy-file ./dist/index.html',
    '<%= config.bin %> deploy --wallet ./wallet.json --use-arns --arns-name my-app --arns-wallet ./arns-id.json',
    '<%= config.bin %> deploy --wallet ./wallet.json --use-arns --arns-name my-app --arns-wallet ./arns-id.json --undername staging',
  ]

  static override flags = extractFlags(deployFlagConfigs)

  public async run(): Promise<void> {
    const { flags, metadata } = await this.parse(Deploy)

    try {
      const hasArnsName = Boolean(flags['arns-name'])
      const explicitUseArns = Boolean(flags['use-arns'])
      const promptable = canPrompt()

      // Decide whether to update ArNS and whether to run interactive prompts.
      // When no ArNS details are supplied we ask by default (in a terminal);
      // the resolveConfig pass below then prompts for the name and other
      // missing values. Anywhere else, deploy falls back to upload-only.
      let useArns = hasArnsName || explicitUseArns
      let interactive = false

      if (hasArnsName) {
        interactive = false
      } else if (explicitUseArns) {
        interactive = promptable
      } else if (promptable) {
        useArns = await promptUpdateArns()
        interactive = useArns
      }

      if (interactive) {
        this.log(chalk.bold(chalk.cyan('\nInteractive Deployment Mode\n')))
        if (useArns) {
          this.log(
            chalk.dim(
              'Two keys are used:\n' +
                '  • Upload key — pays for the upload (any supported chain)\n' +
                '  • ArNS authority key — a Solana key that controls the name and signs the update\n',
            ),
          )
        }
      }

      const baseConfig = (await resolveConfig(deployFlagConfigs, flags, {
        defaulted: defaultedFlags(metadata),
        interactive,
      })) as DeployConfig

      let uploadKey = { privateKey: baseConfig['private-key'], wallet: baseConfig.wallet }
      if (
        promptable &&
        !uploadKey.wallet &&
        !uploadKey.privateKey &&
        (interactive || !process.env.DEPLOY_KEY?.trim())
      ) {
        const answer = await getWalletConfig({
          envVar: 'DEPLOY_KEY',
          label: 'upload key',
          purpose: 'pays for the upload',
        })
        uploadKey = { privateKey: answer.privateKey, wallet: answer.wallet }
      }

      // ArNS authority key — separate from the upload key. Always a Solana key
      // that controls the ArNS name and signs the ANT record update.
      let arnsKey = {
        privateKey: baseConfig['arns-private-key'],
        wallet: baseConfig['arns-wallet'],
      }
      if (
        promptable &&
        useArns &&
        !arnsKey.wallet &&
        !arnsKey.privateKey &&
        (interactive || !process.env.ARNS_KEY?.trim())
      ) {
        const answer = await getWalletConfig({
          envVar: 'ARNS_KEY',
          fileDefault: './arns-wallet.json',
          label: 'ArNS authority key',
          purpose: 'controls the ArNS name and signs the record update',
        })
        arnsKey = { privateKey: answer.privateKey, wallet: answer.wallet }
      }

      const advanced = interactive ? await promptAdvancedOptions(baseConfig['sig-type']) : null
      const deployConfig: DeployConfig = {
        ...baseConfig,
        cluster: advanced?.cluster || baseConfig.cluster,
        'max-token-amount': advanced?.maxTokenAmount || baseConfig['max-token-amount'],
        'on-demand': advanced?.onDemand || baseConfig['on-demand'],
        'ttl-seconds': advanced?.ttlSeconds || baseConfig['ttl-seconds'],
        undername: advanced?.undername || baseConfig.undername,
        'use-arns': useArns,
      }

      const config = uploadWorkflowConfig(deployConfig)
      if (typeof config === 'string') {
        this.error(config)
      }

      if (interactive) {
        this.log('')
      }

      // Every key is read and validated before anything is paid for.
      const deployKey = resolveKey({
        envVar: 'DEPLOY_KEY',
        missing: MISSING_UPLOAD_KEY,
        privateKey: uploadKey.privateKey,
        sigType: config['sig-type'],
        walletPath: uploadKey.wallet,
      })
      const arnsAuthorityKey = useArns
        ? resolveKey({
            envVar: 'ARNS_KEY',
            missing:
              'No ArNS authority key provided. Use --arns-wallet, --arns-private-key, or set ARNS_KEY (the Solana key that controls the ArNS name).',
            privateKey: arnsKey.privateKey,
            sigType: 'solana',
            walletPath: arnsKey.wallet,
          })
        : undefined

      this.log(chalk.bold(chalk.cyan('\nStarting deployment...\n')))

      if (useArns && deployConfig.cluster === 'mainnet' && usesTurboSandbox(config)) {
        this.warn(
          'Uploading to the Turbo development sandbox but updating a mainnet ArNS name: mainnet gateways may not serve sandbox uploads.',
        )
      }

      const arns = arnsAuthorityKey
        ? await this.prepareArns(deployConfig, arnsAuthorityKey)
        : undefined

      const result = await runUploadWorkflow(deployKey, config, workflowIo)

      // Printed before the ArNS update, so the id survives a failed update.
      this.log('')
      this.log(formatDisplayRows(uploadResultRows(result, config)))

      if (arns) {
        await arns.update(result.transactionId)
      }

      this.log('')
      this.log(chalk.bold(chalk.green('Deployment Successful!')))
    } catch (error) {
      if (isPromptCancel(error)) {
        this.log(chalk.yellow('\n\nDeployment cancelled'))
        this.exit(130)
      }

      reportFailure(this, error, 'Deployment failed')
    }
  }

  /**
   * Everything about the ArNS update that can be checked before the upload is
   * paid for: the name exists, the key decodes, and the key appears to control
   * the name. Returns the update to run once the upload has an id.
   */
  private async prepareArns(
    config: DeployConfig,
    authorityKey: string,
  ): Promise<{ update: (transactionId: string) => Promise<void> }> {
    const arnsName = config['arns-name']
    if (!arnsName) {
      this.error('--use-arns requires --arns-name')
    }

    const cluster = config.cluster as SolanaCluster
    const rpcUrl = config['rpc-url']
    const spinner = ora()

    spinner.start(`Fetching ArNS record for ${chalk.yellow(arnsName)}`)
    const programIds = clusterProgramIds(cluster)
    const rpc = createArioRpc(cluster, rpcUrl)
    const ario = ARIO.init({ rpc, ...programIds })

    let processId: string
    try {
      ;({ processId } = await ario.getArNSRecord({ name: arnsName }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/record not found/i.test(message)) {
        spinner.fail(`ArNS name ${chalk.red(arnsName)} does not exist on ${cluster}`)
        this.error(`ArNS name [${arnsName}] does not exist on ${cluster}`)
      }

      spinner.fail(`Could not fetch the ArNS record for ${chalk.red(arnsName)}`)
      this.error(
        `Could not fetch the ArNS record for [${arnsName}] from ${cluster} (${message}). Check --rpc-url and retry.`,
      )
    }

    const signer = await createSolanaArnsSigner(authorityKey)
    spinner.succeed(`ArNS record fetched for ${chalk.green(arnsName)}`)

    /*
     * Owner and controllers come from the ANT's config, whose owner field is
     * the last owner the program recorded; a fresh transfer can lag it. So a
     * mismatch is a loud warning rather than a refusal.
     */
    const antArgs = {
      processId,
      rpc,
      ...(programIds.antProgramId ? { antProgramId: programIds.antProgramId } : {}),
    }
    try {
      const reader = new SolanaANTReadable(antArgs)
      const [owner, controllers] = await Promise.all([reader.getOwner(), reader.getControllers()])
      if (signer.address !== owner && !controllers.includes(signer.address)) {
        spinner.warn(
          `The ArNS key ${signer.address} is neither the owner (${owner}) nor a controller of ${arnsName}; the record update will likely be refused after the upload`,
        )
      }
    } catch {
      // Reading the ANT is advisory; the update itself is the real check.
    }

    return {
      update: async (transactionId: string) => {
        spinner.start('Updating ANT record')
        const ant = new SolanaANTWriteable({
          ...antArgs,
          rpcSubscriptions: createArioRpcSubscriptions(cluster, rpcUrl),
          signer,
        })
        const recordParams = {
          transactionId,
          ttlSeconds: Number.parseInt(config['ttl-seconds'], 10),
        }

        try {
          await (config.undername === '@'
            ? ant.setBaseNameRecord(recordParams)
            : ant.setUndernameRecord({ ...recordParams, undername: config.undername }))
        } catch (error) {
          spinner.fail('ANT record update failed')
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(
            `The upload succeeded (Tx ID ${transactionId}) but the ArNS update failed: ${message}`,
          )
        }

        spinner.succeed('ANT record updated')
        const rows: DisplayRow[] = [
          ['ArNS Name', chalk.yellow(arnsName)],
          ['Undername', chalk.yellow(config.undername)],
          ['ANT', chalk.cyan(processId)],
          ['Cluster', chalk.gray(cluster)],
          ['TTL Seconds', chalk.blue(config['ttl-seconds'])],
        ]
        this.log(formatDisplayRows(rows))
      },
    }
  }
}
