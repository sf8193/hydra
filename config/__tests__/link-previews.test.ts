// `[places]` `link_previews`: the option, its default, and the load warning for a confined specialist anyone can talk to.
import { describe, expect, test } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import type { HydraConfig } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', sessionNames: ['spark'], isCommand: () => true })
const BASE = `
operator = "op"
[people.op]
ids = ["slack:U0OP", "discord:1"]
[connectors.slack]
bot_token_env = "SLACK_BOT_TOKEN"
[connectors.discord]
bot_token_env = "DISCORD_BOT_TOKEN"
`
const ok = (text: string) => {
  const r = loadHydraConfig(BASE + text, env)
  if (!r.ok) throw new Error(r.errors.map(i => `${i.path}: ${i.message}`).join('\n'))
  return { config: r.config as HydraConfig, warnings: r.warnings.map(i => `${i.path}: ${i.message}`) }
}
const errors = (text: string) => {
  const r = loadHydraConfig(BASE + text, env)
  if (r.ok) throw new Error('expected a refusal')
  return r.errors.map(i => `${i.path}: ${i.message}`)
}
const specialist = (access: string, allow: string, places = '') => `
[specialists.ops]
workdir = "~/agents/ops"
listens = ["slack:#ops"]
allow = [${allow}]
access = "${access}"
${places}`

describe('link_previews', () => {
  test('defaults to on, for a place that sets other options and for a place not declared at all', () => {
    const { config } = ok(`[places."slack:#ops"]\nlisten = "all"\n`)
    expect(config.places['slack:#ops'].linkPreviews).toBe(true)
    expect(config.places['slack:#other']).toBeUndefined()
  })
  test('false turns it off for that place only', () => {
    const { config } = ok(`[places."slack:#ops"]\nlink_previews = false\n[places."slack:#faq"]\nlisten = "all"\n`)
    expect(config.places['slack:#ops'].linkPreviews).toBe(false)
    expect(config.places['slack:#faq'].linkPreviews).toBe(true)
  })
  test('is a boolean', () => {
    expect(errors(`[places."slack:#ops"]\nlink_previews = "no"\n`)).toEqual([expect.stringContaining('places."slack:#ops".link_previews')])
  })
})

describe('the load warning', () => {
  const warn = (w: string[]) => w.filter(x => x.includes('link_previews'))
  test('a confined specialist anyone can talk to, on a place with previews on, warns and names the place and the fix', () => {
    const { warnings } = ok(specialist('workdir', '"anyone"'))
    expect(warn(warnings)).toEqual(['specialists.ops: anyone can talk to it in slack:#ops, where a link in its answer unfurls a preview that can show readers content they could not open themselves; set link_previews = false in [places."slack:#ops"]'])
  })
  test('the same place with previews off does not warn', () => {
    expect(warn(ok(specialist('workdir', '"anyone"', '[places."slack:#ops"]\nlink_previews = false\n')).warnings)).toEqual([])
  })
  test('a place declared for other options, previews still on, warns', () => {
    expect(warn(ok(specialist('workdir', '"anyone"', '[places."slack:#ops"]\nlisten = "all"\n')).warnings)).toHaveLength(1)
  })
  test('allow without anyone does not warn', () => {
    expect(warn(ok(specialist('workdir', '"people"')).warnings)).toEqual([])
    expect(warn(ok(specialist('workdir', '')).warnings)).toEqual([])
  })
  test('an operator-access specialist is not this warning (it has its own)', () => {
    expect(warn(ok(specialist('operator', '"anyone"')).warnings)).toEqual([])
  })
  test('one warning lists each place that still has previews on', () => {
    const t = `
[specialists.ops]
workdir = "~/agents/ops"
listens = ["slack:#ops", "slack:#faq", "slack:#quiet"]
allow = ["anyone"]
access = "workdir"
[places."slack:#quiet"]
link_previews = false
`
    expect(warn(ok(t).warnings)).toEqual(['specialists.ops: anyone can talk to it in slack:#ops and slack:#faq, where a link in its answer unfurls a preview that can show readers content they could not open themselves; set link_previews = false in [places."slack:#ops"] and [places."slack:#faq"]'])
  })
  test('cli and github are not places with previews', () => {
    const t = `
[specialists.ops]
workdir = "~/agents/ops"
listens = ["cli"]
allow = ["anyone"]
access = "workdir"
`
    expect(warn(ok(t).warnings)).toEqual([])
  })
})

describe('a Discord channel given by name', () => {
  test('link_previews = false on a discord:#name place is refused: hydra reads Discord channels by id, so it could never apply', () => {
    expect(errors(`[places."discord:#ops"]\nlink_previews = false\n`)).toEqual(['places."discord:#ops".link_previews: cannot be set on a Discord channel by name: hydra reads a Discord channel by id, so name it discord:<channel id>'])
  })
  test('by id it is accepted, and link_previews = true on a name is harmless', () => {
    expect(ok(`[places."discord:200000000000000001"]\nlink_previews = false\n`).config.places['discord:200000000000000001'].linkPreviews).toBe(false)
    ok(`[places."discord:#ops"]\nlink_previews = true\n`)
  })
  test('the warning does not count a named Discord channel as one previews can be switched off in: it says to use the id', () => {
    const t = `
[specialists.ops]
workdir = "~/agents/ops"
listens = ["discord:#ops"]
allow = ["anyone"]
access = "workdir"
home = "slack:#esc"
`
    const w = ok(t).warnings.filter(x => x.includes('link_previews') || x.includes('previews'))
    expect(w).toEqual(['specialists.ops: anyone can talk to it in discord:#ops, where a link in its answer unfurls a preview that can show readers content they could not open themselves; hydra can switch previews off in a Discord channel only by id, so list it as discord:<channel id> and set link_previews = false there'])
  })
})
