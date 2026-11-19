// The emoji that stands for Slack in the lines a session's own thread shows about its Slack traffic (connectors/slack/lines.ts).
// A leaf: the hydra.toml loader checks the shape, and the Slack connector picks what to show.
import { emojiProblem } from './emoji.js'

/** What a line shows for Slack when `[slack] line_emoji` is absent, or the gateway cannot render the one set. */
export const DEFAULT_LINE_EMOJI = '💬'

/** A custom emoji as Discord writes it in a message: `<:name:id>`, or `<a:name:id>` when animated. It exists in one server only. */
export const CUSTOM_EMOJI_RE = /^<a?:\w{2,32}:(\d{17,20})>$/

/** The id a custom emoji is stored under, or undefined for a unicode emoji. */
export const customEmojiId = (s: string): string | undefined => CUSTOM_EMOJI_RE.exec(s)?.[1]

/** Why `raw` is not an emoji a line may carry (what to write instead), or undefined when it is: one unicode emoji, or a custom one in Discord's form. Shape only: whether any server has it is asked at send. */
export function lineEmojiProblem(raw: string): string | undefined {
  if (CUSTOM_EMOJI_RE.test(raw)) return undefined
  return emojiProblem(raw, 'write one emoji character, like line_emoji = "💬", or a Discord custom emoji as a message holds it, like line_emoji = "<:slack:123456789012345678>"')
}
