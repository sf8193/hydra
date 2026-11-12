import { describe, test, expect } from 'bun:test'
import { hydra, oneListener, BASE } from './slack-config.js'
import { slackManifest, SLACK_APP_NEEDS, SLACK_APP_DEFAULTS } from '../app.js'
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
