export const DEFAULT_MODEL = 'claude-opus-4-6[1m]'
export const TRANSCRIBE_TMUX = 'hydra-transcribe'

/** Tools restricted to the main (control-plane) session. Shared across bridge
 *  and daemon so the two sets cannot diverge. */
export const MAIN_ONLY_TOOLS = new Set(['spawn_session', 'kill_session'])

export const KNOWN_MODELS = new Set([
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
])

/** Short aliases for chat commands like `spawn sonnet: topic`. */
export const MODEL_ALIASES: Record<string, string> = {
  'sonnet': 'claude-sonnet-4-6[1m]',
  'haiku': 'claude-haiku-4-5-20251001',
  'opus': 'claude-opus-4-6[1m]',
  'fable': 'claude-fable-5[1m]',
  'opus-5': 'claude-opus-5[1m]',
  'sonnet-5': 'claude-sonnet-5[1m]',
  'opus-4-7': 'claude-opus-4-7[1m]',
  'opus-4-8': 'claude-opus-4-8[1m]',
}

// Validate aliases at load time.
const ALIAS_KEY_RE = /^[a-z0-9-]+$/
for (const [key, id] of Object.entries(MODEL_ALIASES)) {
  if (!ALIAS_KEY_RE.test(key)) throw new Error(`MODEL_ALIASES key "${key}" contains invalid characters — must be [a-z0-9-]`)
  if (!KNOWN_MODELS.has(id.replace(/\[1m\]$/, ''))) throw new Error(`MODEL_ALIASES["${key}"] points to unknown model "${id}"`)
}

/** Regex fragment matching any alias key, for use in router patterns.
 *  Sorted longest-first so prefix aliases (e.g. 'sonnet' vs 'sonnet-5') don't short-circuit. */
export const MODEL_ALIAS_PATTERN = Object.keys(MODEL_ALIASES)
  .sort((a, b) => b.length - a.length)
  .join('|')

/** Look up a chat alias. Returns the full model ID or undefined.
 *  Lowercases input — router regex 'i' flag handles matching, this handles lookup. */
export function resolveModelAlias(alias: string): string | undefined {
  return MODEL_ALIASES[alias.toLowerCase()]
}

/** Strip [1m] context-window suffix and check against known models. */
export function isKnownModel(id: string): boolean {
  return KNOWN_MODELS.has(id.replace(/\[1m\]$/, ''))
}

// Late-bound (reads env per call, not frozen at import time). Intentional behavioral
// change from the original SPAWN_MODEL constant — consistent with maxChunkLimit().
export function spawnModel(): string {
  return process.env.HYDRA_MODEL?.trim() || DEFAULT_MODEL
}

/** Extract a model alias prefix from text using colon syntax (e.g. "fable: topic").
 *  Colon is required to disambiguate from English words like "opus" or "fable".
 *  Returns the resolved full model ID and remaining text. */
export function extractModelPrefix(raw: string): { model?: string; rest?: string } {
  const match = raw.match(/^(\S+?):\s*([\s\S]*)$/)
  if (!match) return { rest: raw }
  const resolved = resolveModelAlias(match[1])
  if (!resolved) return { rest: raw }
  return { model: resolved, rest: match[2]?.trim() || undefined }
}
export function reviewModel(): string {
  return process.env.HYDRA_REVIEW_MODEL?.trim() || spawnModel()
}

export function buildModel(): string {
  return process.env.HYDRA_BUILD_MODEL?.trim() || spawnModel()
}
