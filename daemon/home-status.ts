import type { LiveState } from './engines/engine-adapter.js'
import type { BlockingKind, BlockingState } from './pane-probe.js'
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

const ACTIONS: Partial<Record<HomeStatus, { title: string; text: string; confirm: string }>> = {
  disconnected: { title: 'Recover session?', text: 'Same as typing resume in the thread: tries resume, then fork, then respawn.', confirm: 'Recover' },
  plan_mode: { title: 'Approve plan?', text: 'Same as typing approve in the thread.', confirm: 'Approve' },
  resume_prompt: { title: 'Resume from summary?', text: 'Presses Enter on the resume prompt.', confirm: 'Resume' },
  unknown_dialog: { title: 'Cancel dialog?', text: 'Presses Esc. The dialog is cancelled, nothing is approved.', confirm: 'Press Esc' },
  usage_limit: { title: 'Dismiss usage limit?', text: 'Presses Esc on the usage-limit dialog. If the limit is still active it comes back.', confirm: 'Dismiss' },
  login_required: { title: 'Send /login?', text: 'Sends /login and Enter to the session, the same keys auto-login sends.', confirm: 'Send /login' },
}

export function homeRecoverable(sessionType: string, stuck: BlockingState | null, daemonWarm: boolean): boolean {
  return daemonWarm && !stuck && sessionType !== 'thread_guest'
}

export function parseHomeStatusClick(actionId: string, value: string | undefined, userId: string | undefined, allowFrom: string[]): { sessionId: string; shown: string } | null {
  if (!value || !userId || !allowFrom.includes(userId) || !actionId.startsWith(HOME_STATUS_ACTION_PREFIX)) return null
  return { sessionId: actionId.slice(HOME_STATUS_ACTION_PREFIX.length), shown: value }
}

export function homeStatusAccessory(status: HomeStatus, sessionId: string, url: string, actionable = true): object {
  const button: { glyph: string; label: string; style?: string } = BUTTONS[status]
  const action = actionable ? ACTIONS[status] : undefined
  return {
    type: 'button',
    action_id: `${HOME_STATUS_ACTION_PREFIX}${sessionId}`,
    text: { type: 'plain_text', text: `${button.glyph}${EN_SPACE}${button.label}`, emoji: true },
    ...(button.style ? { style: button.style } : {}),
    ...(action
      ? {
          value: status,
          confirm: {
            title: { type: 'plain_text', text: action.title },
            text: { type: 'plain_text', text: action.text },
            confirm: { type: 'plain_text', text: action.confirm },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        }
      : url ? { url } : {}),
  }
}
