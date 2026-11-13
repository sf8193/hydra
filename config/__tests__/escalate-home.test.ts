// What `escalate` needs of hydra.toml, refused at load: a confined specialist's `home` is not a place an operator-access session
// listens on (its text would land where the operator's own account hears), and the operator can be tagged on the home's platform.
import { describe, expect, test } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', sessionNames: ['spark'], isCommand: () => true })
const BASE = `
operator = "op"
[people.op]
ids = ["slack:U0OP"]
[connectors.slack]
bot_token_env = "SLACK_BOT_TOKEN"
[connectors.discord]
bot_token_env = "DISCORD_BOT_TOKEN"
`
const ops = (home: string, extra = '') => `${BASE}
[specialists.ops]
workdir = "~/agents/ops"
listens = ["slack:#ops"]
allow = ["anyone"]
access = "workdir"
${home ? `home = "${home}"` : ''}
${extra}`
const result = (text: string) => loadHydraConfig(text, env)
const errorsOf = (text: string): string[] => { const r = result(text); if (r.ok) throw new Error('expected a refusal'); return r.errors.map(i => `${i.path}: ${i.message}`) }
const loads = (text: string) => { const r = result(text); if (!r.ok) throw new Error(r.errors.map(i => `${i.path}: ${i.message}`).join('\n')); return r }

describe('home must not be a place an operator-access session listens on', () => {
  test('an operator-access specialist listening there is refused, naming both', () => {
    const t = ops('slack:#triage', `[specialists.byte2]\nworkdir = "~/agents/b"\nlistens = ["slack:#triage"]\nallow = []\n`)
    expect(errorsOf(t)).toEqual(['specialists.ops.home: slack:#triage is a place byte2 listens on, and byte2 runs under the operator\'s account: an escalation posted there would be heard by that account; give ops a home only the operator reads'])
  })
  test('a rule that sends a place to main, or to an operator-access specialist, counts as listening', () => {
    const toMain = ops('slack:#triage', `[[rules]]\nat = "slack:#triage"\nto = "main"\n`)
    expect(errorsOf(toMain)).toEqual([expect.stringContaining('specialists.ops.home: slack:#triage is a place main listens on')])
    const toOp = ops('slack:#triage', `[specialists.byte2]\nworkdir = "~/agents/b"\nlistens = []\nallow = []\n[[rules]]\nat = "slack:#triage"\nto = "byte2"\n`)
    expect(errorsOf(toOp)).toEqual([expect.stringContaining('byte2 listens on')])
  })
  test('another confined specialist listening there is fine: it is not the operator\'s account', () => {
    loads(ops('slack:#triage', `[specialists.faq]\nworkdir = "~/agents/ops"\nlistens = ["slack:#triage"]\nallow = ["anyone"]\naccess = "workdir"\n`))
  })
  test('a place nobody listens on is fine, and so is no home at all (it just cannot escalate)', () => {
    loads(ops('slack:#ops-escalations'))
    loads(ops(''))
  })
  test('an operator-access specialist\'s own home is not this rule: it has the operator\'s account anyway', () => {
    loads(`${BASE}\n[specialists.byte2]\nworkdir = "~/agents/b"\nlistens = ["slack:#triage"]\nallow = []\nhome = "slack:#triage"\n`)
  })
  test('the same channel by id and by name are different spellings hydra cannot equate at load: only the same spelling is refused', () => {
    expect(errorsOf(ops('slack:C0TRIAGE', `[specialists.byte2]\nworkdir = "~/agents/b"\nlistens = ["slack:C0TRIAGE"]\nallow = []\n`))).toHaveLength(1)
  })
})

describe('the operator can be tagged where the escalation goes', () => {
  test('a home on a platform where the operator has no address is refused', () => {
    expect(errorsOf(ops('discord:3000'))).toEqual(['specialists.ops.home: escalate tags the operator, and op has no discord: address; add one under [people.op]'])
  })
  test('a home on a platform where the operator has an address loads', () => {
    loads(ops('slack:#ops-escalations'))
  })
  test('an operator-access specialist\'s home is not checked: escalate is not its tool', () => {
    loads(`${BASE}\n[specialists.byte2]\nworkdir = "~/agents/b"\nlistens = ["slack:#triage"]\nallow = []\nhome = "discord:3000"\n`)
  })
})

describe('a home is compared in one spelling, and some places cannot be a home at all', () => {
  const OP_LISTENER = (place: string) => `[specialists.byte2]\nworkdir = "~/agents/b"\nlistens = ["${place}"]\nallow = []\n`
  test('a bare channel id and the discord: place it spells are the same place', () => {
    const t = `${BASE}[people.op2]\nids = ["discord:1"]\n`
    const withDiscord = (home: string, listens: string) => `operator = "op"\n[people.op]\nids = ["slack:U0OP", "discord:777"]\n[connectors.discord]\nbot_token_env = "DISCORD_BOT_TOKEN"\n[connectors.slack]\nbot_token_env = "SLACK_BOT_TOKEN"\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["discord:2000"]\nallow = []\naccess = "workdir"\nhome = "${home}"\n[specialists.byte2]\nworkdir = "~/agents/b"\nlistens = ["${listens}"]\nallow = []\n`
    void t
    expect(errorsOf(withDiscord('3000', 'discord:3000'))).toEqual([expect.stringContaining('specialists.ops.home')])
    expect(errorsOf(withDiscord('discord:3000', 'discord:3000'))).toEqual([expect.stringContaining('specialists.ops.home')])
  })
  test('a name in another case is not a place at all (the loader reads names lowercase), so it cannot be used to slip past the comparison', () => {
    expect(errorsOf(ops('slack:#Triage', OP_LISTENER('slack:#triage'))).join('\n')).toContain('must be a place')
  })
  test.each(['slack:dm', 'discord:dm'])('%s is refused: a DM is not a place only the operator reads', dm => {
    const r = errorsOf(`${BASE}\n[people.op2]\nids = ["discord:1"]\n` + ops(dm).slice(BASE.length) + '')
    expect(r.join('\n')).toContain(`specialists.ops.home: ${dm} is a direct-message place`)
  })
  test.each([['cli', 'cli'], ['github:acme/widget', 'github:acme/widget']])('%s is refused: it is not a chat place hydra can post to', (home) => {
    expect(errorsOf(ops(home)).join('\n')).toContain('specialists.ops.home')
  })
  test('the specialist\'s own listened place is refused: its escalation would land where its own conversations are', () => {
    expect(errorsOf(ops('slack:#ops'))).toEqual(['specialists.ops.home: slack:#ops is a place ops listens on itself: an escalation there is not out of its conversation; give it a home only the operator reads'])
  })
  test('a Discord home given by name is refused at load, not when escalate runs', () => {
    const t = `operator = "op"\n[people.op]\nids = ["discord:777"]\n[connectors.discord]\nbot_token_env = "DISCORD_BOT_TOKEN"\n[specialists.ops]\nworkdir = "~/agents/ops"\nlistens = ["discord:2000"]\nallow = []\naccess = "workdir"\nhome = "discord:#escalations"\n`
    expect(errorsOf(t)).toEqual(['specialists.ops.home: escalate cannot post to a Discord channel by name: use its id (discord:<channel id>)'])
  })
})

describe('a confined specialist with no home', () => {
  test('warns at load that it cannot escalate, naming the key to set', () => {
    const r = loads(ops(''))
    expect(r.warnings.map(w => `${w.path}: ${w.message}`)).toContain('specialists.ops: it has no home, so its escalate tool has nowhere to post and reports that it cannot reach the operator; set `home` to a place only the operator reads')
  })
  test('with a home, no such warning; an operator-access specialist is not asked for one', () => {
    expect(loads(ops('slack:#esc')).warnings.filter(w => w.message.includes('no home'))).toEqual([])
    expect(loads(`${BASE}\n[specialists.byte2]\nworkdir = "~/agents/b"\nlistens = ["slack:#t"]\nallow = []\n`).warnings.filter(w => w.message.includes('no home'))).toEqual([])
  })
})

describe('a rule that names an app and no place', () => {
  const rule = (app: string, to: string) => `[slack.apps.default]\nbot_token_env = "A"\napp_token_env = "B"\n[[rules]]\napp = "${app}"\nto = "${to}"\n`
  const T = (r: string) => ops('slack:#triage', `[specialists.byte2]\nworkdir = "~/agents/b"\nlistens = []\nallow = []\n${r}`).replace('[connectors.slack]\nbot_token_env = "SLACK_BOT_TOKEN"\n', '')
  test('an app-only rule to an operator-access specialist hears every place its app is in, the home included: refused', () => {
    expect(errorsOf(T(rule('default', 'byte2'))).join('\n')).toContain('specialists.ops.home: slack:#triage is heard by the app default, and a rule sends everything default hears to byte2, which runs under the operator\'s account')
  })
  test('the same to main is refused too', () => {
    expect(errorsOf(T(rule('default', 'main'))).join('\n')).toContain('to main, which runs under the operator\'s account')
  })
  test('a rule to a confined specialist, or for another app, is not this refusal', () => {
    loads(T(rule('default', 'ops')))
  })
})
