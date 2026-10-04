// Preloaded by the live tests: logs each fetch so a test can see which hosts the CLI used.
const original = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input.url ?? String(input))
  process.stderr.write(`FETCH ${init?.method ?? 'GET'} ${url.replace(/\?.*/, '')}\n`)
  return original(input, init)
}
