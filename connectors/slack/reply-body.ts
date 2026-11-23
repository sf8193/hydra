// A Slack connector reply's body: `markdown_text` so markdown renders, or classic `text` when the reply tags someone (#895).
import { messageBody, unfurlFields } from '../../shared/slack-client.js'

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
  return { channel, ...messageBody(text, opts.classic), ...(threadTs && { thread_ts: threadTs }), ...unfurlFields(opts.unfurl === false) }
}

/**
 * True when the text carries a Slack tag or reference: a tag (`<@U…>`), a special mention or user group (`<!here>`, `<!channel>`, `<!everyone>`,
 * `<!subteam^…>`), or a channel link (`<#C…>`). A post tagging another app sent as `markdown_text` never reached that app (#948, reverted in #953),
 * and nothing shows mentions or channel links work there, so such text keeps going as classic `text`. A labelled link (`<url|label>`) is not one:
 * under `markdown_text` it renders as a link, as `[label](url)` does (seen live, 23 Nov). The test is plain text: `<!--`, `<!DOCTYPE` or a tag
 * inside a code span also count, so such a reply goes classic and loses tables and `**bold**`. That only costs rendering, never delivery.
 */
export function slackSyntax(text: string): boolean {
  return /<[@!#]/.test(text)
}

/** A connector reply's or edit's body field: `markdown_text`, or classic `text` when it carries a tag or is past the cap. */
export const replyBody = (text: string): { text: string } | { markdown_text: string } => messageBody(text, slackSyntax(text))
