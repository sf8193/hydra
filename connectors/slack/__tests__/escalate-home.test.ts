// The loader compares an escalation home with what the operator's account listens on as written; a channel named by id in one place and
// by name in the other is the same channel only once Slack has said so, so the post checks it again (runtime.ts postToSlackHome).
import { afterEach, describe, expect, test } from 'bun:test'
import { _setHydraConfigForTesting } from '../../../daemon/hydra-config.js'
import { homePostGate, postToSlackHome, slackRuntimeDeps } from '../runtime.js'
import { BASE, hydra, view } from './slack-config.js'

process.stderr.write = (() => true) as any

const TOML = (home: string, operatorListens: string, extra = '') => `${BASE}${extra}
[specialists.esc]
workdir = "/w/esc"
listens = ["slack:C0ESC"]
allow = []
access = "workdir"
home = "${home}"
[specialists.byte2]
workdir = "/w/b"
listens = ["${operatorListens}"]
allow = []
`
const posts: string[] = []
const real = slackRuntimeDeps.post
afterEach(() => { slackRuntimeDeps.post = real; slackRuntimeDeps.view = () => null; _setHydraConfigForTesting(undefined); posts.length = 0 })
const setup = (home: string, operatorListens: string, extra = '') => {
  const toml = TOML(home, operatorListens, extra)
  _setHydraConfigForTesting(hydra(toml))
  slackRuntimeDeps.view = () => view(toml, { names: { C0TRIAGE: 'triage' } })
  slackRuntimeDeps.post = async (channel, _t, text) => { posts.push(`${channel}:${text}`); return '1.1' }
}

describe('the home, by id, against a listener by name (or the reverse)', () => {
  test('a home by id that an operator-access specialist listens on by name is not posted to', async () => {
    setup('slack:C0TRIAGE', 'slack:#triage')
    await expect(postToSlackHome('esc', 'x')).rejects.toThrow(/byte2 listens on, and byte2 runs under the operator's account: nothing is posted there/)
    expect(posts).toEqual([])
  })
  test('a home by name that an operator-access specialist listens on by id is not posted to', async () => {
    setup('slack:#triage', 'slack:C0TRIAGE')
    await expect(postToSlackHome('esc', 'x')).rejects.toThrow(/byte2 listens on/)
    expect(posts).toEqual([])
  })
  test('the control: a home nobody of the operator\'s listens on is posted to', async () => {
    setup('slack:C0TRIAGE', 'slack:C0OTHER')
    await postToSlackHome('esc', 'x')
    expect(posts).toEqual(['C0TRIAGE:x'])
  })
})

describe('a rule that names the app and no place', () => {
  test('hears the home through the app the specialist posts as: nothing is posted', async () => {
    setup('slack:C0TRIAGE', 'slack:C0OTHER')
    const cfg = hydra(TOML('slack:C0TRIAGE', 'slack:C0OTHER'))   // the loader refuses this rule next to this home; the post checks again in case the config got here another way
    _setHydraConfigForTesting({ ...cfg, rules: [{ app: 'default', to: 'byte2' }] })
    await expect(postToSlackHome('esc', 'x')).rejects.toThrow(/heard by the app default, and a rule sends everything it hears to byte2, which runs under the operator's account/)
    expect(posts).toEqual([])
  })
})

describe('escalation posts are spaced', () => {
  const real = { ...homePostGate }
  afterEach(() => Object.assign(homePostGate, real))
  test('two posts in a row are at least gapMs apart, in order; a failed one does not stop the next', async () => {
    setup('slack:C0TRIAGE', 'slack:C0OTHER')
    let now = Date.now() + 10_000_000
    const waits: number[] = []
    homePostGate.now = () => now
    homePostGate.sleep = async ms => { waits.push(ms); now += ms }
    let fail = true
    slackRuntimeDeps.post = async (channel, _t, text) => { if (fail) { fail = false; throw new Error('rate_limited') } posts.push(`${channel}:${text}`); return '1.1' }
    await Promise.allSettled([postToSlackHome('esc', 'first'), postToSlackHome('esc', 'second'), postToSlackHome('esc', 'third')])
    expect(posts).toEqual(['C0TRIAGE:second', 'C0TRIAGE:third'])
    expect(waits.length).toBeGreaterThanOrEqual(2)
    expect(waits.every(w => w > 0 && w <= 1200)).toBe(true)
  })
})
