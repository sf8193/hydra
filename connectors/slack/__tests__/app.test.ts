import { describe, test, expect } from 'bun:test'
import { hydra, oneListener, sharedChannel, BASE, TWO_APPS } from './slack-config.js'
import { slackManifest, SLACK_APP_NEEDS, SLACK_APP_DEFAULTS, appKey } from '../app.js'
import { scopesNeeded } from '../listener.js'

type Manifest = {
  display_information: { name: string; description: string }
  features: { bot_user: { display_name: string; always_online: boolean } }
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
    const named = Bun.YAML.parse(slackManifest(sales('display_name = "Sales: helper"\ndescription = "Sales threads."\nuser_token_env = "SALES_USER"'))) as Manifest
    expect(named.display_information).toEqual({ name: 'Sales: helper', description: 'Sales threads.' })
    expect(named.oauth_config.scopes.user).toEqual([...SLACK_APP_NEEDS.userScopes])
  })
})

describe('slackManifest', () => {
  test('the name and description are the ones hydra.toml gives, quoted so any text stays a string', () => {
    const m = manifestOf(withSlack('app_name = "Krust: #1"\napp_description = "Answers threads # in Slack."'))
    expect(m.display_information).toEqual({ name: 'Krust: #1', description: 'Answers threads # in Slack.' })
    expect(m.features.bot_user).toEqual({ display_name: 'Krust: #1', always_online: true })
    expect(m.settings).toMatchObject({ socket_mode_enabled: true, org_deploy_enabled: false })
  })

  test('without app_name or app_description, the defaults', () => {
    const m = manifestOf(BASE)
    expect(m.display_information).toEqual({ name: SLACK_APP_DEFAULTS.name, description: SLACK_APP_DEFAULTS.description })
    expect(m.features.bot_user.display_name).toBe('hydra')
    expect(Bun.YAML.parse(slackManifest(undefined))).toEqual(m)
  })

  test('user scopes and user events only with user_token_env', () => {
    const bot = manifestOf(BASE)
    expect(bot.oauth_config.scopes.user).toBeUndefined()
    expect(bot.settings.event_subscriptions.user_events).toBeUndefined()
    expect(bot.settings.event_subscriptions.bot_events).toEqual(['message.channels', 'message.groups', 'message.im', 'channel_rename', 'group_rename'])
    const user = manifestOf(withSlack('user_token_env = "HYDRA_SLACK_USER_TOKEN"'))
    // The default description tells coworkers the app can read as its installer.
    expect(user.display_information.description).toBe(SLACK_APP_DEFAULTS.description + SLACK_APP_DEFAULTS.userTokenNote)
    expect(user.oauth_config.scopes.user).toEqual([...SLACK_APP_NEEDS.userScopes])
    expect(user.settings.event_subscriptions.user_events).toEqual([...SLACK_APP_NEEDS.userEvents])
  })

  test('the bot scopes are exactly the ones the startup scope check asks for, with every option on', () => {
    // Channels by name, DMs (the operator has a slack: address) and files: every option scopesNeeded knows.
    const h = hydra(oneListener('#food', 'slopbot', '["anyone"]', '[places."slack:#food"]\nfiles = true\n'))
    const checked = scopesNeeded(h)
    expect(checked).toEqual(Object.values(SLACK_APP_NEEDS.botScopes))
    const manifest = Bun.YAML.parse(slackManifest(h.slackApps.default)) as Manifest
    expect(manifest.oauth_config.scopes.bot).toEqual([...new Set(checked.flatMap(n => n.any))])
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
    const withPrivate = hydra(`${TWO_APPS}\n[specialists.x]\nworkdir = "/w/x"\nlistens = ["slack:G0PRIV"]\nallow = ["anyone"]\n`)
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

  test('a key is named for its own app', () => {
    expect(appKey('default', 'bot_token_env')).toBe('`bot_token_env` of the app named `default` (`[slack.apps.default]` or `[connectors.slack]`)')
    expect(appKey('sales', 'bot_token_env')).toBe('`bot_token_env` of the app named `sales` (`[slack.apps.sales]`)')
  })
})
