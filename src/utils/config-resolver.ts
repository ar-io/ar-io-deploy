/* eslint-disable @typescript-eslint/no-explicit-any --
 * This is a generic flag-config utility that holds a heterogeneous map of oclif
 * flag definitions (string/boolean/number/custom) keyed by name. The `any`s are
 * load-bearing: replacing them with the precise oclif `OptionFlag`/`FlagInput`
 * types breaks `static flags` integration and transform-function variance.
 * Concrete types are recovered at call sites via `ResolvedConfig<T>` inference.
 */

/**
 * Shared by every prompt in one resolution, so related prompts can agree:
 * the file-or-folder question is asked once, and is not asked at all when the
 * user already named one of them.
 */
export interface PromptContext {
  /** Prompts' memoized answers, keyed by whatever the prompts agree on. */
  memo: Map<string, Promise<unknown>>
  /** Flags the user typed (as opposed to oclif filling in a default). */
  provided: ReadonlySet<string>
}

/**
 * Configuration for a single flag with its associated prompt
 */
export type FlagConfig<T = any, F = any> = {
  /** The oclif flag definition */
  flag: F
  /**
   * Optional prompt for the value in interactive mode. Returning nothing
   * keeps the flag's default.
   */
  prompt?: (context: PromptContext) => Promise<T | undefined | void>
}

/**
 * Map of flag configurations
 */
export type FlagConfigMap = Record<string, FlagConfig<any, any>>

/**
 * Extract the resolved config type from a FlagConfigMap
 * Infers the actual type (string, number, boolean) and optionality from each FlagConfig
 */
export type ResolvedConfig<T extends FlagConfigMap> = {
  [K in keyof T]: T[K] extends FlagConfig<infer U, any> ? U : any
}

/**
 * Options for resolveConfig
 */
export interface ResolveConfigOptions {
  /**
   * Flags whose value oclif filled in from a default. oclif applies defaults
   * before the command sees its flags, so without this every defaulted flag
   * looks typed by the user and its prompt never runs. Take it from
   * `this.parse()`'s `metadata.flags[name].setFromDefault`.
   */
  defaulted?: ReadonlySet<string>
  /** Whether to run in interactive mode */
  interactive?: boolean
}

/** Flag names oclif filled in from defaults, from `this.parse()` metadata. */
export function defaultedFlags(metadata: {
  flags: Record<string, { setFromDefault?: boolean } | undefined>
}): Set<string> {
  return new Set(
    Object.entries(metadata.flags)
      .filter(([, flag]) => flag?.setFromDefault)
      .map(([name]) => name),
  )
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

/**
 * Resolves configuration by combining parsed CLI flags with interactive prompts.
 *
 * A flag the user typed always wins. In interactive mode every other flag
 * with a prompt is asked; otherwise it keeps oclif's default.
 *
 * @param flagConfigs - Map of flag names to their configurations
 * @param parsedFlags - Parsed flags from this.parse()
 * @param options - Interactive mode and which flags were defaulted
 * @returns Fully resolved configuration object
 */
export async function resolveConfig<T extends FlagConfigMap>(
  flagConfigs: T,
  parsedFlags: Record<string, any>,
  options: ResolveConfigOptions = {},
): Promise<ResolvedConfig<T>> {
  const defaulted = options.defaulted ?? new Set<string>()
  const provided = new Set(
    Object.keys(flagConfigs).filter((key) => isSet(parsedFlags[key]) && !defaulted.has(key)),
  )
  const context: PromptContext = { memo: new Map(), provided }

  const resolved: Record<string, any> = {}
  for (const [key, config] of Object.entries(flagConfigs)) {
    if (!provided.has(key) && options.interactive && config.prompt) {
      const answer = await config.prompt(context)
      if (answer !== undefined) {
        resolved[key] = answer
        continue
      }
    }

    resolved[key] = isSet(parsedFlags[key]) ? parsedFlags[key] : config.flag.default
  }

  return resolved as ResolvedConfig<T>
}

/**
 * Helper to create a flag configuration with proper type inference
 */
export function createFlagConfig<T, F = any>(config: FlagConfig<T, F>): FlagConfig<T, F> {
  return config
}

/**
 * Helper to extract just the flags from a FlagConfigMap for use in command static flags
 */
export function extractFlags<T extends FlagConfigMap>(flagConfigs: T): Record<string, any> {
  const flags: Record<string, any> = {}
  for (const [key, config] of Object.entries(flagConfigs)) {
    flags[key] = config.flag
  }

  return flags
}
