import { describe, test, expect } from 'bun:test'
import { scanTokenEnvNames, tokenEnvNames } from '../token-vars.js'

describe('tokenEnvNames', () => {
  const app = { id: 'x', botTokenEnv: 'A', socketTokenEnv: 'B', operatorTokenEnv: 'C', displayName: 'x', description: '' }
  test('every token variable a loaded app names: bot, socket and operator', () => {
    expect(tokenEnvNames({ slackApps: { x: app }, gateways: {} }).sort()).toEqual(['A', 'B', 'C'])
  })
  test('and the Discord gateway\'s, and each server\'s token_env, once each', () => {
    const server = (name: string, tokenEnv: string[]) => ({ name, command: '/bin/x', tokenEnv, tools: [] })
    expect(tokenEnvNames({
      slackApps: { x: app }, gateways: { discord: { botTokenEnv: 'G' } },
      mcpServers: { dd: server('dd', ['DD_KEY', 'SHARED']), gh: server('gh', ['SHARED', 'GH_KEY']) },
    }).sort()).toEqual(['A', 'B', 'C', 'DD_KEY', 'G', 'GH_KEY', 'SHARED'])
  })
})

describe('scanTokenEnvNames', () => {
  test('finds the token variables of every [slack.apps.<id>], the Discord gateway\'s and every [mcp_servers.<name>] token_env', () => {
    expect(scanTokenEnvNames(`
[gateways.discord]
bot_token_env = "DISCORD_BOT_TOKEN"
[slack.apps.default]
bot_token_env = "A_BOT"
socket_token_env = "A_APP"
[slack.apps.sales]
bot_token_env = "S_BOT"
operator_token_env = "S_USER"
display_name = "Sales"
[mcp_servers.datadog]
command = "/bin/dd"
token_env = ["DD_API_KEY", "DD_APP_KEY"]
[mcp_servers.other]
command = "/bin/o"
`).sort()).toEqual(['A_APP', 'A_BOT', 'DD_API_KEY', 'DD_APP_KEY', 'DISCORD_BOT_TOKEN', 'S_BOT', 'S_USER'])
  })
  test('works when the file is not valid TOML, line by line under the same headers', () => {
    expect(scanTokenEnvNames(`
[gateways.discord]
bot_token_env = "DISCORD_BOT_TOKEN"
[slack.apps.sales]  # the sales app
bot_token_env = "S_BOT"
broken = = =
[slack.apps.ops]
socket_token_env = "O_APP"
[mcp_servers.dd]
token_env = ["DD_KEY", "DD_APP"]  # two
[mcp_servers.multi]
token_env = [
  "M_ONE",  # first
  "M_TWO",
]
command = "/bin/m"
[mcp_servers.after]
command = "NOT_A_NAME"
[people.op]
bot_token_env = "NOT_A_TOKEN_TABLE"
token_env = ["NOT_A_TOKEN_TABLE_EITHER"]
`).sort()).toEqual(['DD_APP', 'DD_KEY', 'DISCORD_BOT_TOKEN', 'M_ONE', 'M_TWO', 'O_APP', 'S_BOT'])
  })
  test('the old key names and [connectors.slack] are not scanned: they do not load either', () => {
    expect(scanTokenEnvNames('[connectors.slack]\nbot_token_env = "A_BOT"\n[slack.apps.a]\nbot_token_env = "B"\napp_token_env = "C"\nuser_token_env = "D"\n')).toEqual(['B'])
  })
  test('leaves out what is not a variable name, and non-strings', () => {
    expect(scanTokenEnvNames('[slack.apps.a]\nbot_token_env = "lower"\nsocket_token_env = 5\noperator_token_env = "OK_1"\n')).toEqual(['OK_1'])
    expect(scanTokenEnvNames('')).toEqual([])
  })
})
