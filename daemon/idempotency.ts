import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { atomicWriteFileSync } from './util.js'

export type IdempotencyEntry = {
  key: string
  sessionId: string
  status: 'pending' | 'spawned' | 'completed' | 'failed' | 'timed_out'
  createdAt: number
  expiresAt: number
}

const REGISTRY_PATH = join(STATE_DIR, 'idempotency.json')
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
/** How long a `hydra deliver` key is remembered. */
export const DELIVER_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000

let entries: Map<string, IdempotencyEntry> = new Map()

function load(): void {
  try {
    if (existsSync(REGISTRY_PATH)) {
      const data = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as IdempotencyEntry[]
      entries = new Map(data.map(e => [e.key, e]))
      let orphaned = false
      for (const entry of entries.values()) {
        if (entry.status === 'pending') { entry.status = 'failed'; orphaned = true }
      }
      if (orphaned) persist()
    }
  } catch {
    entries = new Map()
  }
}

function persist(): void {
  atomicWriteFileSync(REGISTRY_PATH, JSON.stringify([...entries.values()], null, 2))
}

function prune(): void {
  const now = Date.now()
  let changed = false
  for (const [key, entry] of entries) {
    if (entry.expiresAt < now) {
      entries.delete(key)
      changed = true
    }
  }
  if (changed) persist()
}

export function checkIdempotency(key: string): { blocked: true; entry: IdempotencyEntry } | { blocked: false } {
  prune()
  const existing = entries.get(key)
  if (!existing) return { blocked: false }
  if (existing.status === 'failed' || existing.status === 'timed_out') return { blocked: false }
  return { blocked: true, entry: existing }
}

export function registerIdempotency(key: string, sessionId: string, ttlMs?: number, status?: IdempotencyEntry['status']): void {
  const now = Date.now()
  entries.set(key, {
    key,
    sessionId,
    status: status ?? 'spawned',
    createdAt: now,
    expiresAt: now + (ttlMs ?? DEFAULT_TTL_MS),
  })
  persist()
}

export function updateIdempotency(key: string, update: Partial<Pick<IdempotencyEntry, 'status' | 'sessionId'>>): void {
  const entry = entries.get(key)
  if (entry) {
    if (update.status) entry.status = update.status
    if (update.sessionId) entry.sessionId = update.sessionId
    persist()
  }
}

export function getIdempotencyEntry(key: string): IdempotencyEntry | undefined {
  return entries.get(key)
}

export function getBySessionId(sessionId: string): IdempotencyEntry | undefined {
  for (const entry of entries.values()) {
    if (entry.sessionId === sessionId && (entry.status === 'spawned' || entry.status === 'pending')) return entry
  }
  return undefined
}

export function clearIdempotency(key: string): boolean {
  if (!entries.has(key)) return false
  entries.delete(key)
  persist()
  return true
}

export function listIdempotencyEntries(): IdempotencyEntry[] {
  prune()
  return [...entries.values()]
}

load()
