export const DEFAULT_MODEL = 'claude-opus-5-5[1m]'
export const TRANSCRIBE_TMUX = 'hydra-transcribe'

export const KNOWN_MODELS = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
])

/** Short aliases for chat commands like `spawn sonnet: topic`. */
export const MODEL_ALIASES: Record<string, string> = {
  'sonnet': 'claude-sonnet-5[1m]',
  'haiku': 'claude-haiku-4-5-20251001',
  'opus': 'claude-opus-5-5[1m]',
  'fable': 'claude-fable-5-1[1m]',
  'opus-5': 'claude-opus-5[1m]',
  'opus-5-5': 'claude-opus-5-5[1m]',
  'opus-4-7': 'claude-opus-4-7[1m]',
  'opus-4-8': 'claude-opus-4-8[1m]',
}

/** Codex model aliases. Kept separate because selecting one also selects the
 * Codex engine; MODEL_ALIASES historically implies the Claude engine. */
export const CODEX_MODEL_ALIASES: Record<string, string> = {
  'astra': 'gpt-6-astra',
  'sol': 'gpt-5.6-sol',
  'terra': 'gpt-5.6-terra',
  'luna': 'gpt-5.6-luna',
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

export const CODEX_MODEL_ALIAS_PATTERN = Object.keys(CODEX_MODEL_ALIASES)
  .sort((a, b) => b.length - a.length)
  .join('|')

/** Look up a chat alias. Returns the full model ID or undefined.
 *  Lowercases input — router regex 'i' flag handles matching, this handles lookup. */
function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

export function resolveModelAlias(alias: string): string | undefined {
  const key = alias.toLowerCase()
  return lookup(MODEL_ALIASES, key)
}

export function resolveCodexModelAlias(alias: string): string | undefined {
  const key = alias.toLowerCase()
  return lookup(CODEX_MODEL_ALIASES, key)
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

import { homedir } from 'os'
import { join } from 'path'
import type { ToolName } from './tool-definitions.js'

// Spawned sessions launch with CLAUDE_CONFIG_DIR set to this, so transcripts land under it.
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}
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

export type Capability = 'protocol_context' | 'protocol_spawn'

export const CAPABILITY_TOOLS: Readonly<Record<Capability, ReadonlySet<ToolName>>> = {
  protocol_context: new Set<ToolName>(['advance', 'extend_phase']),
  protocol_spawn: new Set<ToolName>(['spawn_session', 'kill_session']),
}

export type Sentiment = 'POSITIVE' | 'NEGATIVE'

export type SentimentReaction = { name: 'thumbs_up' | 'thumbs_down'; sentiment: Sentiment }

export const SENTIMENT_REACTIONS: Readonly<Record<string, SentimentReaction>> = {
  '+1': { name: 'thumbs_up', sentiment: 'POSITIVE' },
  'thumbsup': { name: 'thumbs_up', sentiment: 'POSITIVE' },
  '👍': { name: 'thumbs_up', sentiment: 'POSITIVE' },
  '-1': { name: 'thumbs_down', sentiment: 'NEGATIVE' },
  'thumbsdown': { name: 'thumbs_down', sentiment: 'NEGATIVE' },
  '👎': { name: 'thumbs_down', sentiment: 'NEGATIVE' },
}

export const DELETE_REACTIONS: readonly string[] = ['hocho', '🔪']

export function normalizeReaction(emoji: string): string {
  return emoji.replace(/::skin-tone-\d+$/, '').replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu, '')
}

export function sentimentForReaction(emoji: string): SentimentReaction | undefined {
  const bare = normalizeReaction(emoji)
  return lookup(SENTIMENT_REACTIONS, bare)
}

export function isDeleteReaction(emoji: string): boolean {
  return DELETE_REACTIONS.includes(normalizeReaction(emoji))
}

export const SESSION_LABELS = ['review', 'build', 'investigate'] as const

export const isSessionLabel = (name: string): name is SessionLabel =>
  (SESSION_LABELS as readonly string[]).includes(name)
export type SessionLabel = typeof SESSION_LABELS[number]

// Leading or trailing only: the topic is a prompt, and matching anywhere ate prose out of it.
const LABEL_ALT = SESSION_LABELS.join('|')
const LABEL_LEADING = new RegExp('^--(' + LABEL_ALT + ')(?:\\s+|$)')
const LABEL_TRAILING = new RegExp('\\s--(' + LABEL_ALT + ')$')

export function parseSessionLabel(topic: string): { label?: SessionLabel; topic: string } {
  let label: SessionLabel | undefined
  let rest = topic.trim()
  for (;;) {
    const lead = rest.match(LABEL_LEADING)
    if (lead) {
      label ??= lead[1] as SessionLabel
      rest = rest.slice(lead[0].length)
      continue
    }
    const trail = rest.match(LABEL_TRAILING)
    if (trail) {
      label ??= trail[1] as SessionLabel
      rest = rest.slice(0, trail.index).trim()
      continue
    }
    break
  }
  return label ? { label, topic: rest } : { topic: rest }
}

export function byteTmuxName(platform: string): string {
  return process.env.BYTE_SESSION_NAME || `${platform}-byte`
}

export function canonicalModel(model: string): string | undefined {
  if (isKnownModel(model)) return model
  const alias = resolveCodexModelAlias(model) ?? resolveModelAlias(model)
  if (alias) return alias
  return Object.values(CODEX_MODEL_ALIASES).includes(model) ? model : undefined
}
