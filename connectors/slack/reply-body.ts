// A Slack connector reply's body: `markdown_text` so markdown renders, or classic `text` when the reply tags someone (#895).
import { MARKDOWN_TEXT_MAX, messageBody, unfurlFields } from '../../shared/slack-client.js'

/**
 * `unfurl: false` posts without link previews (a place's `link_previews = false`, or `"single"` and 2+ links); absent, Slack's own default.
 * `classic`: the body is classic `text`, decided once on the whole reply (`slackSyntax`) so every part of a split reply renders alike.
 */
export type PostOptions = { unfurl?: false; classic: boolean }

/**
 * The chat.postMessage arguments for one reply: `markdown_text`, so markdown renders; classic `text` when `opts.classic` says so (the
 * reply tags someone) or the text is past the cap, the thread when there is one, and unfurling off exactly when asked. Tagged text differs from the gateway here:
 * the gateway's `applyMessageBody` keeps classic `text` only for buttons, so its tagged replies go as `markdown_text`.
 */
export function postPayload(
  channel: string,
  threadTs: string | undefined,
  text: string,
  opts: PostOptions,
): { channel: string; thread_ts?: string; unfurl_links?: false; unfurl_media?: false } & ({ text: string } | { markdown_text: string }) {
  return { channel, ...body(text, opts.classic), ...(threadTs && { thread_ts: threadTs }), ...unfurlFields(opts.unfurl === false) }
}

/**
 * True when the text carries a Slack tag or reference: a tag (`<@U…>`), a special mention or user group (`<!here>`, `<!channel>`, `<!everyone>`,
 * `<!subteam^…>`), or a channel link (`<#C…>`). Such text is kept classic until a tagged `markdown_text` post is shown to fire `app_mention`
 * (#895): nothing yet shows tags or channel links work under `markdown_text`. A labelled link (`<url|label>`) is not one:
 * under `markdown_text` it renders as a link, as `[label](url)` does (seen live, 23 Nov). The test is plain text: `<!--`, `<!DOCTYPE` or a tag
 * inside a code span also count, so such a reply goes classic and loses its tables (`toMrkdwn` keeps its bold and links). That only costs
 * rendering, never delivery.
 */
export function slackSyntax(text: string): boolean {
  return /<[@!#]/.test(text)
}

/**
 * A connector edit's body field, decided on the new text alone: Slack doesn't say which field the message was posted with, so editing one part
 * of a split, tagged reply to drop its tag sends that part as `markdown_text`. With `toMrkdwn` on the classic side, only a table renders differently.
 */
export const replyBody = (text: string): { text: string } | { markdown_text: string } => body(text, slackSyntax(text))

/** The body field: classic `text` (converted by `toMrkdwn`) when asked or past the cap, else `markdown_text` byte for byte. */
function body(text: string, classic: boolean): { text: string } | { markdown_text: string } {
  return classic || text.length > MARKDOWN_TEXT_MAX ? messageBody(toMrkdwn(text), true) : messageBody(text)
}

/**
 * Markdown as Slack's classic mrkdwn, for a reply that must go as `text`: `**b**` → `*b*`, `*i*` → `_i_`, `~~s~~` → `~s~`,
 * `[label](url)` → `<url|label>`, and a `#` heading → a bold line. Code spans and fences are left as written. Tables have no mrkdwn form
 * and stay as pipes. Sessions write GitHub-flavoured markdown (docs/slack.md), so a single-asterisk span is italic.
 */
export function toMrkdwn(text: string): string {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((piece, i) => i % 2 ? piece : piece
    .replace(/(^|[^*\w])\*(?![\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1_$2_')
    .replace(/\*\*(?!\s)([^*\n]+?)\*\*/g, '*$1*')
    .replace(/~~(?!\s)([^~\n]+?)~~/g, '~$1~')
    .replace(/\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+|mailto:[^\s)>]+)>?\)/g, '<$2|$1>')
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, '*$1*')).join('')
}
