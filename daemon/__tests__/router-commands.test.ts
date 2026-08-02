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
const KILL_RE = /^(?:kill session:|kill:|\/kill)\s*(.+)/i
const LIST_RE = /^(?:\/sessions|list sessions)\s*$/i
const RESTART_RE = /^(?:\/restart|restart daemon|restart)\s*$/i
const HEALTH_RE = /^(?:\/health|health|status)\s*$/i
const RECONNECT_RE = /^(?:\/reconnect|reconnect)\s*$/i
const COMMANDS_RE = /^(?:\/commands|commands|list commands|show commands|\/help|help)\s*$/i
const THREAD_KILL_RE = /^(?:kill|\/kill)\s*$/i
const USAGE_RE = /^(?:\/usage|usage)\s*$/i
const LISTEN_RE = /^(listen|pause)\s*$/i
const FORK_RE = /^(?:fork|\/fork)(?::\s*([\s\S]+))?$/i
const FORKS_RE = /^(?:forks|\/forks)\s*$/i
const REVIEW_RE = /^(?:\/review|review)(?=[\s:]|$)\s*(?:(\S+?):\s+)?(\d+)?\s*(?:(\S+?):\s+)?([\s\S]+)?$/i
const BUILD_RE = /^(?:\/build|build)(?=[\s:]|$)\s*(?:(\S+?):\s+)?(\d+)?\s*(?:(\S+?):\s+)?([\s\S]+)?$/i

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
    expect(m![1]).toBeUndefined() // no pre-model
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

  test('with model prefix', () => {
    const m = 'review opus-5: 3 focus on auth'.match(REVIEW_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('opus-5')
    expect(m![2]).toBe('3')
    expect(m![4]).toBe('focus on auth')
  })

  test('review without slash', () => {
    expect('review'.match(REVIEW_RE)).not.toBeNull()
  })

  test('does not match reviewing (lookahead)', () => {
    expect('reviewing the auth flow'.match(REVIEW_RE)).toBeNull()
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

  test('does not match building (lookahead)', () => {
    expect('building the new feature'.match(BUILD_RE)).toBeNull()
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
// Deprecated command shims
// ---------------------------------------------------------------------------

const V2_SHIM_RE = /^(?:\/?)(?:review_v2|build_v2|spike_v2|kill\s+(?:review_v2|build_v2|spike_v2))\b/i
const V2_CLEAN_RE = /^(\/?(?:kill\s+)?(?:review|build|spike))_v2/i
const BUILD_WT_RE = /^(?:\/build-wt|build-wt)(?:[:\s]|$)/i

describe('deprecated command shims', () => {
  test('review_v2 is rewritten to review', () => {
    const input = 'review_v2 3 opus: check auth'
    expect(input.match(V2_SHIM_RE)).not.toBeNull()
    const clean = input.replace(V2_CLEAN_RE, '$1').trim()
    expect(clean).toBe('review 3 opus: check auth')
  })

  test('build_v2 is rewritten to build', () => {
    const input = '/build_v2 2 fix the parser'
    expect(input.match(V2_SHIM_RE)).not.toBeNull()
    const clean = input.replace(V2_CLEAN_RE, '$1').trim()
    expect(clean).toBe('/build 2 fix the parser')
  })

  test('kill review_v2 is rewritten to kill review', () => {
    const input = 'kill review_v2'
    expect(input.match(V2_SHIM_RE)).not.toBeNull()
    const clean = input.replace(V2_CLEAN_RE, '$1').trim()
    expect(clean).toBe('kill review')
  })

  test('build-wt matches rejection pattern', () => {
    expect('build-wt: repo task'.match(BUILD_WT_RE)).not.toBeNull()
    expect('/build-wt repo'.match(BUILD_WT_RE)).not.toBeNull()
  })

  test('"reviewing the auth flow" does not match v2 shim', () => {
    expect('reviewing the auth flow'.match(V2_SHIM_RE)).toBeNull()
  })

  test('"build something" does not match v2 shim', () => {
    expect('build something'.match(V2_SHIM_RE)).toBeNull()
  })

  test('/kill review_v2 is rewritten and matches cancel regex', () => {
    const input = '/kill review_v2'
    expect(input.match(V2_SHIM_RE)).not.toBeNull()
    const clean = input.replace(V2_CLEAN_RE, '$1').trim()
    expect(clean).toBe('/kill review')
    expect(clean.match(/^\/?(?:kill review)\s*$/i)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Cancel regexes accept optional leading slash
// ---------------------------------------------------------------------------

describe('cancel commands with leading slash', () => {
  const CANCEL_REVIEW_RE = /^\/?(?:kill review)\s*$/i
  const CANCEL_BUILD_RE = /^\/?(?:kill build)\s*$/i
  const CANCEL_SPIKE_RE = /^\/?(?:kill spike)\s*$/i

  test('/kill review matches', () => {
    expect('/kill review'.match(CANCEL_REVIEW_RE)).not.toBeNull()
  })
  test('kill review matches', () => {
    expect('kill review'.match(CANCEL_REVIEW_RE)).not.toBeNull()
  })
  test('/kill build matches', () => {
    expect('/kill build'.match(CANCEL_BUILD_RE)).not.toBeNull()
  })
  test('/kill spike matches', () => {
    expect('/kill spike'.match(CANCEL_SPIKE_RE)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Colon-form topic extraction
// ---------------------------------------------------------------------------

describe('colon-form topic extraction', () => {
  test('review: topic strips leading colon', () => {
    const m = 'review: focus on auth'.match(REVIEW_RE)
    expect(m).not.toBeNull()
    let topic = m![4]?.trim()
    if (topic?.startsWith(':')) topic = topic.slice(1).trim() || undefined
    expect(topic).toBe('focus on auth')
  })

  test('build: task strips leading colon', () => {
    const m = 'build: implement the parser'.match(BUILD_RE)
    expect(m).not.toBeNull()
    let task = m![4]?.trim()
    if (task?.startsWith(':')) task = task.slice(1).trim() || undefined
    expect(task).toBe('implement the parser')
  })

  test('review opus: topic does NOT strip colon (model alias consumes it)', () => {
    const m = 'review opus: check the auth flow'.match(REVIEW_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('opus')
    let topic = m![4]?.trim()
    if (topic?.startsWith(':')) topic = topic.slice(1).trim() || undefined
    expect(topic).toBe('check the auth flow')
  })
})

// ---------------------------------------------------------------------------
// Design tombstone
// ---------------------------------------------------------------------------

const DESIGN_TOMBSTONE_RE = /^(?:\/?design\s*:|\/design(?:\s|$)|kill\s+design(?:\s|$))/i

describe('design tombstone', () => {
  test('design: triggers tombstone', () => {
    expect('design: a schema'.match(DESIGN_TOMBSTONE_RE)).not.toBeNull()
  })

  test('/design triggers tombstone', () => {
    expect('/design'.match(DESIGN_TOMBSTONE_RE)).not.toBeNull()
  })

  test('kill design triggers tombstone', () => {
    expect('kill design'.match(DESIGN_TOMBSTONE_RE)).not.toBeNull()
  })

  test('"design a better retry policy" does not match tombstone', () => {
    expect('design a better retry policy'.match(DESIGN_TOMBSTONE_RE)).toBeNull()
  })
})
