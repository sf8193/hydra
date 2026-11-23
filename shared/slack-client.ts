// What the Slack gateway (gateways/slack.ts) and the Slack connector (connectors/slack/) set up the same way, so the two differ only in behaviour.
//
// Shared: the Socket Mode connection, the link-preview fields, how a message's text is sent (`messageBody`), and reading auth.test. Not shared: how each posts, throttles,
// retries, reads or downloads. Those differ on purpose, and a helper only one side uses does not belong here.

import { App, LogLevel, SocketModeReceiver } from '@slack/bolt'
import { SLACK_CLIENT_PING_TIMEOUT_MS } from './constants.js'

/**
 * The Socket Mode receiver and the Bolt app on it. Built here, not by Bolt: Bolt's own receiver leaves out clientPingTimeout, and the headroom
 * is the point. `App` and `SocketModeReceiver` are read from the `@slack/bolt` binding at each call, so a test that swaps the module sees the swap.
 */
export function buildSocketApp(tokens: { appToken: string; botToken: string }): { app: App } {
  const receiver = new SocketModeReceiver({ appToken: tokens.appToken, clientPingTimeout: SLACK_CLIENT_PING_TIMEOUT_MS, logLevel: LogLevel.ERROR })
  const app = new App({ token: tokens.botToken, receiver, socketMode: true, logLevel: LogLevel.ERROR })
  return { app }
}

/** The chat.postMessage fields that turn link previews off, or none when previews stay as Slack's own default. */
export function unfurlFields(off: boolean): { unfurl_links?: false; unfurl_media?: false } {
  return off ? { unfurl_links: false, unfurl_media: false } : {}
}

/** Hydra's cutoff for `markdown_text` (Slack's own cap is 12,000 characters); past it a message goes as classic mrkdwn `text`. */
export const MARKDOWN_TEXT_MAX = 12000

/**
 * The body field for chat.postMessage and chat.update. Sessions write GitHub-flavoured markdown, and Slack renders that (tables, lists, headings,
 * `**bold**`, `[text](url)`) only through `markdown_text`; Slack does the conversion, so the text goes byte for byte. `classic` text goes as `text`:
 * text that is already mrkdwn (the gateway's Block Kit button messages), or text with a tag `markdown_text` is not proven to deliver
 * (`slackSyntax`). So does text past `MARKDOWN_TEXT_MAX`. `markdown_text` cannot be combined with `text` or `blocks`.
 */
export function messageBody(text: string, classic = false): { text: string } | { markdown_text: string } {
  return classic || text.length > MARKDOWN_TEXT_MAX ? { text } : { markdown_text: text }
}

/**
 * True when the text carries a Slack tag or reference: a tag (`<@U…>`), a special mention or user group (`<!here>`, `<!channel>`, `<!everyone>`,
 * `<!subteam^…>`), or a channel link (`<#C…>`). A post tagging another app sent as `markdown_text` never reached that app (#948, reverted in #953),
 * and nothing shows mentions or channel links work there, so such text keeps going as classic `text`. A labelled link (`<url|label>`) is not one:
 * under `markdown_text` it renders as a link, as `[label](url)` does (seen live, 23 Nov).
 */
export function slackSyntax(text: string): boolean {
  return /<[@!#]/.test(text)
}

/** The bot's identity in an auth.test response; a field Slack left out is absent. */
export function parseAuth(auth: { bot_id?: string; user_id?: string; url?: string }): { botId?: string; userId?: string; url?: string } {
  return { ...(auth.bot_id !== undefined && { botId: auth.bot_id }), ...(auth.user_id !== undefined && { userId: auth.user_id }), ...(auth.url && { url: auth.url }) }
}
