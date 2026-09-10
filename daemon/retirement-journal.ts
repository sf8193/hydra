import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { atomicWriteFileSync } from './util.js'
import type { ProviderExecutionRef } from './engines/engine-adapter.js'

export type PendingRetirement = ProviderExecutionRef & {
  ownershipGeneration: string
  recordedAt: number
  reason: string
}

const file = join(STATE_DIR, 'pending-retirements.json')

function load(): PendingRetirement[] {
  try {
    if (!existsSync(file)) return []
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

function save(entries: PendingRetirement[]): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  atomicWriteFileSync(file, JSON.stringify(entries, null, 2) + '\n', 0o600)
}

export function recordPendingRetirement(ref: ProviderExecutionRef, ownershipGeneration: string, reason: string): PendingRetirement {
  const entries = load()
  const existing = entries.find(e => e.ownershipGeneration === ownershipGeneration)
  if (existing) return existing
  const entry = { ...ref, ownershipGeneration, recordedAt: Date.now(), reason }
  entries.push(entry)
  save(entries)
  return entry
}

export function completePendingRetirement(ownershipGeneration: string): void {
  save(load().filter(e => e.ownershipGeneration !== ownershipGeneration))
}

export function listPendingRetirements(): PendingRetirement[] { return load() }

export function hasPendingRetirementForHome(homeName: string): boolean {
  return load().some(e => e.provider === 'codex' && e.codexHomeName === homeName)
}
