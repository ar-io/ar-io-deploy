import fs from 'node:fs'

import { ARIO, SolanaANTWriteable } from '@ar.io/sdk'
import { Command } from '@oclif/core'
import ora from 'ora'

import { type DeployConfig, deployFlagConfigs } from '../constants/flags.js'
import { promptAdvancedOptions, promptUpdateArns } from '../prompts/arns.js'
import { getWalletConfig } from '../prompts/wallet.js'
import { chalk } from '../utils/chalk.js'
import { extractFlags, resolveConfig } from '../utils/config-resolver.js'
import { deployKeyFromPrivateKey, deployKeyFromWalletFile } from '../utils/deploy-key.js'
import { type DisplayRow, formatDisplayRows, formatUploadError } from '../utils/display.js'
import { expandPath } from '../utils/path.js'
import {
  clusterProgramIds,
  createArioRpc,
  createArioRpcSubscriptions,
  createSolanaArnsSigner,
  type SolanaCluster,
} from '../utils/solana.js'
import { runUploadWorkflow } from '../workflows/upload-workflow.js'

export default class Deploy extends Command {
  static override args = {}

  static override description = 'Deploy an application to the permaweb with optional ArNS update'

  static override examples = [
    '<%= config.bin %> deploy --wallet ./wallet.json',
    '<%= config.bin %> deploy --wallet ./wallet.json --deploy-folder ./dist',
    '<%= config.bin %> deploy --wallet ./wallet.json --deploy-file ./dist/index.html',
    '<%= config.bin %> deploy --wallet ./wallet.json --use-arns --arns-name my-app --arns-wallet ./arns-id.json',
    '<%= config.bin %> deploy --wallet ./wallet.json --use-arns --arns-name my-app --arns-wallet ./arns-id.json --undername staging',
  ]

  static override flags = extractFlags(deployFlagConfigs)

  public async run(): Promise<void> {
    try {
      const { flags } = await this.parse(Deploy)

      const hasArnsName = Boolean(flags['arns-name'])
      const explicitUseArns = Boolean(flags['use-arns'])
      const canPrompt = Boolean(process.stdout.isTTY) && !process.env.CI

      // Decide whether to update ArNS and whether to run interactive prompts.
      // When no ArNS details are supplied we ask by default (in a TTY); the
      // resolveConfig pass below then prompts for the name and other missing
      // values. A non-interactive environment falls back to upload-only.
      let useArns = hasArnsName || explicitUseArns
      let interactive = false

      if (hasArnsName) {
        interactive = false
      } else if (explicitUseArns) {
        interactive = canPrompt
      } else if (canPrompt) {
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

      const baseConfig = (await resolveConfig<typeof deployFlagConfigs>(deployFlagConfigs, flags, {
        interactive,
      })) as DeployConfig

      let walletConfig: { privateKey?: string; wallet?: string } = {
        privateKey: baseConfig['private-key'],
        wallet: baseConfig.wallet,
      }

      const shouldPromptWallet =
        canPrompt &&
        !baseConfig.wallet &&
        !baseConfig['private-key'] &&
        (interactive || !process.env.DEPLOY_KEY?.trim())

      if (shouldPromptWallet) {
        const config = await getWalletConfig({
          envVar: 'DEPLOY_KEY',
          label: 'upload key',
          purpose: 'pays for the upload',
        })
        walletConfig = {
          privateKey: config.privateKey,
          wallet: config.wallet,
        }
      }

      // ArNS authority key — separate from the upload key. Always a Solana key
      // that controls the ArNS name and signs the ANT record update. Only needed
      // when updating ArNS.
      let arnsKeyConfig: { privateKey?: string; wallet?: string } = {
        privateKey: baseConfig['arns-private-key'],
        wallet: baseConfig['arns-wallet'],
      }

      const shouldPromptArnsKey =
        canPrompt &&
        useArns &&
        !arnsKeyConfig.wallet &&
        !arnsKeyConfig.privateKey &&
        (interactive || !process.env.ARNS_KEY?.trim())

      if (shouldPromptArnsKey) {
        const config = await getWalletConfig({
          envVar: 'ARNS_KEY',
          fileDefault: './arns-wallet.json',
          label: 'ArNS authority key',
          purpose: 'controls the ArNS name and signs the record update',
        })
        arnsKeyConfig = {
          privateKey: config.privateKey,
          wallet: config.wallet,
        }
      }

      let advancedOptions:
        | {
            cluster: string
            maxTokenAmount?: string
            onDemand?: string
            ttlSeconds: string
            undername: string
          }
        | undefined

      if (interactive) {
        const options = await promptAdvancedOptions()
        advancedOptions = options || undefined
      }

      const effectiveCacheMaxEntries = baseConfig['no-dedupe']
        ? 0
        : baseConfig['dedupe-cache-max-entries']

      const deployConfig: DeployConfig = {
        'arns-name': baseConfig['arns-name'],
        'arns-private-key': arnsKeyConfig.privateKey,
        'arns-wallet': arnsKeyConfig.wallet,
        cluster: advancedOptions?.cluster || baseConfig.cluster,
        'dedupe-cache-max-entries': effectiveCacheMaxEntries,
        'deploy-file': baseConfig['deploy-file'],
        'deploy-folder': baseConfig['deploy-folder'],
        'max-token-amount': advancedOptions?.maxTokenAmount || baseConfig['max-token-amount'],
        'no-dedupe': baseConfig['no-dedupe'],
        'on-demand': advancedOptions?.onDemand || baseConfig['on-demand'],
        'private-key': walletConfig.privateKey,
        'rpc-url': baseConfig['rpc-url'],
        'sig-type': baseConfig['sig-type'],
        'ttl-seconds': advancedOptions?.ttlSeconds || baseConfig['ttl-seconds'],
        undername: advancedOptions?.undername || baseConfig.undername,
        uploader: baseConfig.uploader,
        'use-arns': useArns,
        wallet: walletConfig.wallet,
      }

      if (interactive) {
        this.log('')
      }

      // Resolve a deploy key from a wallet file, a private-key string, or an
      // environment variable. Used for both the upload key and the (Solana)
      // ArNS authority key — they are independent inputs.
      const resolveKey = (key: {
        envVar: string
        missing: string
        privateKey?: string
        sigType: string
        walletPath?: string
      }): string => {
        if (key.walletPath) {
          const resolvedPath = expandPath(key.walletPath)
          if (!fs.existsSync(resolvedPath)) {
            this.error(`Wallet file [${key.walletPath}] does not exist`)
          }

          return deployKeyFromWalletFile(key.sigType, fs.readFileSync(resolvedPath, 'utf8'))
        }

        if (key.privateKey) {
          return deployKeyFromPrivateKey(key.sigType, key.privateKey)
        }

        const envValue = process.env[key.envVar]?.trim()
        if (envValue) {
          if (key.sigType === 'solana') {
            return deployKeyFromPrivateKey(key.sigType, envValue)
          }

          return envValue
        }

        return this.error(key.missing)
      }

      const deployKey = resolveKey({
        envVar: 'DEPLOY_KEY',
        missing:
          'No upload key provided. Use --wallet, --private-key, or set DEPLOY_KEY (the key that pays for the upload).',
        privateKey: deployConfig['private-key'],
        sigType: deployConfig['sig-type'],
        walletPath: deployConfig.wallet,
      })

      // ArNS authority key is always a Solana key, independent of the upload key.
      const arnsAuthorityKey = deployConfig['use-arns']
        ? resolveKey({
            envVar: 'ARNS_KEY',
            missing:
              'No ArNS authority key provided. Use --arns-wallet, --arns-private-key, or set ARNS_KEY (the Solana key that controls the ArNS name).',
            privateKey: deployConfig['arns-private-key'],
            sigType: 'solana',
            walletPath: deployConfig['arns-wallet'],
          })
        : ''

      this.log(chalk.bold(chalk.cyan('\nStarting deployment...\n')))
      try {
        if (!deployConfig['use-arns']) {
          const { transactionId: txOrManifestId } = await runUploadWorkflow(
            deployKey,
            deployConfig,
            {
              error: (msg) => this.error(msg),
            },
          )

          this.log('')

          const rows: DisplayRow[] = [['Tx ID', chalk.green(txOrManifestId)]]
          if (deployConfig.uploader) {
            rows.push(['Bundler service', chalk.cyan(deployConfig.uploader)])
          }

          rows.push(['Arweave URL', chalk.yellow(`https://turbo-gateway.com/${txOrManifestId}`)])

          this.log(chalk.bold(chalk.green('Deployment Successful!')))
          this.log(formatDisplayRows(rows))

          return
        }

        const cluster = deployConfig.cluster as SolanaCluster
        const rpcUrl = deployConfig['rpc-url']
        const arnsName = deployConfig['arns-name']
        if (!arnsName) {
          this.error('--use-arns requires --arns-name')
        }

        const spinner = ora()

        spinner.start('Initializing ARIO')

        const programIds = clusterProgramIds(cluster)
        const rpc = createArioRpc(cluster, rpcUrl)
        const ario = ARIO.init({ rpc, ...programIds })

        spinner.succeed('ARIO initialized')

        spinner.start(`Fetching ArNS record for ${chalk.yellow(arnsName)}`)
        const arnsNameRecord = await ario.getArNSRecord({ name: arnsName }).catch(() => {
          spinner.fail(`ArNS name ${chalk.red(arnsName)} does not exist`)
          this.error(`ArNS name [${arnsName}] does not exist`)
        })

        spinner.succeed(`ArNS record fetched for ${chalk.green(arnsName)}`)

        const { transactionId: txOrManifestId } = await runUploadWorkflow(deployKey, deployConfig, {
          error: (msg) => this.error(msg),
        })

        this.log('')

        spinner.start('Updating ANT record')
        const signer = await createSolanaArnsSigner(arnsAuthorityKey)
        const ant = new SolanaANTWriteable({
          processId: arnsNameRecord.processId,
          rpc,
          rpcSubscriptions: createArioRpcSubscriptions(cluster, rpcUrl),
          signer,
          ...(programIds.antProgramId ? { antProgramId: programIds.antProgramId } : {}),
        })

        const recordParams = {
          transactionId: txOrManifestId,
          ttlSeconds: Number.parseInt(deployConfig['ttl-seconds'], 10),
        }

        await (deployConfig.undername === '@'
          ? ant.setBaseNameRecord(recordParams)
          : ant.setUndernameRecord({ ...recordParams, undername: deployConfig.undername }))

        spinner.succeed('ANT record updated')

        const rows: DisplayRow[] = [['Tx ID', chalk.green(txOrManifestId)]]
        if (deployConfig.uploader) {
          rows.push(['Bundler service', chalk.cyan(deployConfig.uploader)])
        }

        rows.push(
          ['ArNS Name', chalk.yellow(arnsName)],
          ['Undername', chalk.yellow(deployConfig.undername)],
          ['ANT', chalk.cyan(arnsNameRecord.processId)],
          ['Cluster', chalk.gray(cluster)],
          ['TTL Seconds', chalk.blue(deployConfig['ttl-seconds'])],
          ['Arweave URL', chalk.yellow(`https://turbo-gateway.com/${txOrManifestId}`)],
        )

        this.log(chalk.bold(chalk.green('Deployment Successful!')))
        this.log(formatDisplayRows(rows))
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        const normalizedError = errorMessage.startsWith('Upload failed:')
          ? errorMessage.replace(/^Upload failed:\s*/, '')
          : errorMessage

        if (errorMessage.startsWith('Upload failed:') && !process.env.CI && process.stdout.isTTY) {
          this.log(`\n${formatUploadError(normalizedError, 'Deployment failed')}`)
          this.exit(1)
        }

        this.error(chalk.red(`Deployment failed: ${errorMessage}`))
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'ExitPromptError') {
        this.log(chalk.yellow('\n\nDeployment cancelled'))
        this.exit(0)
      }

      throw error
    }
  }
}
