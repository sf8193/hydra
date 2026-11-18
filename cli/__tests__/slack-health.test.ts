import { describe, test, expect } from 'bun:test'
import { slackHealthLines } from '../helpers.js'

const up = { state: 'up', downMin: null, lastActivityAgeMin: 1, catchUp: { ok: true, ageMin: 3 }, missingScopes: [], tokens: { ok: true } }
const totals = { conversations: 14, readAsOperator: 0, owed: 0, oldestOwedAgeMin: null }

describe('hydra health, Slack lines', () => {
  test('one app named `default`: the single line it has always been', () => {
    expect(slackHealthLines({ listener: up, apps: { default: up }, ...totals })).toEqual(['slack connector: up · catch-up ok 3 min ago · 14 conversations · 0 owed'])
    expect(slackHealthLines({ listener: { ...up, state: 'down', downMin: 9, catchUp: { ok: false, ageMin: 20, reason: 'ratelimited' } }, apps: {}, ...totals, owed: 2, oldestOwedAgeMin: 7, readAsOperator: 1 }))
      .toEqual(['slack connector: down 9 min · catch-up failing (ratelimited) 20 min ago · 14 conversations (1 read as the operator) · 2 owed, oldest 7 min'])
  })

  test('several apps: a header, then one line each with its id, last event, catch-up and scope status', () => {
    const lines = slackHealthLines({
      listener: up,
      apps: {
        default: { ...up, name: 'Acme helper' },
        sales: { ...up, name: 'Sales desk', state: 'down', downMin: 12, lastActivityAgeMin: 14, catchUp: { ok: false, ageMin: 40, reason: 'ratelimited' }, missingScopes: [{ option: 'replies', any: ['chat:write'] }], probeError: 'missing_scope' },
        ops: { name: 'Ops helper', state: 'off', downMin: null, lastActivityAgeMin: null, catchUp: null, tokens: { ok: false, why: '`bot_token_env` of Ops helper (`[slack.apps.ops]`) names OPS_BOT, which has no value in the daemon\'s environment' } },
      },
      ...totals,
    })
    expect(lines).toEqual([
      'slack connector: 3 apps · 14 conversations · 0 owed',
      '  Acme helper: up · last event 1 min ago · catch-up ok 3 min ago · scopes ok',
      '  Sales desk: down 12 min · last event 14 min ago · catch-up failing (ratelimited) 40 min ago · missing chat:write (replies) · membership unreadable (missing_scope) · fix: add the scope Slack names (hydra slack manifest sales), reinstall',
      '  Ops helper: off · `bot_token_env` of Ops helper (`[slack.apps.ops]`) names OPS_BOT, which has no value in the daemon\'s environment',
    ])
  })

  test('an app whose live events are probably off says so on its line, with the fix', () => {
    expect(slackHealthLines({ listener: { ...up, eventsOff: true }, apps: { default: { ...up, eventsOff: true } }, ...totals }))
      .toEqual(['slack connector: up · catch-up ok 3 min ago · live events probably off: turn Enable Events back on · 14 conversations · 0 owed'])
    expect(slackHealthLines({ apps: { sales: { ...up, name: 'Sales desk', eventsOff: true } }, ...totals }).at(-1))
      .toBe('  Sales desk: up · last event 1 min ago · catch-up ok 3 min ago · live events probably off: turn Enable Events back on · scopes ok')
  })

  test('a lone app that is not `default` is still named', () => {
    expect(slackHealthLines({ apps: { sales: { ...up, name: 'Sales desk' } }, ...totals })).toEqual(['slack connector: 1 app · 14 conversations · 0 owed', '  Sales desk: up · last event 1 min ago · catch-up ok 3 min ago · scopes ok'])
  })

  test('a lone `default` app shows an unreadable membership too, with what to do (#669)', () => {
    expect(slackHealthLines({ listener: { ...up, probeError: 'private channel: missing_scope' }, apps: { default: { ...up, probeError: 'private channel: missing_scope' } }, ...totals })).toEqual([
      'slack connector: up · catch-up ok 3 min ago · 14 conversations · 0 owed',
      '  default: membership unreadable (private channel: missing_scope) · fix: add the scope Slack names (hydra slack manifest default), reinstall',
    ])
  })

  test('owed messages past the threshold are listed with their cause, under either form', () => {
    const owedLate = [{ conversation: 'slack:C1:1.1', to: 'specialist:ops', count: 2, oldestAgeMin: 31, cause: 'delivery failing: specialist down' }]
    const expected = '  owed 2 to specialist:ops in slack:C1:1.1, oldest 31 min (past 20 min): delivery failing: specialist down'
    expect(slackHealthLines({ listener: up, apps: { default: up }, ...totals, owed: 2, oldestOwedAgeMin: 31, owedLate, owedLateAfterMin: 20 }).at(-1)).toBe(expected)
    expect(slackHealthLines({ apps: { sales: up }, ...totals, owed: 2, oldestOwedAgeMin: 31, owedLate, owedLateAfterMin: 20 }).at(-1)).toBe(expected)
    expect(slackHealthLines({ listener: up, apps: { default: up }, ...totals, owedLate: [], owedLateAfterMin: 20 })).toHaveLength(1)
  })

  test('a multi-app membership problem says what to do', () => {
    const lines = slackHealthLines({ apps: { sales: { ...up, probeError: 'missing_scope' }, default: up }, ...totals })
    expect(lines[1]).toContain('membership unreadable (missing_scope) · fix: add the scope Slack names (hydra slack manifest sales), reinstall')
  })
})
