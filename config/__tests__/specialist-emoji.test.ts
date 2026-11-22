// A specialist's `emoji`: one emoji character, shown in its sessions' thread names in place of the default. It loads only as one
// emoji, is a per-specialist key (never a default), and a config without it loads exactly as before.
import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import type { ConfigIssue } from '../types.js'
import { testLoadEnv } from './load-env.js'
import { emojiProblem } from '../../shared/emoji.js'
import { planAddFragment } from '../../infra/add-fragment.js'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const env = testLoadEnv({ home: '/home/op', isDir: p => p.startsWith('/home/op') })
const line = (i: ConfigIssue) => `${i.path}: ${i.message}`
const BASE = `operator = "op"\n[people.op]\naddresses = ["slack:U0OP"]\n[slack.apps.default]\nbot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"\n`
const toml = (body: string, defaults = '') => `${BASE}${defaults}[specialists.ops]\nworkdir = "/home/op/ops"\n${body}\n[[rules]]\nplace = "slack:#help"\ntarget = "specialist:ops"\n`
const load = (body: string, defaults = '') => loadHydraConfig(toml(body, defaults), env)
const errors = (body: string, defaults = '') => { const r = load(body, defaults); return r.ok ? [] : r.errors.map(line) }

describe('emoji = one emoji character', () => {
  test.each(['🔐', '⚔️', '❤️', '⏰', '🇺🇸', '👩🏽‍💻', '👨‍👩‍👦‍👦', '1️⃣', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'])('%s loads, as written', e => {
    const r = load(`emoji = "${e}"`)
    expect(r.ok && r.config.specialists.ops.emoji).toBe(e)
  })

  test.each([
    ['text', 'security', 'is not one emoji'],
    ['one letter', 'a', 'is not an emoji'],
    ['a digit', '1', 'is not an emoji'],
    ['two emojis', '🔐🔒', 'is not one emoji'],
    ['an emoji and a word', '🔐 ops', 'is not one emoji'],
    ['empty', '', 'is empty'],
    ['a space', ' ', 'has a space around it'],
    ['a space around an emoji', ' 🔐', 'has a space around it'],
    ['a :name:', ':lock:', "is an emoji's name"],
    ['a bare ™', '™', 'shows as text'],
    ['a bare ©', '©', 'shows as text'],
    ['a bare ❤ (no emoji form)', '❤', 'shows as text'],
    ['a keycap without its selector', '1⃣', 'is not an emoji'],
    ['a trailing joiner', '🔐\u200D', 'ends with a joiner'],
    ['a long joiner chain (23 units)', '👩‍👩‍👧‍👦‍👩‍👩‍👧‍👦', 'is longer than 16'],
    ['a flag of no country', '🇿🇿', 'is a flag of no country'],
    ['two regional letters that are no country', '🇶🇶', 'is a flag of no country'],
  ])('%s is refused at the key, saying what to write', (_, value, why) => {
    const e = errors(`emoji = "${value}"`)
    expect(e).toHaveLength(1)
    expect(e[0]).toStartWith('specialists.ops.emoji: ')
    expect(e[0]).toContain(why)
    expect(e[0]).toContain('emoji = "🔐"')
  })

  test('the value is printed JSON-quoted: a newline or escape cannot reach the log as itself', () => {
    const e = errors('emoji = "x\\n\\u001b[31m"')[0]
    expect(e).toContain('"x\\n\\u001b[31m"')
    expect(e).not.toMatch(/[\n\u001b]/)
  })

  test('a number is refused, saying what to write', () => {
    expect(errors('emoji = 5')).toEqual([expect.stringContaining('must be a string: write the one emoji character itself')])
  })

  test('a specialist without one loads exactly as before: no key at all', () => {
    const r = load('')
    expect(r.ok && Object.hasOwn(r.config.specialists.ops, 'emoji')).toBe(false)
  })

  test('it is per specialist: [defaults.specialist] refuses it, and other specialists do not inherit', () => {
    const e = errors('', '[defaults.specialist]\nemoji = "🔐"\n')
    expect(e).toEqual(["defaults.specialist.emoji: can't be a default: an emoji tells one specialist's threads from the others'. Set it under [specialists.<id>]"])
  })

  test('a bad one stops the load even when the specialist is otherwise fine (it is not silently dropped)', () => {
    expect(load('emoji = "nope"').ok).toBe(false)
  })

  test('the validator, on its own', () => {
    expect(emojiProblem('🔐')).toBeUndefined()
    expect(emojiProblem(undefined)).toContain('must be a string')
  })
})

describe('hydra config add takes an emoji in a fragment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'emoji-add-'))
  writeFileSync(join(dir, 'hydra.toml'), `${BASE}[[rules]]\nplace = "slack:#help"\ntarget = "main"\n`)
  test('a good one is added, a bad one refused with the loader\'s message', () => {
    const frag = (e: string) => `[specialists.books]\nworkdir = "/home/op/books"\nemoji = "${e}"\n`
    const good = planAddFragment(dir, env, frag('📚'), '/f.toml')
    expect(good.ok && good.text).toContain('emoji = "📚"')
    const bad = planAddFragment(dir, env, frag('books'), '/f.toml')
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('specialists.books.emoji') })
    rmSync(dir, { recursive: true })
  })
})
