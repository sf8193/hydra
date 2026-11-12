// The Slack app hydra runs as: every scope and event it uses, and the manifest that creates it from hydra.toml.
// A leaf: the CLI reads it without loading Bolt or the daemon.

import type { SlackApp } from '../../config/types.js'

export type ScopeNeed = { option: string; any: readonly string[] }

/**
 * Every scope and event the Slack connector uses. The listener's startup check (`scopesNeeded`) and
 * `hydra slack manifest` both read this, so the app the manifest creates is the app the check expects.
 */
export const SLACK_APP_NEEDS = {
  /** Bot scopes, by the option that uses them. Any one of `any` serves (public or private channels); the manifest grants all. */
  botScopes: {
    channels: { option: 'channels', any: ['channels:history', 'groups:history'] },
    channelNames: { option: 'channel names (slack:#name)', any: ['channels:read', 'groups:read'] },
    senderNames: { option: 'sender names', any: ['users:read'] },
    dms: { option: 'dms', any: ['im:history'] },
    dmCatchUp: { option: 'catching up DMs opened while disconnected', any: ['im:read'] },
    files: { option: 'files', any: ['files:read'] },
    reactions: { option: 'ack and 🚫 reactions', any: ['reactions:write'] },
    replies: { option: 'replies', any: ['chat:write'] },
  } as const satisfies Record<string, ScopeNeed>,
  /** With `user_token_env`: reading threads in channels the bot isn't in. Never a write scope, never DMs. */
  userScopes: ['channels:history', 'groups:history'],
  /** `renames` are the events the listener subscribes to by name; messages arrive through Bolt's message handler. */
  botEvents: { messages: ['message.channels', 'message.groups', 'message.im'], renames: ['channel_rename', 'group_rename'] },
  /** With `user_token_env`. */
  userEvents: ['message.channels', 'message.groups'],
} as const

/**
 * What the app is called and says it does when `display_name` or `description` is unset (`app_name` and `app_description`
 * in `[connectors.slack]`). With a user token the description says so: the app then reads threads as its installer.
 * An app other than `default` is called by its id.
 */
export const SLACK_APP_DEFAULTS = {
  name: 'hydra',
  description: 'Answers the Slack threads it is tagged in, and its DMs, using Claude.',
  userTokenNote: ' It can also read threads its installer can see.',
} as const

/**
 * A Slack app manifest (YAML) for one of this hydra's apps: its name and description from hydra.toml, its scopes and events
 * from `SLACK_APP_NEEDS`. User scopes and events only when a user token is configured. Socket Mode on, org deploy off.
 */
export function slackManifest(app?: SlackApp): string {
  // With no app at all (no hydra.toml), the defaults.
  const name = app?.displayName ?? SLACK_APP_DEFAULTS.name
  const withUser = !!app?.userTokenEnv
  const description = app?.description ?? SLACK_APP_DEFAULTS.description
  const botScopes = [...new Set(Object.values(SLACK_APP_NEEDS.botScopes).flatMap(n => n.any))]
  // The operator's text is quoted: a JSON string is a YAML double-quoted scalar, so a name with ': ' or ' #' stays a string.
  const q = (s: string) => JSON.stringify(s)
  const list = (indent: string, items: readonly string[]) => items.map(i => `${indent}- ${i}`)
  return [
    'display_information:',
    `  name: ${q(name)}`,
    `  description: ${q(description)}`,
    'features:',
    '  bot_user:',
    `    display_name: ${q(name)}`,
    '    always_online: true',
    'oauth_config:',
    '  scopes:',
    '    bot:',
    ...list('      ', botScopes),
    ...(withUser ? ['    user:', ...list('      ', SLACK_APP_NEEDS.userScopes)] : []),
    'settings:',
    '  event_subscriptions:',
    '    bot_events:',
    ...list('      ', [...SLACK_APP_NEEDS.botEvents.messages, ...SLACK_APP_NEEDS.botEvents.renames]),
    ...(withUser ? ['    user_events:', ...list('      ', SLACK_APP_NEEDS.userEvents)] : []),
    '  socket_mode_enabled: true',
    '  org_deploy_enabled: false',
    '  token_rotation_enabled: false',
    '',
  ].join('\n')
}

/** Names a key of the app hydra connects, for an operator to find: the same key in either table that can declare it. */
export const defaultAppKey = (key: string): string =>
  `\`${key}\` of the app named \`default\` (\`[slack.apps.default]\` or \`[connectors.slack]\`)`

/** What an operator is told when hydra.toml has no app named `default`. */
export const NO_DEFAULT_APP = 'hydra.toml has no app named `default`: add `[slack.apps.default]`'
