import { chalk } from './chalk.js'

export type DisplayRow = [label: string, value: string]

export function formatDisplayRows(rows: DisplayRow[]): string {
  return rows.map(([label, value]) => `${label}: ${value}`).join('\n')
}

export function formatUploadError(message: string, title = 'Upload failed'): string {
  const rows: DisplayRow[] = []
  const sections = message
    .split(/\n{2,}/)
    .map((section) => section.trim())
    .filter(Boolean)

  for (const [index, section] of sections.entries()) {
    if (index === 0) {
      rows.push(['Error', chalk.red(section)])
      continue
    }

    if (section.startsWith('Required upload credit:')) {
      rows.push([
        'Required upload credit',
        chalk.blue(section.replace(/^Required upload credit:\s*/, '')),
      ])
      continue
    }

    rows.push(['Note', section])
  }

  return `${chalk.bold(chalk.red(title))}\n\n${formatDisplayRows(rows)}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

/** Turbo's free allowance per wallet, and per IP range, over its lifetime. */
export const FREE_TIER_LIFETIME_BYTES = 10 * 1024 * 1024

function kibibytes(bytes: number): string {
  return `${Number((bytes / 1024).toFixed(1))} KiB`
}

/**
 * Turbo answers an upload it will not take for free, and that no balance
 * covers, with HTTP 402. The SDK passes the service's body through as the
 * error message, which for production is a payment-requirements JSON dump.
 * Recognised by status, the x402 envelope or the fallback error code.
 */
export function isPaymentRequired(message: string): boolean {
  return /\(Status 402\)|x402Version|FREE_TIER_EXHAUSTED/.test(message)
}

/**
 * A plain-language replacement for a 402 upload failure, or undefined when
 * the message is some other failure.
 *
 * The free tier is metered per wallet and per IP range, and only the wallet
 * can be checked before uploading, so a 402 after a passing credit check is
 * expected to happen to people on a shared network.
 */
export function explainPaymentRequired(
  message: string,
  context: { freeLimitBytes: number; uploadUrl: string },
): string | undefined {
  if (!isPaymentRequired(message)) {
    return undefined
  }

  const topUpUrl = /"topUpUrl"\s*:\s*"(https?:\/\/[^\s"]+)"/.exec(message)?.[1]
  return [
    'Turbo refused the upload as unpaid (HTTP 402).',
    `Free uploads are limited to ${kibibytes(context.freeLimitBytes)} per file and ` +
      `${FREE_TIER_LIFETIME_BYTES / 1024 / 1024} MiB per wallet and per IP range, over the lifetime of each. ` +
      'This wallet or this network has used its allowance, or a file is over the per-file limit. ' +
      'To continue, add Turbo credits to this wallet, re-run with --on-demand, or have credits shared to this wallet.' +
      (topUpUrl ? ` Top up at ${topUpUrl}` : ''),
    `Details: HTTP 402 from ${context.uploadUrl}`,
  ].join('\n\n')
}
