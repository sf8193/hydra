// `[places]` `reactions`: which of a person's emoji reactions a Slack place delivers to its session.
import { describe, expect, test } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', sessionNames: [], isCommand: () => true })
const BASE = `
operator = "op"
[people.op]
addresses = ["slack:U0OP", "discord:1"]
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
[gateways.discord]
bot_token_env = "DISCORD_BOT_TOKEN"
`
const ok = (text: string) => {
  const r = loadHydraConfig(BASE + text, env)
  if (!r.ok) throw new Error(r.errors.map(i => `${i.path}: ${i.message}`).join('\n'))
  return r.config
}
const errors = (text: string) => {
  const r = loadHydraConfig(BASE + text, env)
  if (r.ok) throw new Error('expected a refusal')
  return r.errors.map(i => `${i.path}: ${i.message}`)
}

describe('[places] reactions', () => {
  test('defaults to off, and takes bot-messages, all and off', () => {
    expect(ok('[places."slack:#ops"]\nack = "eyes"\n').places['slack:#ops'].reactions).toBe('off')
    for (const v of ['off', 'bot-messages', 'all'] as const) expect(ok(`[places."slack:#ops"]\nreactions = "${v}"\n`).places['slack:#ops'].reactions).toBe(v)
    expect(ok('[places."slack:dm"]\nreactions = "bot-messages"\n').places['slack:dm'].reactions).toBe('bot-messages')
  })

  test('any other value is an error naming the choices', () => {
    expect(errors('[places."slack:#ops"]\nreactions = "yes"\n')).toEqual(['places."slack:#ops".reactions: must be one of "off", "bot-messages", "all"'])
    expect(errors('[places."slack:#ops"]\nreactions = true\n')[0]).toContain('places."slack:#ops".reactions')
  })

  test('it applies to Slack only, and not to a DM with a person or a group DM', () => {
    expect(errors('[places."discord:1234"]\nreactions = "all"\n')).toEqual(['places."discord:1234".reactions: discord:1234 is not a Slack place: `reactions` is heard only from Slack'])
    expect(errors('[places."slack:group-dm"]\nreactions = "all"\n')).toEqual(['places."slack:group-dm".reactions: reactions does not apply to slack:group-dm: only ack and files do. Remove it.'])
  })
})
