// Differential fuzz, the other direction: configs and inbounds built directly in the NEW forms, including the ones the old code had no word for
// (slack:person-dm:*, slack:app-dm:<app> and an undeclared app, slack:group-dm:<id>, mixed * and specific, one group DM written both as the channel
// key and as the group-dm key). For each generated inbound the config is lowered to the OLD forms *for that inbound*: a rule or [places] entry that
// names the inbound's place becomes the old string that the old code would have matched there, and one that does not becomes a string no inbound has.
// The lowering decides matching with plain string operations, not with placeCovers, so it is an independent reading of "which places a key names".
// The frozen parent then decides, and the typed code must agree. Where the parent has no scope or setting for a kind (a specific group-dm key
// needs the group scope, as every group-dm rule does), the lowering says so explicitly (see lowerForApp).
import { describe, expect, test } from 'bun:test'
import { DEFAULT_SLACK_APP, mustParsePlace, placeKey, type HydraConfig, type Place } from '../../../config/types.js'
import { SLACK_APP_NEEDS } from '../app.js'
import { scopesNeeded } from '../listener.js'
import * as before from './fixtures/places-before-typed-place.js'
import * as routeBefore from '../../../routing/__tests__/fixtures/route-before-typed-place.js'
import * as routeNow from '../../../routing/route.js'
import { dmsDeclared, namedChannels, namedPlace, placeOptions, placesOf, routedChannels, unresolvedPlaces } from '../watch.js'
import { linkPreviewsOff } from '../../../shared/link-previews.js'

function rng(seed: number) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
type R = () => number
const pick = <T,>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
const chance = (r: R, p: number) => r() < p
const some = <T,>(r: R, xs: readonly T[], p = 0.5): T[] => xs.filter(() => r() < p)

/** The keys a rule or [places] entry may be written with, new forms only. `ghost` is an app no [slack.apps] declares. */
const KEYS = ['slack:C1', 'slack:C2', 'slack:G1', 'slack:#ops', 'slack:#help',
  'slack:person-dm:alice', 'slack:person-dm:bob', 'slack:person-dm:*',
  'slack:app-dm:default', 'slack:app-dm:sales', 'slack:app-dm:ghost', 'slack:app-dm:*',
  'slack:group-dm:G1', 'slack:group-dm:G2', 'slack:group-dm:*',
  'discord:#feed', 'discord:100', 'discord:app-dm:*', 'github:acme/widget', 'cli'] as const
const TARGETS = ['main', 's1', 's2', 's3'] as const
const counts = { configs: 0, decisions: 0, deliver: 0, refused: 0, unrouted: 0, ignored: 0, connectorChecks: 0, previews: 0, scopes: 0, mixedWildcardSpecific: 0, bothGroupForms: 0 }

type Opt = { files: boolean; messages: 'addressed' | 'all'; bots: boolean; reactions: 'off' | 'bot-messages' | 'all'; linkPreviews: boolean; ack?: string; defaultApp?: string }

function genNew(r: R): HydraConfig {
  const apps = ['default', ...some(r, ['sales', 'support'], 0.6)]
  const specialists = Object.fromEntries(['s1', 's2', 's3'].map(id => [id, {
    id, workdir: `/w/${id}`, reachableBy: some(r, ['anyone', 'people', 'staff'], 0.4), sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: false,
    ...(chance(r, 0.3) && { pinnedTo: some(r, apps, 0.5) }),
  }]))
  const rules = Array.from({ length: 1 + Math.floor(r() * 7) }, () => {
    const key = chance(r, 0.85) ? pick(r, KEYS) : undefined
    const app = key === undefined || chance(r, 0.2) ? pick(r, apps) : undefined
    // A rule to main with no place is a catch-all, whose owning-app rule came after the frozen parent: it is fuzzed against main in
    // operator-tag-fuzz.test.ts. Same draw, so every other generated config is unchanged.
    const target = pick(r, TARGETS)
    return { target: key === undefined && target === 'main' ? 's1' : target, ...(key && { place: mustParsePlace(key) }), ...(app && { app }), ...(chance(r, 0.25) && { person: pick(r, ['alice', 'bob', 'staff', 'anyone']) }) }
  })
  const places: Record<string, Opt> = {}
  for (const k of KEYS) if (chance(r, 0.35)) {
    const p = mustParsePlace(k)
    places[k] = {
      files: chance(r, 0.4), messages: p.kind === 'channel' && chance(r, 0.5) ? 'all' : 'addressed', bots: chance(r, 0.3), reactions: pick(r, ['off', 'bot-messages', 'all'] as const),
      linkPreviews: chance(r, 0.6), ...(chance(r, 0.5) && { ack: pick(r, ['eyes', 'white_check_mark']) }),
      ...(p.kind === 'channel' && p.platform === 'slack' && chance(r, 0.5) && { defaultApp: pick(r, apps) }),
    }
  }
  const keys = rules.flatMap(x => x.place ? [placeKey(x.place)] : []).concat(Object.keys(places))
  if (keys.some(k => k.endsWith(':*')) && keys.some(k => /^(slack:(person-dm|app-dm|group-dm):[^*])/.test(k))) counts.mixedWildcardSpecific++
  if (keys.includes('slack:G1') && keys.includes('slack:group-dm:G1')) counts.bothGroupForms++
  return {
    operator: 'op', connectors: {}, gateways: {}, slackApps: Object.fromEntries(apps.map(a => [a, {}])), specialists, schedules: {}, rules, places,
    people: { op: { id: 'op', addresses: ['slack:UOP'], roles: [] }, alice: { id: 'alice', addresses: ['slack:UALICE'], roles: ['staff'] }, bob: { id: 'bob', addresses: ['slack:UBOB'], roles: [] } },
  } as unknown as HydraConfig
}

type Inbound = { at: Place[]; old: string[]; from?: string; addressed: boolean; app?: string; heardBy?: string[]; mentioned?: string[]; bound?: string; boundApp?: string }
function genInbound(r: R, apps: string[]): Inbound {
  const kind = pick(r, ['channel', 'channel', 'channel', 'app-dm', 'app-dm', 'person-dm', 'group-dm', 'group-dm', 'discord', 'discord-dm', 'github', 'cli'] as const)
  const name = pick(r, ['ops', 'help', 'else', undefined])
  const app = pick(r, apps)
  const person = pick(r, ['alice', 'bob'])
  const group = pick(r, ['G1', 'G2'])
  const ch = pick(r, ['C1', 'C2', 'C3'])
  const [keys, old]: [string[], string[]] =
    kind === 'channel' ? [[`slack:${ch}`, ...(name ? [`slack:#${name}`] : [])], [`slack:${ch}`, ...(name ? [`slack:#${name}`] : [])]]
    : kind === 'app-dm' ? [[`slack:app-dm:${app}`], ['slack:dm']]
    : kind === 'person-dm' ? [[`slack:person-dm:${person}`], [`slack:dm:${person}`]]
    : kind === 'group-dm' ? [[`slack:${group}`, ...(name ? [`slack:#${name}`] : []), `slack:group-dm:${group}`], [`slack:${group}`, ...(name ? [`slack:#${name}`] : []), 'slack:group-dm']]
    : kind === 'discord' ? [[pick(r, ['discord:#feed', 'discord:100', 'discord:200'])], []]
    : kind === 'discord-dm' ? [['discord:app-dm:*'], ['discord:dm']]
    : kind === 'github' ? [['github:acme/widget'], ['github:acme/widget']] : [['cli'], ['cli']]
  if (kind === 'discord') old.push(keys[0])
  const slack = keys.some(k => k.startsWith('slack:'))
  return {
    at: keys.map(mustParsePlace), old,
    ...(chance(r, 0.9) && { from: pick(r, ['slack:UOP', 'slack:UALICE', 'slack:UBOB', 'slack:UNOBODY']) }),
    addressed: chance(r, 0.6),
    ...(slack && { app: kind === 'app-dm' ? app : pick(r, apps) }),
    ...(slack && chance(r, 0.3) && { heardBy: some(r, apps, 0.6) }), ...(slack && chance(r, 0.2) && { mentioned: some(r, apps, 0.5) }), ...(slack && chance(r, 0.15) && { boundApp: pick(r, apps) }),
    ...(chance(r, 0.15) && { bound: pick(r, ['s1', 's2', 'main']) }),
  }
}

// --- the lowering: plain string reading of "which places a key names" ------------------------------------------------------------
const DEAD = 'slack:CNOMATCH'
/** Whether a written key names any of the inbound's places: exact key, or a key ending `*` for every place with that prefix. */
const names = (key: string, atKeys: string[]): boolean => key.endsWith(':*') ? atKeys.some(k => k.startsWith(key.slice(0, -1))) : atKeys.includes(key)
/** The old string for the DM place an inbound has (what the old code wrote for it), by the prefix of its key. */
const oldDm = (atKeys: string[]): string | undefined => atKeys.map(k =>
  k.startsWith('slack:app-dm:') ? 'slack:dm' : k.startsWith('discord:app-dm:') ? 'discord:dm' : k.startsWith('slack:person-dm:') ? `slack:dm:${k.slice('slack:person-dm:'.length)}` : k.startsWith('slack:group-dm:') ? 'slack:group-dm' : undefined).find(Boolean)
const lowerKey = (key: string, inbound: Inbound): string => {
  const atKeys = inbound.at.map(placeKey)
  if (!names(key, atKeys)) return DEAD
  return /^(slack|discord):(app-dm|person-dm|group-dm):/.test(key) ? oldDm(atKeys)! : key
}
function lowerFor(cfg: HydraConfig, inbound: Inbound): HydraConfig {
  const atKeys = inbound.at.map(placeKey)
  const places: Record<string, Opt> = {}
  for (const p of inbound.at) {
    const k = placeKey(p)
    const wild = /^(slack|discord):(app-dm|person-dm|group-dm):/.test(k) ? k.replace(/[^:]*$/, '*') : undefined
    const own = Object.hasOwn(cfg.places, k) ? cfg.places[k] : wild !== undefined && Object.hasOwn(cfg.places, wild) ? cfg.places[wild] : undefined
    const oldKey = /^(slack|discord):(app-dm|person-dm|group-dm):/.test(k) ? oldDm([k])! : k
    if (own !== undefined) places[oldKey] = own as never
  }
  void atKeys
  return {
    ...cfg,
    rules: cfg.rules.map(x => x.place ? { ...x, place: lowerKey(placeKey(x.place), inbound) } : x),
    places,
  } as unknown as HydraConfig
}

const brief = (d: any, mapWhy: (s: string) => string) => ({
  fate: d.fate, to: d.to, via: d.via, bind: d.bind, app: d.app, owningApp: d.owningApp, why: d.why, sender: d.sender,
  trace: d.trace.map((s: any) => ({ via: s.via, to: s.to, matched: s.matched, why: mapWhy(s.why) })),
})
const noPlaceText = (s: string) => s.replace(/is for place \S+/, 'is for place X')

describe('differential fuzz in the new forms: typed Place against its parent, after lowering', () => {
  test('routing: 600 configs written in the new forms × 60 inbounds', () => {
    const r = rng(20261118)
    for (let i = 0; i < 600; i++) {
      const cfg = genNew(r)
      counts.configs++
      const apps = Object.keys(cfg.slackApps)
      for (let j = 0; j < 60; j++) {
        const m = genInbound(r, apps)
        const lowered = lowerFor(cfg, m)
        const oldMsg: any = { ...m, at: m.old }
        const newMsg: any = { ...m, at: m.at }
        delete oldMsg.old; delete newMsg.old
        const want = routeBefore.route(lowered as any, oldMsg)
        const got = routeNow.route(cfg, newMsg)
        expect(brief(got, noPlaceText), `config #${i} inbound ${JSON.stringify({ ...m, at: m.at.map(placeKey) })}`).toEqual(brief(want, noPlaceText))
        counts.decisions++
        counts[want.fate as 'deliver']++
        expect(routeNow.owningApp(cfg, newMsg)).toEqual(routeBefore.owningApp(lowered as any, oldMsg))
        expect(routeNow.messagesAll(cfg, newMsg.at)).toBe(routeBefore.messagesAll(lowered as any, m.old))
      }
    }
  })

  test('the Slack connector: places, options, named channels, DMs declared, scopes, link previews', () => {
    const r = rng(1118)
    const scopeKeys = (h: HydraConfig, app: string) => {
      const need = scopesNeeded(h, app)
      const has = (s: unknown) => need.includes(s as never)
      const b = SLACK_APP_NEEDS.botScopes
      return { channels: has(b.channels), dms: has(b.dms), groupDms: has(b.groupDms), channelNames: has(b.channelNames), private: has(SLACK_APP_NEEDS.membership.private) }
    }
    for (let i = 0; i < 400; i++) {
      const cfg = genNew(r)
      const apps = Object.keys(cfg.slackApps)
      const names_: Record<string, string> = { C1: 'ops', G1: 'help', ...(chance(r, 0.5) && { C2: 'help' }) }
      const resolved = new Set(some(r, ['ops', 'help', 'else'], 0.5))
      const directory = {
        nameOf: (id: string) => names_[id], idOf: (n: string) => resolved.has(n) ? Object.entries(names_).find(([, v]) => v === n)?.[0] : undefined,
        isGroupDm: (c: string) => c.startsWith('G'),
        otherPartyOf: (dm: string) => dm === 'D1' ? 'bot' as const : dm === 'D2' ? { user: 'UALICE' } : dm === 'D3' ? { user: 'UBOB' } : undefined,
      }
      for (const app of [undefined, ...apps]) {
        const appId = app ?? DEFAULT_SLACK_APP
        const newView = { hydra: cfg, directory, app } as any
        for (const channel of ['C1', 'C2', 'C3', 'G1', 'G2', 'D1', 'D2', 'D3']) {
          const at = placesOf(newView, channel)
          const old: string[] = at.map(p => placeKey(p)).map(k => /^(slack):(app-dm|person-dm|group-dm):/.test(k) ? oldDm([k])! : k)
          const inbound: Inbound = { at, old, addressed: true }
          const lowered = lowerFor(cfg, inbound)
          const oldView = { hydra: lowered, directory, app } as any
          // the places a channel goes by: the same count the old code gave (a DM with the bot is the app's, a group DM also a channel by id)
          expect(at.length).toBe(before.placesOf({ hydra: cfg, directory, app } as any, channel).length)
          expect(placeOptions(newView, channel), `options ${channel} via ${app}`).toEqual(before.placeOptions(oldView, channel))
          for (const picked of [undefined, app]) expect(namedPlace(newView, at, picked), `named ${channel} via ${app}`).toBe(before.namedPlace(oldView, old, picked))
          counts.connectorChecks++
          // a bot posts into its own DM (D1) and into channels; a DM with a person is never one it sends to
          if (channel === 'D2' || channel === 'D3') continue
          expect(linkPreviewsOff('slack', [channel], { config: cfg, slackName: directory.nameOf, app: app ?? appId }, ''), `previews ${channel} via ${app}`)
            .toBe(before.linkPreviewsOff('slack', [channel], lowered.places, directory.nameOf))
          counts.previews++
        }
        // the gateway's own bot names no [slack.apps] app: its DM is only ever slack:app-dm:*
        const gatewayDm = lowerFor(cfg, { at: [mustParsePlace('slack:app-dm:*')], old: ['slack:dm'], addressed: true })
        expect(linkPreviewsOff('slack', ['D1'], { config: cfg }, ''), 'gateway DM').toBe(before.linkPreviewsOff('slack', ['D1'], gatewayDm.places, () => undefined))
        for (const ids of [['dm'], ['100'], ['100', '555'], ['200']]) {
          const at = ids.map(id => id === 'dm' ? mustParsePlace('discord:app-dm:*') : mustParsePlace(`discord:${id}`))
          const low = lowerFor(cfg, { at, old: ids.map(id => id === 'dm' ? 'discord:dm' : `discord:${id}`), addressed: true })
          expect(linkPreviewsOff('discord', ids, { config: cfg }, '')).toBe(before.linkPreviewsOff('discord', ids, low.places, () => undefined))
          counts.previews++
        }
        // what a config names, as the old code read it once each rule is lowered for this app's view
        const forApp = (h: HydraConfig): HydraConfig => ({
          ...h,
          rules: h.rules.map(x => {
            if (!x.place) return x
            const k = placeKey(x.place)
            if (k.startsWith('slack:app-dm:')) return { ...x, place: (k === 'slack:app-dm:*' || k === `slack:app-dm:${appId}` ? 'slack:dm' : 'slack:dm:zz') as never }
            // a rule for one group DM needs the group-DM scope as the rule for every group DM does
            if (k.startsWith('slack:group-dm:')) return { ...x, place: 'slack:group-dm' as never }
            if (k.startsWith('slack:person-dm:')) return { ...x, place: 'slack:dm:zz' as never }
            return { ...x, place: k as never }
          }),
          places: Object.fromEntries(Object.entries(h.places).flatMap(([k, v]) => {
            if (k.startsWith('slack:app-dm:')) return k === `slack:app-dm:${appId}` || (k === 'slack:app-dm:*' && !Object.hasOwn(h.places, `slack:app-dm:${appId}`)) ? [['slack:dm', v]] : []
            if (k.startsWith('slack:group-dm:') || k.startsWith('slack:person-dm:')) return []
            return [[k, v]]
          })),
        }) as unknown as HydraConfig
        const oldCfg = forApp(cfg)
        const oldView = { hydra: oldCfg, directory, app } as any
        expect(namedChannels(cfg, app).map(placeKey)).toEqual(before.namedChannels(oldCfg, app) as unknown as string[])
        expect(routedChannels(newView)).toEqual(before.routedChannels(oldView))
        expect(unresolvedPlaces(newView).map(placeKey)).toEqual(before.unresolvedPlaces(oldView) as unknown as string[])
        expect(dmsDeclared(newView)).toBe(before.dmsDeclared(oldView))
        counts.connectorChecks += 4
        if (app !== undefined) {
          const o = before.optionsOfApp(oldCfg, app)
          expect(scopeKeys(cfg, app), `scopes of ${app}`).toEqual({ channels: o.channels, dms: o.dms, groupDms: o.groupDms, channelNames: o.channelNames, private: apps.length > 1 && o.channels && o.privateChannels })
          counts.scopes++
        }
      }
    }
  })

  test('the counts: what the new-form fuzz covered', () => {
    console.log(`place-fuzz-new-forms: ${JSON.stringify(counts)}`)
    expect(counts.decisions).toBeGreaterThan(30_000)
    for (const fate of ['deliver', 'refused', 'unrouted', 'ignored'] as const) expect(counts[fate]).toBeGreaterThan(500)
    expect(counts.mixedWildcardSpecific).toBeGreaterThan(100)
    expect(counts.bothGroupForms).toBeGreaterThan(10)
  })
})
