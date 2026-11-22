// The example router kickoff (docs/router-kickoff.example.md) is a prompt a model follows to the letter: every tool, argument and command it
// names must exist, and the tiers it names must be the ones docs/slack-connector.md explains. A rename of any of them fails here, not in a live thread.
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { UNIVERSAL_TOOLS as TOOL_DEFINITIONS } from '../../../shared/tool-definitions.js'
import { MODEL_ALIASES } from '../../../shared/constants.js'
import { loadHydraConfig } from '../../../config/load.js'
import { testLoadEnv } from '../../../config/__tests__/load-env.js'

const ROOT = join(import.meta.dir, '../../..')
const kickoff = readFileSync(join(ROOT, 'docs/router-kickoff.example.md'), 'utf8')
const slackDoc = readFileSync(join(ROOT, 'docs/slack-connector.md'), 'utf8')
const cli = readFileSync(join(ROOT, 'cli/hydra.ts'), 'utf8')
const tool = (name: string) => TOOL_DEFINITIONS.find(t => t.name === name) as unknown as { inputSchema: { properties: Record<string, unknown> } } | undefined

describe('the example router kickoff', () => {
  test('every tool it calls exists, with the arguments it passes', () => {
    for (const [name, args] of [
      ['list_sessions', ['include_ended']], ['send_to_thread', ['target', 'type', 'text']], ['bind_conversation', ['conversation', 'target', 'why']],
      ['spawn_session', ['topic']], ['fetch_messages', ['channel']],
    ] as const) {
      const t = tool(name)
      expect(t, `${name} is not a tool`).toBeDefined()
      for (const a of args) expect(Object.keys(t!.inputSchema.properties), `${name} has no ${a}`).toContain(a)
      expect(kickoff, `the kickoff does not name ${name}`).toContain(name)
    }
  })

  test('every command it runs exists', () => {
    expect(kickoff).toContain('hydra deliver --to thread:<thread_id> --revive')
    expect(cli).toContain('--revive')
    expect(kickoff).toContain('hydra specialist list')
    expect(kickoff).toContain('hydra specialist show')
    expect(cli).toMatch(/hydra specialist set\|show\|rm\|list/)
    expect(kickoff).toContain('hydra deliver --to specialist:<name>')
  })

  test('its five tiers are the five docs/slack-connector.md explains, in the same order', () => {
    const order = (text: string) => [/live session/, /ended session/, /declared specialist/, /new session|nothing fits/, /operator, last|last resort/].map(re => text.replace(/\*/g, '').toLowerCase().search(re))
    for (const text of [kickoff, slackDoc.slice(slackDoc.indexOf('### The app\'s router'))]) {
      const at = order(text)
      expect(at.every(i => i >= 0), `a tier is missing: ${at}`).toBe(true)
      expect([...at].sort((a, b) => a - b)).toEqual(at)
    }
  })

  test('it reads its history from the event stream, writes no log of its own, and a correction is another bind', () => {
    expect(kickoff).not.toContain('decisions.md')
    expect(kickoff).toContain('hydra events --kind bind --since 14d')
    expect(kickoff).toContain('hydra events --conversation <conversation>')
    expect(cli).toContain('hydra [--state-dir <dir>] events [--kind route|bind|unbind]')
    expect(kickoff).toMatch(/a correction/)
    expect(slackDoc).not.toContain('decisions.md')
    expect(kickoff).toMatch(/Never ask a session that declined the same thread again/)
  })

  test('it waits for the asked session\'s reply message in short steps, capped at 2 minutes, never one fixed long sleep', () => {
    expect(kickoff).toMatch(/Wait for that session's reply message/)
    expect(kickoff).toMatch(/Cap the wait at 2 minutes/)
    expect(kickoff).toContain('sleep 10')
    expect(kickoff).not.toMatch(/sleep (\d{3,}|[2-9]\d)\b/)
    expect(kickoff).not.toMatch(/about 2 minutes/)
  })

  test('it never posts in the Slack thread, asks the operator privately, and says what the bind does', () => {
    expect(kickoff).toMatch(/never post in the Slack thread/i)
    expect(kickoff).toContain('Never ask in the Slack thread')
    expect(kickoff).toContain('Nothing is posted in the Slack thread; the notice goes to that session\'s own thread')
    expect(kickoff).not.toContain('posts `→ <name> <link>: <why>` in the thread')
    expect(kickoff).not.toMatch(/do not post in the thread/)
  })

  test('the docs recommend model = "sonnet" for the router, and that is a real alias; the configuration they show loads', () => {
    expect(slackDoc).toContain('model = "sonnet"')
    expect(MODEL_ALIASES.sonnet).toBeDefined()
    const toml = slackDoc.match(/```toml\n(\[slack\.apps\.<the operator's app>\][\s\S]*?)```/)?.[1]
    expect(toml).toBeDefined()
    const text = `operator = "op"\n[people.op]\naddresses = ["slack:UOP"]\n[people.pat]\naddresses = ["slack:UPAT"]\nroles = ["router-approved"]\n[slack.apps.default]\nbot_token_env = "A_BOT"\nsocket_token_env = "A_APP"\n${toml!.replace("[slack.apps.<the operator's app>]\n", '')}`
    const r = loadHydraConfig(text, testLoadEnv({ home: '/home/op', sessionNames: [], isDir: () => true }))
    if (!r.ok) throw new Error(r.errors.map(e => `${e.path}: ${e.message}`).join('\n'))
    expect(r.config.slackApps.default.router).toBe('slack-router')
    expect(r.config.specialists['slack-router'].model).toBe('sonnet')
  })
})
