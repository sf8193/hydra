// The lines a session's own chat thread shows about its Slack traffic, the way it shows session-to-session sends (daemon/quiet-send.ts):
// 📨 for a message an approved person tagged it with, 📤 for a reply it posted into Slack. Quiet subtext, posted only in the session's thread, never into Slack.
import { noteLine, oneLine } from '../../daemon/quiet-send.js'
import { DEFAULT_LINE_EMOJI } from '../../shared/slack-lines.js'
import type { ChatGateway } from '../../gateways/gateway.js'

/** What stands for Slack in a line: the operator's `[slack] line_emoji` when this gateway can render it, else the default. A custom emoji exists in one server only. */
export const resolveLineEmoji = (configured: string | undefined, gateway: Pick<ChatGateway, 'canRenderEmoji'>): string =>
  configured && gateway.canRenderEmoji(configured) ? configured : DEFAULT_LINE_EMOJI

/** A tag is a mention token and then the words: the line is about the words. */
const words = (text: string): string => text.replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, ' ').trim() || '(a tag with no words)'

/** 📨: `who` (their `[people]` name) tagged the app; the name links the message. */
export const receivedLine = (emoji: string, who: string, permalink: string | undefined, text: string): string =>
  noteLine('from', { name: oneLine(who).replace(/[\[\]()<>]/g, ''), emoji, url: permalink }, 'progress', words(text), undefined, undefined, who)

/** 📤: the session's reply posted into a Slack conversation; `thread` links it. */
export const postedLine = (emoji: string, permalink: string | undefined, text: string): string =>
  noteLine('to', { name: 'thread', emoji, url: permalink }, 'progress', text)

/** Posts a line, built once the emoji is known, to a thread; the one place a Slack line leaves from. Never throws: a line is a notice. */
export type LinePoster = (threadId: string, make: (emoji: string) => string) => void
