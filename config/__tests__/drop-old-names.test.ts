// The toml names of hydra#652, one test per batch: the new name loads, the old one is an ordinary unknown key (or an ordinary bad value).
// Bare targets (E) and bare person, role and app values (H) are in target-kinds.test.ts and value-kinds.test.ts; `listens` (F) is in rules-home.test.ts.
import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import { testLoadEnv } from './load-env.js'

const env = testLoadEnv({ home: '/home/op', isDir: p => p.startsWith('/home/op'), isCommand: () => true, sessionNames: [] })
const HEAD = `
operator = "op"
[people.op]
addresses = ["slack:U0OP"]
[slack.apps.default]
bot_token_env = "BOT"
`
const SPECIALIST = '[specialists.ops]\nworkdir = "/home/op/ops"\n'
const load = (text: string) => {
  const r = loadHydraConfig(HEAD + text, env)
  return r.ok ? { ok: true as const, errors: [] as string[] } : { ok: false as const, errors: r.errors.map(e => `${e.path}: ${e.message}`) }
}
const loads = (text: string) => { const r = load(text); expect(r.errors).toEqual([]) }
const refuses = (text: string, ...errors: string[]) => expect(load(text).errors).toEqual(errors)

describe('A: rules and places', () => {
  test('place, person, target and messages load; at, from, to, listen and the value mentions are refused', () => {
    loads(`${SPECIALIST}[places."slack:#help"]\nmessages = "addressed"\n[[rules]]\nplace = "slack:#help"\nperson = "person:op"\ntarget = "specialist:ops"\n`)
    refuses(`${SPECIALIST}[[rules]]\nat = "slack:#help"\nfrom = "person:op"\nto = "specialist:ops"\n`,
      'rules[0].at: unknown key "at"', 'rules[0].from: unknown key "from"', 'rules[0].to: unknown key "to"', 'rules[0]: a rule needs `place`, `app` or both; `person` only narrows who it applies to', 'rules[0].target: is required: specialist:<name>, or main')
    refuses('[places."slack:#help"]\nlisten = "all"\n', 'places."slack:#help".listen: unknown key "listen"')
    refuses('[places."slack:#help"]\nmessages = "mentions"\n', 'places."slack:#help".messages: must be one of "addressed", "all"')
  })
})

describe('B: specialists', () => {
  test('restricted, kickoff, kickoff_file, max_sessions, renamed_from and pinned_to load; access, prompt, prompt_file, max, was and apps are refused', () => {
    loads(`${SPECIALIST}restricted = false\nkickoff = "k"\nmax_sessions = 2\nrenamed_from = ["old"]\npinned_to = ["app:default"]\n`)
    loads(`${SPECIALIST}kickoff_file = "k.md"\n`)
    refuses(`${SPECIALIST}access = "workdir"\nprompt = "k"\nprompt_file = "k.md"\nmax = 2\nwas = ["old"]\napps = ["default"]\n`,
      ...['access', 'prompt', 'prompt_file', 'max', 'was', 'apps'].map(k => `specialists.ops.${k}: unknown key "${k}"`))
  })
})

describe('C: people and platform', () => {
  test('addresses, schedule target, message and workdir, socket_token_env, operator_token_env and [slack.apps.<id>] load; ids, to, prompt, cwd, app_token_env, user_token_env and [connectors.slack] are refused', () => {
    loads(`${SPECIALIST}[schedules.s]\ncron = "@daily"\ntarget = "specialist:ops"\nmessage = "m"\nworkdir = "/home/op"\n[slack.apps.sales]\nbot_token_env = "S_BOT"\nsocket_token_env = "S_APP"\noperator_token_env = "S_OP"\ndisplay_name = "Sales"\ndescription = "d"\n`)
    refuses('[people.al]\nids = ["slack:U0A"]\n', 'people.al.ids: unknown key "ids"', 'people.al.addresses: is required: at least one address, like "slack:U0TEST" or "github:alice"')
    refuses(`${SPECIALIST}[schedules.s]\ncron = "@daily"\nto = "main"\nprompt = "m"\ncwd = "/home/op"\n`,
      'schedules.s.to: unknown key "to"', 'schedules.s.prompt: unknown key "prompt"', 'schedules.s.cwd: unknown key "cwd"', 'schedules.s.target: is required unless there is a check (a sensor): specialist:<name>, or main')
    refuses('[slack.apps.sales]\nbot_token_env = "S_BOT"\napp_token_env = "S_APP"\nuser_token_env = "S_OP"\n', 'slack.apps.sales.app_token_env: unknown key "app_token_env"', 'slack.apps.sales.user_token_env: unknown key "user_token_env"')
    refuses('[connectors.slack]\nbot_token_env = "X_BOT"\n', 'connectors.slack: unknown key "slack"')
  })
})

describe('G: remaining names', () => {
  test('reachable_by, mcp_servers (the table and the specialist key), sends_to and [restricted] off_limits load; allow, mcp, talks_to, [mcp.<name>] and [defaults] private_roots are refused', () => {
    loads(`${SPECIALIST}reachable_by = ["role:people"]\nrestricted = true\nmcp_servers = ["dd"]\nsends_to = ["other"]\n[specialists.other]\nworkdir = "/home/op/other"\nsessions = "shared"\n[mcp_servers.dd]\ncommand = "/bin/dd"\ntools = ["t"]\n[restricted]\noff_limits = ["/home/op/notes"]\n`)
    refuses(`${SPECIALIST}allow = ["role:people"]\nmcp = ["dd"]\ntalks_to = ["x"]\n`, ...['allow', 'mcp', 'talks_to'].map(k => `specialists.ops.${k}: unknown key "${k}"`))
    refuses('[mcp.dd]\ncommand = "/bin/dd"\n', 'mcp: unknown key "mcp"')
    refuses('[defaults]\nprivate_roots = ["/home/op/notes"]\n', 'defaults.private_roots: unknown key "private_roots"')
  })
})
