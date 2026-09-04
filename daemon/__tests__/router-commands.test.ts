import { describe, test, expect } from 'bun:test'
import { PERMISSION_REPLY_RE } from '../config.js'

// Suppress stderr
process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// Command regex patterns (extracted from router.ts for testing)
// These are the exact patterns used in the message router.
// ---------------------------------------------------------------------------

const SPAWN_RE = /^(?:new session:|spawn:|\/spawn)\s*([\s\S]+)/i
const SPAWN_WT_RE = /^(?:spawn-wt:|\/spawn-wt)\s*(\S+)\s+([\s\S]+)/i
const KILL_RE = /^(?:kill session:|kill:|\/kill)(?!\s*(?:!|--cascade)?(?:\s*\+(?:d|destroy))?\s*$)\s*(.+)/i
const LIST_RE = /^(?:\/sessions|list sessions)\s*$/i
const RESTART_RE = /^(?:\/restart|restart daemon|restart)\s*$/i
const HEALTH_RE = /^(?:\/health|health|status)\s*$/i
const RECONNECT_RE = /^(?:\/reconnect|reconnect)\s*$/i
const COMMANDS_RE = /^(?:\/commands|commands|list commands|show commands|\/help|help)\s*$/i
const THREAD_KILL_RE = /^(?:kill|\/kill)(!|\s+--cascade)?(?:\s*\+(d|destroy))?\s*$/i
const USAGE_RE = /^(?:\/usage|usage)\s*$/i
const LISTEN_RE = /^(listen|pause)\s*$/i
const FORK_RE = /^(?:fork|\/fork)(?::\s*([\s\S]+))?$/i
const FORKS_RE = /^(?:forks|\/forks)\s*$/i
const REVIEW_RE = /^(?:\/review|review)\s*(\d+)?(?:\s+([\s\S]+))?$/i
const BUILD_RE = /^(?:\/build|build)\s*(\d+)?(?:\s+([\s\S]+))?$/i
const BUILD_WT_RE = /^(?:\/build-wt|build-wt):\s*(\S+)\s+(\d+)?(?:\s+([\s\S]+))?$/i

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
  const DESTROY_RE = /^(?:destroy|\/destroy)\s*$/i

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
  test('listen and pause', () => {
    expect('listen'.match(LISTEN_RE)).not.toBeNull()
    expect('pause'.match(LISTEN_RE)).not.toBeNull()
    expect('Listen'.match(LISTEN_RE)).not.toBeNull()
    expect('listen extra'.match(LISTEN_RE)).toBeNull()
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
    expect(m![1]).toBeUndefined() // no rounds
    expect(m![2]).toBeUndefined() // no topic
  })

  test('with rounds', () => {
    const m = 'review 5'.match(REVIEW_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('5')
  })

  test('with rounds and topic', () => {
    const m = '/review 3 focus on error handling'.match(REVIEW_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('3')
    expect(m![2]).toBe('focus on error handling')
  })

  test('review without slash', () => {
    expect('review'.match(REVIEW_RE)).not.toBeNull()
  })
})

describe('build command', () => {
  test('defaults (no args)', () => {
    const m = '/build'.match(BUILD_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toBeUndefined()
  })

  test('with rounds and topic', () => {
    const m = 'build 2 add tests'.match(BUILD_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('2')
    expect(m![2]).toBe('add tests')
  })

  test('build-wt with repo', () => {
    const m = 'build-wt: options_bot 3 fix the handler'.match(BUILD_WT_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('options_bot')
    expect(m![2]).toBe('3')
    expect(m![3]).toBe('fix the handler')
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
// Interrupt prefix
// ---------------------------------------------------------------------------

const INTERRUPT_RE = /^!([\s\S]+)/

describe('interrupt prefix', () => {
  test('! followed by message matches', () => {
    const m = '!stop and do this instead'.match(INTERRUPT_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('stop and do this instead')
  })

  test('! alone does not match (no content)', () => {
    const m = '!'.match(INTERRUPT_RE)
    expect(m).toBeNull()
  })

  test('! with only whitespace captures whitespace', () => {
    const m = '! '.match(INTERRUPT_RE)
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('')
  })

  test('message without ! does not match', () => {
    expect('hello'.match(INTERRUPT_RE)).toBeNull()
    expect('stop doing that'.match(INTERRUPT_RE)).toBeNull()
  })

  test('! in middle of message does not match', () => {
    expect('hey! stop'.match(INTERRUPT_RE)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// /keys command
// ---------------------------------------------------------------------------

const KEYS_RE = /^(?:\/keys|keys)\s+([\s\S]+)/i

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

  // Smart mode detection: all tokens are tmux key names → raw mode
  const TMUX_KEYS = new Set([
    'Enter', 'Escape', 'Tab', 'BTab', 'Space', 'BSpace', 'Delete', 'DC',
    'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
    'PPage', 'NPage', 'IC',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    'C-a', 'C-b', 'C-c', 'C-d', 'C-e', 'C-f', 'C-g', 'C-h', 'C-i', 'C-j',
    'C-k', 'C-l', 'C-m', 'C-n', 'C-o', 'C-p', 'C-q', 'C-r', 'C-s', 'C-t',
    'C-u', 'C-v', 'C-w', 'C-x', 'C-y', 'C-z',
  ])
  const TMUX_KEY_MAP = new Map<string, string>()
  for (const k of [...TMUX_KEYS]) TMUX_KEY_MAP.set(k.toLowerCase(), k)
  const resolveKey = (t: string): string | null => {
    if (t.length === 1) return t
    return TMUX_KEY_MAP.get(t.toLowerCase()) ?? null
  }
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
