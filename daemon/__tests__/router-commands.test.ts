import { describe, test, expect } from 'bun:test'
import { PERMISSION_REPLY_RE } from '../config.js'
import { listModifierKeys } from '../modifiers.js'
import {
  SPAWN_RE, SPAWN_WT_RE, KILL_RE, LIST_RE, RESTART_RE, HEALTH_RE, RECONNECT_RE, COMMANDS_RE,
  THREAD_KILL_RE, DESTROY_RE, USAGE_RE, LISTEN_RE, PAUSE_RE, FORK_RE, FORKS_RE, REVIEW_RE, BUILD_RE,
  KEYS_RE, resolveTmuxKey,
} from '../router.js'

// Suppress stderr
process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

describe('spawn command', () => {
  test('new session: topic', () => {
    const m = 'new session: let us work on hydra'.match(SPAWN_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('let us work on hydra')
  })

  test('spawn: topic', () => {
    const m = 'spawn: fix the bug'.match(SPAWN_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('fix the bug')
  })

  test('/spawn topic', () => {
    const m = '/spawn review PR #42'.match(SPAWN_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('review PR #42')
  })

  test('case insensitive', () => {
    const m = 'Spawn: Hello'.match(SPAWN_RE)
    expect(m).not.toBeNull()
  })

  test('multiline topic captured', () => {
    const m = 'spawn: first line\nsecond line'.match(SPAWN_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('second line')
  })

  test('does not match without topic', () => {
    // Empty topic after trim would be falsy in router
    const m = 'spawn: '.match(SPAWN_RE)
    expect(m).not.toBeNull() // regex matches but topic is whitespace
    expect(m![1].trim()).toBe('') // router checks this
  })
})

// ---------------------------------------------------------------------------
// Spawn worktree
// ---------------------------------------------------------------------------

describe('spawn-wt command', () => {
  test('spawn-wt: repo topic', () => {
    const m = 'spawn-wt: options_bot fix the tests'.match(SPAWN_WT_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('options_bot')
    expect(m![2].trim()).toBe('fix the tests')
  })

  test('/spawn-wt repo topic', () => {
    const m = '/spawn-wt anytester add filters'.match(SPAWN_WT_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('anytester')
    expect(m![2].trim()).toBe('add filters')
  })

  test('does not match without both parts', () => {
    expect('spawn-wt: options_bot'.match(SPAWN_WT_RE)).toBeNull()
    expect('spawn-wt:'.match(SPAWN_WT_RE)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Kill
// ---------------------------------------------------------------------------

describe('kill command', () => {
  test('kill: name', () => {
    const m = 'kill: spark'.match(KILL_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('spark')
  })

  test('kill session: name', () => {
    const m = 'kill session: pixel'.match(KILL_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('pixel')
  })

  test('/kill name', () => {
    const m = '/kill nova'.match(KILL_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('nova')
  })

  test('bare kill matches thread kill, not kill with arg', () => {
    // "kill" alone should match THREAD_KILL_RE, not KILL_RE (which needs an argument)
    expect('kill'.match(KILL_RE)).toBeNull()
    expect('kill'.match(THREAD_KILL_RE)).not.toBeNull()
  })

  // `kill` is gentle (factory builders survive); the cascade variants are the
  // destructive ones. KILL_RE is matched first in the router, so it must not
  // read a cascade flag as a session name.
  test('cascade variants route to thread kill, never to kill-by-name', () => {
    for (const text of ['kill!', '/kill!', 'kill --cascade', '/kill --cascade', 'KILL!']) {
      expect(text.match(KILL_RE)).toBeNull()
      const m = text.match(THREAD_KILL_RE)
      expect(m).not.toBeNull()
      expect(m![1]).toBeTruthy()
    }
  })

  test('bare kill carries no cascade flag', () => {
    expect('kill'.match(THREAD_KILL_RE)![1]).toBeUndefined()
    expect('/kill'.match(THREAD_KILL_RE)![1]).toBeUndefined()
  })

  // `+d` / `+destroy` appends the destroy step. KILL_RE runs first in the
  // router, so a modifier must never be read as the name of a session to kill.
  test('destroy modifier routes to thread kill, never to kill-by-name', () => {
    for (const text of ['kill +d', 'kill +destroy', '/kill +d', '/kill +destroy', 'KILL +D']) {
      expect(text.match(KILL_RE)).toBeNull()
      const m = text.match(THREAD_KILL_RE)
      expect(m).not.toBeNull()
      expect(m![2]).toBeTruthy()
    }
  })

  test('destroy modifier composes with the cascade flag', () => {
    const both = 'kill! +d'.match(THREAD_KILL_RE)
    expect(both![1]).toBe('!')
    expect(both![2]).toBe('d')

    const long = 'kill --cascade +destroy'.match(THREAD_KILL_RE)
    expect(long![1]!.trim()).toBe('--cascade')
    expect(long![2]).toBe('destroy')
  })

  test('bare kill and the cascade forms carry no destroy flag', () => {
    for (const text of ['kill', '/kill', 'kill!', 'kill --cascade']) {
      expect(text.match(THREAD_KILL_RE)![2]).toBeUndefined()
    }
  })

  test('a session named d is still killable by name', () => {
    // Only the `+`-prefixed form is a modifier — the bare name must survive.
    expect('kill: d'.match(KILL_RE)![1].trim()).toBe('d')
    expect('/kill d'.match(KILL_RE)![1].trim()).toBe('d')
    expect('kill: destroy'.match(KILL_RE)![1].trim()).toBe('destroy')
  })

  test('kill-by-name still resolves real names, including flag-shaped ones', () => {
    expect('/kill nova'.match(KILL_RE)![1].trim()).toBe('nova')
    expect('kill: nova'.match(KILL_RE)![1].trim()).toBe('nova')
    // A name that merely starts like a flag is not the cascade form
    expect('/kill --cascade extra'.match(KILL_RE)![1].trim()).toBe('--cascade extra')
  })
})

describe("destroy command", () => {
  test("matches destroy and /destroy", () => {
    expect("destroy".match(DESTROY_RE)).not.toBeNull()
    expect("/destroy".match(DESTROY_RE)).not.toBeNull()
    expect("DESTROY".match(DESTROY_RE)).not.toBeNull()
  })

  test("does not match partial words or arguments", () => {
    expect("destroyer".match(DESTROY_RE)).toBeNull()
    expect("destroy all".match(DESTROY_RE)).toBeNull()
    expect("undestroy".match(DESTROY_RE)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Status commands
// ---------------------------------------------------------------------------

describe('status commands', () => {
  test('/sessions and list sessions', () => {
    expect('/sessions'.match(LIST_RE)).not.toBeNull()
    expect('list sessions'.match(LIST_RE)).not.toBeNull()
    expect('LIST SESSIONS'.match(LIST_RE)).not.toBeNull()
  })

  test('/health, health, status', () => {
    expect('/health'.match(HEALTH_RE)).not.toBeNull()
    expect('health'.match(HEALTH_RE)).not.toBeNull()
    expect('status'.match(HEALTH_RE)).not.toBeNull()
    expect('Status'.match(HEALTH_RE)).not.toBeNull()
  })

  test('/usage, usage', () => {
    expect('/usage'.match(USAGE_RE)).not.toBeNull()
    expect('usage'.match(USAGE_RE)).not.toBeNull()
  })

  test('restart variants', () => {
    expect('/restart'.match(RESTART_RE)).not.toBeNull()
    expect('restart daemon'.match(RESTART_RE)).not.toBeNull()
    expect('restart'.match(RESTART_RE)).not.toBeNull()
  })

  test('reconnect', () => {
    expect('/reconnect'.match(RECONNECT_RE)).not.toBeNull()
    expect('reconnect'.match(RECONNECT_RE)).not.toBeNull()
  })

  test('commands/help', () => {
    expect('/commands'.match(COMMANDS_RE)).not.toBeNull()
    expect('commands'.match(COMMANDS_RE)).not.toBeNull()
    expect('help'.match(COMMANDS_RE)).not.toBeNull()
    expect('/help'.match(COMMANDS_RE)).not.toBeNull()
    expect('list commands'.match(COMMANDS_RE)).not.toBeNull()
    expect('show commands'.match(COMMANDS_RE)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Thread commands
// ---------------------------------------------------------------------------

describe('thread commands', () => {
  test('listen/unlisten and pause/unpause', () => {
    expect('listen'.match(LISTEN_RE)).not.toBeNull()
    expect('unlisten'.match(LISTEN_RE)).not.toBeNull()
    expect('Listen'.match(LISTEN_RE)).not.toBeNull()
    expect('listen extra'.match(LISTEN_RE)).toBeNull()
    // pause has its own pattern in the router (the old copy lumped it into LISTEN_RE)
    expect('pause'.match(LISTEN_RE)).toBeNull()
    expect('pause'.match(PAUSE_RE)).not.toBeNull()
    expect('unpause'.match(PAUSE_RE)).not.toBeNull()
    expect('pause extra'.match(PAUSE_RE)).toBeNull()
  })

  test('fork with and without topic', () => {
    const plain = 'fork'.match(FORK_RE)
    expect(plain).not.toBeNull()
    expect(plain![1]).toBeUndefined()

    const withTopic = 'fork: investigate bug'.match(FORK_RE)
    expect(withTopic).not.toBeNull()
    expect(withTopic![1]).toBe('investigate bug')

    expect('/fork'.match(FORK_RE)).not.toBeNull()
  })

  test('forks', () => {
    expect('forks'.match(FORKS_RE)).not.toBeNull()
    expect('/forks'.match(FORKS_RE)).not.toBeNull()
  })

})

// ---------------------------------------------------------------------------
// Review & Build
// ---------------------------------------------------------------------------

describe('review command', () => {
  test('defaults (no args)', () => {
    const m = '/review'.match(REVIEW_RE)
    expect(m).not.toBeNull()
    expect(m![2]).toBeUndefined() // no rounds
    expect(m![4]).toBeUndefined() // no topic
  })

  test('with rounds', () => {
    const m = 'review 5'.match(REVIEW_RE)
    expect(m).not.toBeNull()
    expect(m![2]).toBe('5')
  })

  test('with rounds and topic', () => {
    const m = '/review 3 focus on error handling'.match(REVIEW_RE)
    expect(m).not.toBeNull()
    expect(m![2]).toBe('3')
    expect(m![4]).toBe('focus on error handling')
  })

  test('review without slash', () => {
    expect('review'.match(REVIEW_RE)).not.toBeNull()
  })
})

// The router builds its `+name` matcher from the live registry, so a modifier
// registered anywhere is a modifier the router can parse. Mirrors the
// construction in router.ts; the key list is the real one.
function extractModifiers(topic: string): { modifiers: string[]; topic?: string } {
  const modKeys = listModifierKeys()
  const modRe = new RegExp(`\\+(${modKeys.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g')
  const modifiers = [...topic.matchAll(modRe)].map(m => m[1])
  if (modifiers.length === 0) return { modifiers, topic }
  return { modifiers, topic: topic.replace(modRe, '').replace(/\s{2,}/g, ' ').trim() || undefined }
}

describe('review modifier extraction', () => {
  test('+subagent and its alias are picked out of the topic', () => {
    expect(extractModifiers('+subagent the auth flow')).toEqual({ modifiers: ['subagent'], topic: 'the auth flow' })
    expect(extractModifiers('+sa the auth flow')).toEqual({ modifiers: ['sa'], topic: 'the auth flow' })
  })

  test('+no-fallback survives the hyphen — a prefix alternative must not win', () => {
    expect(extractModifiers('+no-fallback the auth flow')).toEqual({ modifiers: ['no-fallback'], topic: 'the auth flow' })
    expect(extractModifiers('+nf the auth flow')).toEqual({ modifiers: ['nf'], topic: 'the auth flow' })
  })

  test('+subagent is not swallowed by the shorter +s alias', () => {
    // Alternation is ordered, so `s` is tried first — only the \b anchor stops it
    // from matching the head of `+subagent` and leaving `ubagent` in the topic.
    const { modifiers, topic } = extractModifiers('+subagent auth')
    expect(modifiers).toEqual(['subagent'])
    expect(topic).not.toContain('ubagent')
  })

  test('flags compose with lens modifiers and with a bare topic', () => {
    expect(extractModifiers('+readability +security auth flow'))
      .toEqual({ modifiers: ['readability', 'security'], topic: 'auth flow' })
    expect(extractModifiers('+subagent +security auth flow'))
      .toEqual({ modifiers: ['subagent', 'security'], topic: 'auth flow' })
    expect(extractModifiers('+subagent')).toEqual({ modifiers: ['subagent'], topic: undefined })
  })

  test('an unprefixed word that happens to be a modifier name stays in the topic', () => {
    expect(extractModifiers('subagent review of the parser'))
      .toEqual({ modifiers: [], topic: 'subagent review of the parser' })
  })
})

describe('build command', () => {
  test('defaults (no args)', () => {
    const m = '/build'.match(BUILD_RE)
    expect(m).not.toBeNull()
    expect(m![2]).toBeUndefined()
  })

  test('with rounds and topic', () => {
    const m = 'build 2 add tests'.match(BUILD_RE)
    expect(m).not.toBeNull()
    expect(m![2]).toBe('2')
    expect(m![4]).toBe('add tests')
  })
})

// ---------------------------------------------------------------------------
// Permission reply regex
// ---------------------------------------------------------------------------

describe('permission reply regex', () => {
  test('yes with code', () => {
    const m = PERMISSION_REPLY_RE.exec('y abcde')
    expect(m).not.toBeNull()
    expect(m![1]).toBe('y')
    expect(m![2]).toBe('abcde')
  })

  test('no with code', () => {
    const m = PERMISSION_REPLY_RE.exec('no fghij')
    expect(m).not.toBeNull()
    expect(m![1]).toBe('no')
    expect(m![2]).toBe('fghij')
  })

  test('case insensitive', () => {
    expect(PERMISSION_REPLY_RE.exec('YES ABCDE')).not.toBeNull()
  })

  test('rejects code with excluded letter l', () => {
    // The regex uses [a-km-z] — excludes 'l' to avoid ambiguity
    expect(PERMISSION_REPLY_RE.exec('y abcle')).toBeNull()
  })

  test('rejects wrong code length', () => {
    expect(PERMISSION_REPLY_RE.exec('y abc')).toBeNull()
    expect(PERMISSION_REPLY_RE.exec('y abcdef')).toBeNull()
  })

  test('rejects non-permission messages', () => {
    expect(PERMISSION_REPLY_RE.exec('hello world')).toBeNull()
    expect(PERMISSION_REPLY_RE.exec('yes')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// /keys command
// ---------------------------------------------------------------------------

describe('/keys command', () => {
  test('/keys with CC slash command', () => {
    const m = '/keys /goal fix the bug'.match(KEYS_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('/goal fix the bug')
  })

  test('/keys with /loop', () => {
    const m = '/keys /loop 5m /check-status'.match(KEYS_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('/loop 5m /check-status')
  })

  test('/keys with /compact', () => {
    const m = '/keys /compact'.match(KEYS_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('/compact')
  })

  test('bare keys without slash', () => {
    const m = 'keys /goal fix the bug'.match(KEYS_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('/goal fix the bug')
  })

  test('case insensitive', () => {
    const m = '/Keys /goal test'.match(KEYS_RE)
    expect(m).not.toBeNull()
  })

  test('does not match with only whitespace', () => {
    expect('/keys '.match(KEYS_RE)).toBeNull()
  })

  test('does not match bare /keys', () => {
    expect('/keys'.match(KEYS_RE)).toBeNull()
  })

  test('multiline collapses to single line', () => {
    const m = '/keys /goal fix\nthe bug'.match(KEYS_RE)
    expect(m).not.toBeNull()
    // Router collapses newlines to spaces
    const text = m![1].replace(/\n/g, ' ').trim()
    expect(text).toBe('/goal fix the bug')
  })

  test('does not match /keys in the middle of text', () => {
    expect('please run /keys /goal test'.match(KEYS_RE)).toBeNull()
  })

  // Smart mode detection: all tokens resolve to tmux keys → raw mode (mirrors router's `every`)
  const resolveKey = resolveTmuxKey
  const isRawMode = (text: string) => text.split(/\s+/).every(t => resolveKey(t) !== null)

  test('raw mode: all tmux key names', () => {
    expect(isRawMode('Up Up Enter')).toBe(true)
    expect(isRawMode('Escape')).toBe(true)
    expect(isRawMode('Down Down Down Enter')).toBe(true)
    expect(isRawMode('Tab')).toBe(true)
    expect(isRawMode('C-c')).toBe(true)
  })

  test('raw mode: case insensitive key names', () => {
    expect(isRawMode('up up enter')).toBe(true)
    expect(isRawMode('escape')).toBe(true)
    expect(isRawMode('down down enter')).toBe(true)
    expect(isRawMode('UP DOWN ENTER')).toBe(true)
  })

  test('raw mode: resolves to canonical tmux names', () => {
    expect(resolveKey('up')).toBe('Up')
    expect(resolveKey('enter')).toBe('Enter')
    expect(resolveKey('escape')).toBe('Escape')
    expect(resolveKey('pageup')).toBe('PageUp')
    expect(resolveKey('c-c')).toBe('C-c')
  })

  test('raw mode: single characters as keys', () => {
    expect(isRawMode('3 Enter')).toBe(true)
    expect(isRawMode('y')).toBe(true)
    expect(isRawMode('n Enter')).toBe(true)
    expect(isRawMode('1')).toBe(true)
  })

  test('literal mode: multi-char tokens that are not key names', () => {
    expect(isRawMode('/goal fix the bug')).toBe(false)
    expect(isRawMode('/compact')).toBe(false)
    expect(isRawMode('/model sonnet')).toBe(false)
    expect(isRawMode('hello Enter')).toBe(false)
  })
})
