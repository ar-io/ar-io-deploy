/**
 * The handful of terminal styles the CLI uses.
 *
 * Colour is applied only when it will be seen: on a terminal, unless
 * `NO_COLOR` is set, or anywhere when `FORCE_COLOR` is set (to anything but
 * `0`). Escape codes written into CI logs and captured output are not just
 * noise; the GitHub Action reads the transaction id out of this output, and a
 * colour code glued to the id corrupted it.
 */

const RESET = '\u001B[0m'

const codes = {
  blue: '\u001B[34m',
  bold: '\u001B[1m',
  cyan: '\u001B[36m',
  dim: '\u001B[2m',
  gray: '\u001B[90m',
  green: '\u001B[32m',
  red: '\u001B[31m',
  yellow: '\u001B[33m',
} as const

type Style = keyof typeof codes

/** Whether output should carry colour, decided per call so tests and env changes apply. */
export function colorEnabled(): boolean {
  const force = process.env.FORCE_COLOR
  if (force !== undefined && force !== '0') return true
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  return Boolean(process.stdout.isTTY)
}

export const chalk = Object.fromEntries(
  Object.entries(codes).map(([name, code]) => [
    name,
    (text: unknown) => (colorEnabled() ? `${code}${String(text)}${RESET}` : String(text)),
  ]),
) as Record<Style, (text: unknown) => string>
