import { chalk } from './chalk.js'
import type { UploadCost, UploadSize } from './upload-types.js'

export type DisplayRow = [label: string, value: string]

export function formatUploadSize(size: UploadSize): string {
  return `${(size.signedBytes ?? size.payloadBytes).toLocaleString()} bytes`
}

export function formatUploadCost(cost: UploadCost): string {
  return `${cost.amount.toString()}`
}

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
