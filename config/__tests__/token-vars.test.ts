import { describe, test, expect } from 'bun:test'
import { scanSlackEnvNames, slackEnvNames } from '../token-vars.js'

describe('slackEnvNames', () => {
  test('every token variable a loaded app names: bot, socket and operator', () => {
    expect(slackEnvNames({ slackApps: { x: { id: 'x', botTokenEnv: 'A', socketTokenEnv: 'B', operatorTokenEnv: 'C', displayName: 'x', description: '' } } }).sort()).toEqual(['A', 'B', 'C'])
  })
})

describe('scanSlackEnvNames', () => {
  test('finds the token variables of [connectors.slack] (old form) and every [slack.apps.<id>], and not Discord\'s', () => {
    expect(scanSlackEnvNames(`
[gateways.discord]
bot_token_env = "DISCORD_BOT_TOKEN"
[connectors.slack]
bot_token_env = "A_BOT"
socket_token_env = "A_APP"
[slack.apps.sales]
bot_token_env = "S_BOT"
operator_token_env = "S_USER"
display_name = "Sales"
`).sort()).toEqual(['A_APP', 'A_BOT', 'S_BOT', 'S_USER'])
  })
  test('works when the file is not valid TOML, line by line under the same headers', () => {
    expect(scanSlackEnvNames(`
[gateways.discord]
bot_token_env = "DISCORD_BOT_TOKEN"
[slack.apps.sales]  # the sales app
bot_token_env = "S_BOT"
broken = = =
[slack.apps.ops]
socket_token_env = "O_APP"
[people.op]
bot_token_env = "NOT_A_TOKEN_TABLE"
`).sort()).toEqual(['O_APP', 'S_BOT'])
  })
  test('the old key names are scanned too, so a file not yet migrated still keeps its variables', () => {
    expect(scanSlackEnvNames('[connectors.slack]\nbot_token_env = "A_BOT"\napp_token_env = "A_APP"\nuser_token_env = "A_USER"\n').sort()).toEqual(['A_APP', 'A_BOT', 'A_USER'])
    expect(scanSlackEnvNames('[slack.apps.a]\nbot_token_env = "B"\napp_token_env = "C"\nbroken = = =\n').sort()).toEqual(['B', 'C'])
  })
  test('leaves out what is not a variable name, and non-strings', () => {
    expect(scanSlackEnvNames('[slack.apps.a]\nbot_token_env = "lower"\nsocket_token_env = 5\noperator_token_env = "OK_1"\n')).toEqual(['OK_1'])
    expect(scanSlackEnvNames('')).toEqual([])
  })
})
