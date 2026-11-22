// The Slack app hydra runs as: every scope and event it uses, and the manifest that creates it from hydra.toml.
// A leaf: the CLI reads it without loading Bolt or the daemon.

import { SLACK_APP_DEFAULTS, type SlackApp } from '../../config/types.js'

export type ScopeNeed = { option: string; any: readonly string[] }

/**
 * Every scope and event the Slack connector uses. Each app's startup check (`scopesNeeded`) and
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
    groupDms: { option: 'group dms (slack:group-dm:…)', any: ['mpim:history'] },
    files: { option: 'files', any: ['files:read'] },
    reactions: { option: 'ack and 🚫 reactions', any: ['reactions:write'] },
    reactionsRead: { option: 'reactions (a place with reactions on)', any: ['reactions:read'] },
    replies: { option: 'replies', any: ['chat:write'] },
  } as const satisfies Record<string, ScopeNeed>,
  /**
   * With `operator_token_env`: hearing every channel, DM and group DM the operator is in, and reading threads in channels the bot isn't in;
   * `im:read` lists the operator's DMs, which is how a DM with a person gets its place (the bot's own DM comes from the bot's list). `chat:write` is the one
   * write scope: main's `edit_message` and `delete_message` rewrite the operator's own messages with it. Nothing posts as the operator.
   */
  userScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history', 'im:read', 'chat:write'],
  /** The user scope that edits and deletes the operator's own messages; a refused edit names it. */
  operatorWriteScope: 'chat:write',
  /** `renames` are the events the listener subscribes to by name; messages arrive through Bolt's message handler. */
  botEvents: { messages: ['message.channels', 'message.groups', 'message.im', 'message.mpim'], renames: ['channel_rename', 'group_rename'], reactions: ['reaction_added'] },
  /** With `operator_token_env`. */
  userEvents: ['message.channels', 'message.groups', 'message.im', 'message.mpim'],
  /**
   * Only when hydra.toml declares several apps: which of them are in a channel, so exactly one answers a message they all hear.
   * `public` is read for every public channel, `private` for private ones (asked only when a `slack:G…` place is named); each is a
   * scope the apps already hold for channel names. The events tell a join or a leave at once, not when the cache expires.
   */
  membership: {
    public: { option: 'telling which apps are in a public channel (several apps declared)', any: ['channels:read'] } as ScopeNeed,
    private: { option: 'telling which apps are in a private channel (several apps declared)', any: ['groups:read'] } as ScopeNeed,
    botEvents: ['member_joined_channel', 'member_left_channel'],
  },
} as const

/**
 * A Slack app manifest (YAML) for one of this hydra's apps: its name and description from hydra.toml, its scopes and events
 * from `SLACK_APP_NEEDS`. User scopes and events only when an operator token is configured; the membership events only when
 * hydra.toml declares `several` apps. The Messages tab on and not read-only: Slack refuses the operator's DM to an app whose tab is read-only. Socket Mode on, org deploy off.
 */
export function slackManifest(app?: SlackApp, opts: { several?: boolean } = {}): string {
  // With no app at all (no hydra.toml), the defaults.
  const name = app?.displayName ?? SLACK_APP_DEFAULTS.name
  const withOperatorToken = !!app?.operatorTokenEnv
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
    '  app_home:',
    '    messages_tab_enabled: true',
    '    messages_tab_read_only_enabled: false',
    '  bot_user:',
    `    display_name: ${q(name)}`,
    '    always_online: true',
    'oauth_config:',
    '  scopes:',
    '    bot:',
    ...list('      ', botScopes),
    ...(withOperatorToken ? ['    user:', ...list('      ', SLACK_APP_NEEDS.userScopes)] : []),
    'settings:',
    '  event_subscriptions:',
    '    bot_events:',
    ...list('      ', [...SLACK_APP_NEEDS.botEvents.messages, ...SLACK_APP_NEEDS.botEvents.renames, ...SLACK_APP_NEEDS.botEvents.reactions, ...(opts.several ? SLACK_APP_NEEDS.membership.botEvents : [])]),
    ...(withOperatorToken ? ['    user_events:', ...list('      ', SLACK_APP_NEEDS.userEvents)] : []),
    '  socket_mode_enabled: true',
    '  org_deploy_enabled: false',
    '  token_rotation_enabled: false',
    '',
  ].join('\n')
}

/** The apps hydra.toml declares, by id: what a message needs to name one. */
export type Apps = Readonly<Record<string, Pick<SlackApp, 'displayName'>>>

/**
 * What a message calls an app: its `display_name`, which hydra.toml loading already fills in when unset (`SLACK_APP_DEFAULTS.name`
 * for `default`, else the id), so it is the name the app has in Slack. An id no longer declared (a conversation an edit left behind) has only its id.
 */
export const appName = (apps: Apps, id: string): string => Object.hasOwn(apps, id) ? apps[id].displayName : id

/** Names a key of one app, for an operator to find: the one place a message gives the id, as the table to edit. */
export const appKey = (apps: Apps, id: string, key: string): string => `\`${key}\` of ${appName(apps, id)} (\`[slack.apps.${id}]\`)`

/** ` for Sales desk`: said where an app would otherwise go unnamed, only once there is more than one app to tell apart (a lone `default` is just "Slack"). */
export const appSuffix = (apps: Apps, id: string): string => id === 'default' && Object.keys(apps).length <= 1 ? '' : ` for ${appName(apps, id)}`

/** What a Slack call says when the app it would go through has no connection. */
export const notConnected = (apps: Apps, id: string): string => `Slack is not connected${appSuffix(apps, id)} (hydra.toml does not declare it, or its tokens are not set)`

/** What an operator is told when hydra.toml declares no Slack app. */
export const NO_SLACK_APP = 'hydra.toml declares no Slack app: add `[slack.apps.<id>]`'
