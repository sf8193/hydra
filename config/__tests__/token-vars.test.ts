import { describe, test, expect } from 'bun:test'
import { scanSlackEnvNames } from '../token-vars.js'

describe('scanSlackEnvNames', () => {
  test('finds the token variables of [connectors.slack] and every [slack.apps.<id>], and not Discord\'s', () => {
    expect(scanSlackEnvNames(`
[connectors.discord]
bot_token_env = "DISCORD_BOT_TOKEN"
[connectors.slack]
bot_token_env = "A_BOT"
app_token_env = "A_APP"
[slack.apps.sales]
bot_token_env = "S_BOT"
user_token_env = "S_USER"
display_name = "Sales"
`).sort()).toEqual(['A_APP', 'A_BOT', 'S_BOT', 'S_USER'])
  })
  test('works when the file is not valid TOML, line by line under the same headers', () => {
    expect(scanSlackEnvNames(`
[connectors.discord]
bot_token_env = "DISCORD_BOT_TOKEN"
[slack.apps.sales]  # the sales app
bot_token_env = "S_BOT"
broken = = =
[slack.apps.ops]
app_token_env = "O_APP"
[people.op]
bot_token_env = "NOT_A_TOKEN_TABLE"
`).sort()).toEqual(['O_APP', 'S_BOT'])
  })
  test('leaves out what is not a variable name, and non-strings', () => {
    expect(scanSlackEnvNames('[slack.apps.a]\nbot_token_env = "lower"\napp_token_env = 5\nuser_token_env = "OK_1"\n')).toEqual(['OK_1'])
    expect(scanSlackEnvNames('')).toEqual([])
  })
})
