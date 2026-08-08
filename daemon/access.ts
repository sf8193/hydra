import { readFileSync, writeFileSync, readdirSync, rmSync, renameSync, mkdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { STATE_DIR, ACCESS_FILE, APPROVED_DIR, STATIC, gateway } from './config.js'
import type { InboundMessage } from '../gateway.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  threadReply?: boolean
  threadArchiveMinutes?: 60 | 1440 | 4320 | 10080
  defaultListen?: boolean
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline' | 'markdown'
  defaultListen?: boolean
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export function maxChunkLimit(): number { return gateway.maxMessageLength }
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return { ...defaultAccess(), ...parsed }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`daemon: access.json is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('daemon: static mode -- dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

export function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

export function autoAddGroup(channelId: string): void {
  const access = loadAccess()
  if (access.groups[channelId]) return
  access.groups[channelId] = {
    requireMention: true,
    allowFrom: [],
  }
  saveAccess(access)
}

export function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export async function gate(msg: InboundMessage): Promise<GateResult> {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.authorId

  if (msg.isDM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: msg.channelId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  const channelId = msg.isThread
    ? msg.parentChannelId ?? msg.channelId
    : msg.channelId
  const policy = access.groups[channelId]
  if (!policy) return { action: 'drop' }
  const groupAllowFrom = policy.allowFrom ?? []
  const requireMention = policy.requireMention ?? true
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }
  if (requireMention && !(await gateway.isMentioned(msg, access.mentionPatterns))) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}

// ---------------------------------------------------------------------------
// Approval polling
// ---------------------------------------------------------------------------

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch { return }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    let dmChannelId: string
    try {
      dmChannelId = readFileSync(file, 'utf8').trim()
    } catch {
      rmSync(file, { force: true })
      continue
    }
    if (!dmChannelId) {
      rmSync(file, { force: true })
      continue
    }
    void (async () => {
      try {
        await gateway.send(dmChannelId, "Paired! Say hi to Claude.")
        rmSync(file, { force: true })
      } catch (err) {
        process.stderr.write(`daemon: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      }
    })()
  }
}

if (!STATIC) setInterval(checkApprovals, 5000).unref()
