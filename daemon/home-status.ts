import type { LiveState } from './engines/engine-adapter.js'
import type { BlockingKind } from './pane-probe.js'
import { HOME_STATUS_ACTION_PREFIX } from '../shared/constants.js'

export type HomeStatusInputs = {
  connected: boolean
  live: LiveState | null
  working: boolean
  stuck: BlockingKind | null
  lastReplyAt?: number
  lastUserMessageAt?: number
}

const EN_SPACE = String.fromCharCode(0x2002)

const BUTTONS = {
  disconnected: { glyph: '◌', label: 'Disconnected', style: 'danger' },
  working: { glyph: '◑', label: 'Working' },
  blocked: { glyph: '■', label: 'Blocked', style: 'danger' },
  login_required: { glyph: '■', label: 'Login needed', style: 'danger' },
  usage_limit: { glyph: '■', label: 'Usage limit', style: 'danger' },
  plan_mode: { glyph: '■', label: 'Plan approval', style: 'danger' },
  resume_prompt: { glyph: '■', label: 'Resume prompt', style: 'danger' },
  unknown_dialog: { glyph: '■', label: 'Dialog open', style: 'danger' },
  your_turn: { glyph: '●', label: 'Your turn', style: 'primary' },
  idle: { glyph: '○', label: 'Parked' },
} as const

export type HomeStatus = keyof typeof BUTTONS

type YourTurnFields = { threadId: string; lastReplyAt?: number; lastUserMessageAt?: number }

export function markYourTurn(info: YourTurnFields, chatId: string, now = Date.now()): boolean {
  if (chatId !== info.threadId) return false
  info.lastReplyAt = now
  return true
}

export function markUserMessaged(info: YourTurnFields, now = Date.now()): void {
  info.lastUserMessageAt = now
}

export function homeStatus(s: HomeStatusInputs): HomeStatus {
  if (!s.connected) return 'disconnected'
  if (s.stuck) return s.stuck
  if (s.working) return 'working'
  if (s.live === 'blocked') return 'blocked'
  if (s.lastReplyAt && s.lastReplyAt > (s.lastUserMessageAt ?? 0)) return 'your_turn'
  return 'idle'
}

export function homeStatusAccessory(status: HomeStatus, sessionId: string, url: string): object {
  const button: { glyph: string; label: string; style?: string } = BUTTONS[status]
  return {
    type: 'button',
    action_id: `${HOME_STATUS_ACTION_PREFIX}${sessionId}`,
    text: { type: 'plain_text', text: `${button.glyph}${EN_SPACE}${button.label}`, emoji: true },
    ...(button.style ? { style: button.style } : {}),
    ...(url ? { url } : {}),
  }
}
