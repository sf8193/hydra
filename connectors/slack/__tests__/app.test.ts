import { describe, test, expect } from 'bun:test'
import { alsoHeard, hydra, oneListener, sharedChannel, BASE, TWO_APPS } from './slack-config.js'
import { slackManifest, SLACK_APP_NEEDS, SLACK_APP_DEFAULTS, appKey, appName, appSuffix, notConnected } from '../app.js'
import { scopesNeeded } from '../listener.js'

type Manifest = {
  display_information: { name: string; description: string }
  features: { app_home: { messages_tab_enabled: boolean; messages_tab_read_only_enabled: boolean }; bot_user: { display_name: string; always_online: boolean } }
  oauth_config: { scopes: { bot: string[]; user?: string[] } }
  settings: { event_subscriptions: { bot_events: string[]; user_events?: string[] }; socket_mode_enabled: boolean; org_deploy_enabled: boolean }
}
const manifestOf = (toml: string) => Bun.YAML.parse(slackManifest(hydra(toml).slackApps.default)) as Manifest
const withSlack = (lines: string) => BASE.replace('[people.op]', `${lines}\n[people.op]`)

describe('slackManifest for an app other than default', () => {
  const sales = (lines = '') => hydra(`${BASE}\n[slack.apps.sales]\nbot_token_env = "SALES_BOT"\n${lines}\n`).slackApps.sales
  test('is called by its own name unless it sets one, and says the default description', () => {
    const m = Bun.YAML.parse(slackManifest(sales())) as Manifest
    expect(m.display_information).toEqual({ name: 'sales', description: SLACK_APP_DEFAULTS.description })
    expect(m.features.bot_user.display_name).toBe('sales')
    const named = Bun.YAML.parse(slackManifest(sales('display_name = "Sales: helper"\ndescription = "Sales threads."\noperator_token_env = "SALES_USER"'))) as Manifest
    expect(named.display_information).toEqual({ name: 'Sales: helper', description: 'Sales threads.' })
    expect(named.oauth_config.scopes.user).toEqual([...SLACK_APP_NEEDS.userScopes])
  })
})

describe('slackManifest', () => {
  test('the name and description are the ones hydra.toml gives, quoted so any text stays a string', () => {
    const m = manifestOf(withSlack('display_name = "Acme helper: #1"\ndescription = "Answers threads # in Slack."'))
    expect(m.display_information).toEqual({ name: 'Acme helper: #1', description: 'Answers threads # in Slack.' })
    expect(m.features.bot_user).toEqual({ display_name: 'Acme helper: #1', always_online: true })
    expect(m.settings).toMatchObject({ socket_mode_enabled: true, org_deploy_enabled: false })
  })

  test('the Messages tab is on and not read-only, so the operator can DM the app', () => {
    expect(manifestOf(BASE).features.app_home).toEqual({ messages_tab_enabled: true, messages_tab_read_only_enabled: false })
  })

  test('without display_name or description, the defaults', () => {
    const m = manifestOf(BASE)
    expect(m.display_information).toEqual({ name: SLACK_APP_DEFAULTS.name, description: SLACK_APP_DEFAULTS.description })
    expect(m.features.bot_user.display_name).toBe('hydra')
    expect(Bun.YAML.parse(slackManifest(undefined))).toEqual(m)
  })

  test('user scopes and user events only with operator_token_env', () => {
    const bot = manifestOf(BASE)
    expect(bot.oauth_config.scopes.user).toBeUndefined()
    expect(bot.settings.event_subscriptions.user_events).toBeUndefined()
    expect(bot.settings.event_subscriptions.bot_events).toEqual(['message.channels', 'message.groups', 'message.im', 'message.mpim', 'channel_rename', 'group_rename', 'reaction_added'])
    const user = manifestOf(withSlack('operator_token_env = "HYDRA_SLACK_USER_TOKEN"'))
    // The default description tells coworkers the app can read as its installer.
    expect(user.display_information.description).toBe(SLACK_APP_DEFAULTS.description + SLACK_APP_DEFAULTS.operatorTokenNote)
    expect(user.oauth_config.scopes.user).toEqual([...SLACK_APP_NEEDS.userScopes])
    expect(user.settings.event_subscriptions.user_events).toEqual([...SLACK_APP_NEEDS.userEvents])
  })

  test('the bot scopes are exactly the ones the startup scope check asks for, with every option on', () => {
    // Channels by name, DMs (the operator has a slack: address), group DMs, files and reactions: every option scopesNeeded knows.
    const h = hydra(alsoHeard(oneListener('#food', 'helper', '["role:anyone"]', '[places."slack:#food"]\nfiles = true\nreactions = "all"\n'), 'helper', 'slack:group-dm:*'))
    const checked = scopesNeeded(h)
    expect(checked).toEqual(Object.values(SLACK_APP_NEEDS.botScopes))
    const manifest = Bun.YAML.parse(slackManifest(h.slackApps.default)) as Manifest
    expect(manifest.oauth_config.scopes.bot).toEqual([...new Set(checked.flatMap(n => n.any))])
  })
})

describe('DMs and group DMs: one list', () => {
  // Every message event needs the history scope of its kind: message.channels → channels:history, message.im → im:history, and so on.
  const historyOf = (event: string) => `${event.replace('message.', '')}:history`
  const everyOption = () => hydra(alsoHeard(oneListener('#food'), 'helper', 'slack:app-dm:*', 'slack:group-dm:*').replace('socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"', 'socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\noperator_token_env = "HYDRA_SLACK_USER_TOKEN"'))

  test('the manifest, the events and the startup scope check all follow SLACK_APP_NEEDS, and every message event has its history scope', () => {
    const h = everyOption()
    const m = Bun.YAML.parse(slackManifest(h.slackApps.default)) as Manifest
    const needs = SLACK_APP_NEEDS
    expect(m.oauth_config.scopes.user).toEqual([...needs.userScopes])
    expect(m.settings.event_subscriptions.user_events).toEqual([...needs.userEvents])
    expect(m.settings.event_subscriptions.bot_events).toEqual(expect.arrayContaining([...needs.botEvents.messages, ...needs.botEvents.renames]))
    // The user token hears what the user events say, so it holds the history scope of each.
    for (const e of needs.userEvents) expect([...needs.userScopes] as string[]).toContain(historyOf(e))
    // The bot hears what the bot events say: the scope check asks for the history scope of each, and the manifest grants it.
    const checked = scopesNeeded(h).flatMap(n => n.any)
    for (const e of needs.botEvents.messages) {
      expect(checked).toContain(historyOf(e))
      expect(m.oauth_config.scopes.bot).toContain(historyOf(e))
    }
  })

  test('the operator\'s app subscribes to DMs and group DMs, as the operator and as the bot, and lists the operator\'s DMs', () => {
    expect(SLACK_APP_NEEDS.userScopes).toEqual(expect.arrayContaining(['im:history', 'mpim:history', 'im:read']))
    expect(SLACK_APP_NEEDS.userEvents).toEqual(expect.arrayContaining(['message.im', 'message.mpim']))
    expect(SLACK_APP_NEEDS.botEvents.messages).toEqual(expect.arrayContaining(['message.im', 'message.mpim']))
    expect(SLACK_APP_NEEDS.botScopes.groupDms.any).toEqual(['mpim:history'])
  })

  test('mpim:history is asked for only where slack:group-dm:* is named', () => {
    expect(scopesNeeded(hydra(oneListener('#food'))).flatMap(n => n.any)).not.toContain('mpim:history')
    expect(scopesNeeded(everyOption()).flatMap(n => n.any)).toContain('mpim:history')
  })
})

describe('several apps in one hydra', () => {
  test('the startup scope check adds the membership read, only with more than one app, and only for an app that reads channels', () => {
    expect(scopesNeeded(hydra(BASE))).not.toContain(SLACK_APP_NEEDS.membership.public)
    const shared = hydra(sharedChannel('C0FOOD'))
    expect(scopesNeeded(shared, 'default').at(-1)).toBe(SLACK_APP_NEEDS.membership.public)
    expect(scopesNeeded(shared, 'sales').at(-1)).toBe(SLACK_APP_NEEDS.membership.public)
    expect(scopesNeeded(shared)).not.toContain(SLACK_APP_NEEDS.membership.private)
    // An app that serves no specialist and no rule reads no channel, so it is not asked who is in one.
    expect(scopesNeeded(hydra(TWO_APPS), 'sales')).not.toContain(SLACK_APP_NEEDS.membership.public)
    // A private channel is named: the groups scope is checked too, for the app that reaches it.
    const withPrivate = hydra(`${TWO_APPS}\n[specialists.x]\nworkdir = "/w/x"\nreachable_by = ["role:anyone"]\n[[rules]]\nplace = "slack:G0PRIV"\ntarget = "specialist:x"\n`)
    expect(scopesNeeded(withPrivate).slice(-2)).toEqual([SLACK_APP_NEEDS.membership.public, SLACK_APP_NEEDS.membership.private])
    // Both are scopes the manifest already grants for channel names.
    const m = Bun.YAML.parse(slackManifest(hydra(TWO_APPS).slackApps.sales)) as Manifest
    for (const n of [SLACK_APP_NEEDS.membership.public, SLACK_APP_NEEDS.membership.private]) expect(n.any.every(sc => m.oauth_config.scopes.bot.includes(sc))).toBe(true)
  })

  test('the manifest subscribes to joins and leaves only when asked (several apps declared)', () => {
    const plain = Bun.YAML.parse(slackManifest(hydra(BASE).slackApps.default)) as Manifest
    expect(plain.settings.event_subscriptions.bot_events).not.toContain('member_joined_channel')
    const several = Bun.YAML.parse(slackManifest(hydra(TWO_APPS).slackApps.sales, { several: true })) as Manifest
    expect(several.settings.event_subscriptions.bot_events).toEqual([...plain.settings.event_subscriptions.bot_events, 'member_joined_channel', 'member_left_channel'])
  })

  test('golden: an app is named by its display_name, set or defaulted; the key appears once, as the table to edit', () => {
    const plain = hydra(TWO_APPS).slackApps
    const named = hydra(TWO_APPS.replace('socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"', 'socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\ndisplay_name = "Acme helper"').replace('socket_token_env = "SALES_SLACK_APP_TOKEN"', 'socket_token_env = "SALES_SLACK_APP_TOKEN"\ndisplay_name = "Sales desk"')).slackApps
    // Unset: `default` is what the manifest creates it as, any other app its id.
    expect([appName(plain, 'default'), appName(plain, 'sales')]).toEqual(['hydra', 'sales'])
    expect([appName(named, 'default'), appName(named, 'sales')]).toEqual(['Acme helper', 'Sales desk'])
    expect(appName(named, 'gone')).toBe('gone')   // no longer declared: only its id is known
    expect(appKey(plain, 'default', 'bot_token_env')).toBe('`bot_token_env` of hydra (`[slack.apps.default]`)')
    expect(appKey(named, 'default', 'bot_token_env')).toBe('`bot_token_env` of Acme helper (`[slack.apps.default]`)')
    expect(appKey(named, 'sales', 'operator_token_env')).toBe('`operator_token_env` of Sales desk (`[slack.apps.sales]`)')
    expect(appSuffix(named, 'sales')).toBe(' for Sales desk')
    expect(appSuffix(named, 'default')).toBe(' for Acme helper')
    expect(notConnected(named, 'sales')).toBe('Slack is not connected for Sales desk (hydra.toml does not declare it, or its tokens are not set)')
  })

  test('a lone `default` is just "Slack", named or not', () => {
    const lone = hydra(BASE.replace('socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"', 'socket_token_env = "SLOPBOT_SLACK_APP_TOKEN"\ndisplay_name = "Acme helper"')).slackApps
    expect(appSuffix(lone, 'default')).toBe('')
    expect(appSuffix(hydra(BASE).slackApps, 'default')).toBe('')
    expect(notConnected(lone, 'default')).toBe('Slack is not connected (hydra.toml does not declare it, or its tokens are not set)')
  })
})
