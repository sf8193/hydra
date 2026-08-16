export const DEFAULT_MODEL = 'claude-opus-4-6[1m]'
export const TRANSCRIBE_TMUX = 'hydra-transcribe'

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

// ---------------------------------------------------------------------------
// Session identity — session type + capability-based tool access
// ---------------------------------------------------------------------------

import type { ToolName } from './tool-definitions.js'
export type { ToolName }

export type SessionType = 'master_orchestrator' | 'thread_owner' | 'thread_guest' | 'factory_builder'

export const BASE_TOOLS: Readonly<Record<SessionType, ReadonlySet<ToolName>>> = {
  master_orchestrator: new Set([
    'reply', 'react', 'edit_message', 'delete_message', 'fetch_messages',
    'download_attachment', 'send_to_thread', 'set_description',
    'list_sessions', 'peek_session', 'create_thread',
    'watch_pr', 'unwatch_pr', 'list_watches',
    'spawn_session', 'kill_session',
    'factory_build', 'factory_retry', 'factory_accept', 'factory_abandon',
    'factory_status', 'factory_review',
  ]),
  thread_owner: new Set([
    'reply', 'react', 'edit_message', 'delete_message', 'fetch_messages',
    'download_attachment', 'send_to_thread', 'set_description',
    'list_sessions', 'peek_session',
    'watch_pr', 'unwatch_pr', 'list_watches',
  ]),
  thread_guest: new Set([
    'reply', 'fetch_messages', 'react', 'edit_message',
    'download_attachment', 'set_description',
    'advance', 'extend_phase',
  ]),
  factory_builder: new Set([
    'reply', 'fetch_messages', 'send_to_thread',
    'download_attachment', 'set_description',
    'factory_done',
  ]),
}

export type Capability = 'protocol_context'

export const CAPABILITY_TOOLS: Readonly<Record<Capability, ReadonlySet<ToolName>>> = {
  protocol_context: new Set<ToolName>(['advance', 'extend_phase']),
}
