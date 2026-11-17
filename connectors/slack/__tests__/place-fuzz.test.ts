// Differential fuzz: the typed-Place code against its parent. Inputs are generated in the OLD forms (a place a string, a DM with the bot
// `slack:dm`, with a person `slack:dm:<person>`, every group DM `slack:group-dm`, Discord's `discord:dm`), each converted to the new forms by
// a pure mapping, and the frozen parent (fixtures/) and the current code must agree on every routing decision and every resolved setting.
// Only the old forms that have a new spelling are generated: a DM with one named app (`slack:app-dm:<app>`) and a group DM by id
// (`slack:group-dm:<id>`) have no old counterpart, and are tested on their own (config/__tests__/place.test.ts).
import { describe, expect, test } from 'bun:test'
import { DEFAULT_SLACK_APP, mustParsePlace, placeKey, placeOf, type HydraConfig, type Place } from '../../../config/types.js'
import { SLACK_APP_NEEDS } from '../app.js'
import { scopesNeeded } from '../listener.js'
import * as before from './fixtures/places-before-typed-place.js'
import * as routeBefore from '../../../routing/__tests__/fixtures/route-before-typed-place.js'
import * as routeNow from '../../../routing/route.js'
import { dmsDeclared, hearsDms, namedChannels, namedPlace, placeName, placeOptions, placesOf, routedChannels, unresolvedPlaces } from '../watch.js'
import { linkPreviewsOff } from '../../../shared/link-previews.js'

// --- a small seeded generator ------------------------------------------------------------------------------------------------
function rng(seed: number) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
type R = () => number
const pick = <T,>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
const chance = (r: R, p: number) => r() < p
const some = <T,>(r: R, xs: readonly T[], p = 0.5): T[] => xs.filter(() => r() < p)

// --- the mapping from an old place to a new one, and the counts ---------------------------------------------------------------
/** A place written in a rule or `[places]`: `slack:dm` and its kin become `*` of their kind. */
const newKey = (old: string): string =>
  old === 'slack:dm' ? 'slack:app-dm:*'
  : old.startsWith('slack:dm:') ? `slack:person-dm:${old.slice('slack:dm:'.length)}`
  : old === 'slack:group-dm' ? 'slack:group-dm:*'
  : old === 'discord:dm' ? 'discord:app-dm:*'
  : old
/** A place a message happened at: a DM with the bot is the DM with the app that heard it, a group DM is that one group. */
const newAt = (old: string[], app: string): Place[] => {
  const group = old.find(p => /^slack:[CG][A-Z0-9]+$/.test(p) && old.includes('slack:group-dm'))
  return old.map(p => p === 'slack:dm' ? mustParsePlace(`slack:app-dm:${app}`) : p === 'slack:group-dm' ? mustParsePlace(`slack:group-dm:${group!.slice('slack:'.length)}`) : mustParsePlace(newKey(p)))
}
const mapTokens = (text: string) => text.replace(/\b(?:slack|discord|github):[^\s,]+|\bcli\b/g, t => newKey(t))
const counts = { configs: 0, decisions: 0, deliver: 0, refused: 0, unrouted: 0, ignored: 0, placeLists: 0, settings: 0, previews: 0, scopes: 0 }

// --- generated configs (old forms) --------------------------------------------------------------------------------------------
const OLD_PLACES = ['slack:C1', 'slack:C2', 'slack:G1', 'slack:#ops', 'slack:#help', 'slack:dm', 'slack:dm:alice', 'slack:dm:bob', 'slack:group-dm',
  'discord:#feed', 'discord:100', 'discord:dm', 'github:acme/widget', 'cli'] as const
const APPS = ['default', 'sales', 'support'] as const
const TARGETS = ['main', 's1', 's2', 's3'] as const

type OldOptions = { files: boolean; messages: 'addressed' | 'all'; bots: boolean; reactions: 'off' | 'bot-messages' | 'all'; linkPreviews: boolean; ack?: string; defaultApp?: string }
function genOld(r: R): HydraConfig {
  const apps = ['default', ...some(r, ['sales', 'support'], 0.6)]
  const specialists = Object.fromEntries(['s1', 's2', 's3'].map(id => [id, {
    id, workdir: `/w/${id}`, reachableBy: some(r, ['anyone', 'people', 'staff'], 0.4), sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: false,
    ...(chance(r, 0.3) && { pinnedTo: some(r, apps, 0.5) }),
  }]))
  const rules = Array.from({ length: 1 + Math.floor(r() * 6) }, () => {
    const place = chance(r, 0.85) ? pick(r, OLD_PLACES) : undefined
    const app = place === undefined || chance(r, 0.2) ? pick(r, apps) : undefined
    return { target: pick(r, TARGETS), ...(place && { place }), ...(app && { app }), ...(chance(r, 0.25) && { person: pick(r, ['alice', 'bob', 'staff', 'anyone']) }) }
  })
  const places: Record<string, OldOptions> = {}
  for (const p of OLD_PLACES) if (chance(r, 0.35)) {
    const channel = !p.startsWith('slack:dm:') && p !== 'slack:group-dm' && p !== 'slack:dm'
    places[p] = {
      files: chance(r, 0.4), messages: channel && chance(r, 0.5) ? 'all' : 'addressed', bots: chance(r, 0.3), reactions: pick(r, ['off', 'bot-messages', 'all'] as const),
      linkPreviews: chance(r, 0.6), ...(chance(r, 0.5) && { ack: pick(r, ['eyes', 'white_check_mark']) }),
      ...(channel && p.startsWith('slack:') && chance(r, 0.5) && { defaultApp: pick(r, apps) }),
    }
  }
  return {
    operator: 'op', connectors: {}, gateways: {}, slackApps: Object.fromEntries(apps.map(a => [a, {}])), specialists, schedules: {}, rules, places,
    people: {
      op: { id: 'op', addresses: ['slack:UOP'], roles: [] }, alice: { id: 'alice', addresses: ['slack:UALICE'], roles: ['staff'] }, bob: { id: 'bob', addresses: ['slack:UBOB'], roles: [] },
    },
  } as unknown as HydraConfig
}

/** The same config in the new forms: only the places change. */
function toNew(old: HydraConfig): HydraConfig {
  return {
    ...old,
    rules: old.rules.map(x => (x as { place?: string }).place === undefined ? x : { ...x, place: mustParsePlace(newKey((x as unknown as { place: string }).place)) }),
    places: Object.fromEntries(Object.entries(old.places).map(([k, v]) => [newKey(k), v])),
  } as unknown as HydraConfig
}

type OldInbound = { from?: string; at: string[]; addressed: boolean; app?: string; heardBy?: string[]; mentioned?: string[]; bound?: string; boundApp?: string }
function genInbound(r: R, apps: string[]): OldInbound {
  const kind = pick(r, ['channel', 'channel', 'channel', 'bot-dm', 'person-dm', 'group-dm', 'discord', 'discord-dm', 'github', 'cli'] as const)
  const name = pick(r, ['ops', 'help', 'else', undefined])
  const at = kind === 'channel' ? [`slack:${pick(r, ['C1', 'C2', 'C3'])}`, ...(name ? [`slack:#${name}`] : [])]
    : kind === 'bot-dm' ? ['slack:dm']
    : kind === 'person-dm' ? [`slack:dm:${pick(r, ['alice', 'bob'])}`]
    : kind === 'group-dm' ? [`slack:${pick(r, ['G1', 'G2'])}`, ...(name ? [`slack:#${name}`] : []), 'slack:group-dm']
    : kind === 'discord' ? [pick(r, ['discord:#feed', 'discord:100', 'discord:200'])]
    : kind === 'discord-dm' ? ['discord:dm']
    : kind === 'github' ? ['github:acme/widget'] : ['cli']
  const slack = at.some(p => p.startsWith('slack:'))
  return {
    ...(chance(r, 0.9) && { from: pick(r, ['slack:UOP', 'slack:UALICE', 'slack:UBOB', 'slack:UNOBODY']) }),
    at, addressed: chance(r, 0.6),
    ...(slack && { app: pick(r, apps), ...(chance(r, 0.3) && { heardBy: some(r, apps, 0.6) }), ...(chance(r, 0.2) && { mentioned: some(r, apps, 0.5) }), ...(chance(r, 0.15) && { boundApp: pick(r, apps) }) }),
    ...(chance(r, 0.15) && { bound: pick(r, ['s1', 's2', 'main']) }),
  }
}

const brief = (d: any) => ({
  fate: d.fate, to: d.to, via: d.via, bind: d.bind, app: d.app, owner: d.owner, why: d.why, sender: d.sender,
  trace: d.trace.map((s: any) => ({ via: s.via, to: s.to, matched: s.matched, why: s.why })),
})

describe('differential fuzz: typed Place against its parent', () => {
  test('routing: the same decision for every generated inbound, rule set and [places]', () => {
    const r = rng(20261117)
    for (let i = 0; i < 600; i++) {
      const oldCfg = genOld(r)
      const newCfg = toNew(oldCfg)
      counts.configs++
      const apps = Object.keys(oldCfg.slackApps)
      for (let j = 0; j < 60; j++) {
        const m = genInbound(r, apps)
        const mApp = m.app ?? DEFAULT_SLACK_APP
        const oldMsg = m
        const newMsg = { ...m, at: newAt(m.at, mApp) } as any
        const a = routeBefore.route(oldCfg as any, oldMsg as any)
        const b = routeNow.route(newCfg, newMsg)
        // an old trace line names its place as written; the new one as written now
        const old = brief(a)
        old.trace = old.trace.map((s: any) => ({ ...s, why: mapTokens(s.why) }))
        old.why = old.why && mapTokens(old.why)
        expect(brief(b), `config #${i} inbound ${JSON.stringify(m)}`).toEqual(old)
        counts.decisions++
        counts[a.fate as 'deliver']++
        // the helpers route() is built from
        expect(routeNow.owningApp(newCfg, newMsg)).toEqual(routeBefore.owningApp(oldCfg as any, oldMsg as any))
        expect(routeNow.messagesAll(newCfg, newMsg.at)).toBe(routeBefore.messagesAll(oldCfg as any, m.at))
        for (const app of apps) expect(routeNow.reachesAnyone(newCfg, app, newAt(m.at, app))).toBe(routeBefore.reachesAnyone(oldCfg as any, app, m.at))
      }
      for (const app of [undefined, ...apps]) expect(routeNow.slackSpecialistsOf(newCfg, app)).toEqual(routeBefore.slackSpecialistsOf(oldCfg as any, app))
      expect(routeNow.answersLines(newCfg)).toEqual(routeBefore.answersLines(oldCfg as any).map(mapTokens))
    }
  })

  test('the Slack connector: the places a channel goes by, the ones a config names, and the settings that apply', () => {
    const r = rng(1117)
    const scopeKeys = (h: HydraConfig, app: string) => {
      const need = scopesNeeded(h, app)
      const has = (s: unknown) => need.includes(s as never)
      const b = SLACK_APP_NEEDS.botScopes
      return { channels: has(b.channels), dms: has(b.dms), groupDms: has(b.groupDms), channelNames: has(b.channelNames), files: has(b.files), reactionsRead: has(b.reactionsRead), private: has(SLACK_APP_NEEDS.membership.private) }
    }
    for (let i = 0; i < 400; i++) {
      const oldCfg = genOld(r)
      const newCfg = toNew(oldCfg)
      const apps = Object.keys(oldCfg.slackApps)
      const names: Record<string, string> = { C1: 'ops', G1: 'help', ...(chance(r, 0.5) && { C2: 'help' }) }
      const resolved = new Set(some(r, ['ops', 'help', 'else'], 0.5))
      const directory = {
        nameOf: (id: string) => names[id], idOf: (n: string) => resolved.has(n) ? Object.entries(names).find(([, v]) => v === n)?.[0] : undefined,
        isGroupDm: (c: string) => c.startsWith('G'),
        ...(chance(r, 0.5) && { otherPartyOf: (dm: string) => dm === 'D1' ? 'bot' : dm === 'D2' ? { user: 'UALICE' } : dm === 'D3' ? { user: 'UBOB' } : dm === 'D4' ? { user: 'UNOBODY' } : undefined }),
      }
      for (const app of [undefined, ...apps]) {
        const oldView = { hydra: oldCfg, directory, app } as any
        const newView = { hydra: newCfg, directory, app } as any
        const appId = app ?? DEFAULT_SLACK_APP
        for (const channel of ['C1', 'C2', 'C3', 'G1', 'G2', 'D1', 'D2', 'D3', 'D4']) {
          const old = before.placesOf(oldView, channel)
          const now = placesOf(newView, channel)
          expect(now.map(placeKey), `${channel} in ${app}`).toEqual(newAt(old, appId).map(placeKey))
          expect(placeName(newView, channel)).toBe(placeKey(now.at(-1) ?? placeOf("slack", "channel", channel)))
          expect(placeOptions(newView, channel), `options of ${channel}`).toEqual(before.placeOptions(oldView, channel))
          counts.placeLists++
          counts.settings++
          for (const pick_ of [undefined, app]) expect(namedPlace(newView, now, pick_)).toBe(before.namedPlace(oldView, old, pick_))
          for (const platform of ['slack'] as const) {
            expect(linkPreviewsOff(platform, [channel], { config: newCfg, slackName: directory.nameOf, app: appId }), `previews ${channel}`)
              .toBe(before.linkPreviewsOff(platform, [channel], oldCfg.places, directory.nameOf))
            counts.previews++
          }
        }
        for (const platform of ['discord'] as const) {
          for (const ids of [['dm'], ['100'], ['100', '555'], ['200']]) {
            expect(linkPreviewsOff(platform, ids, { config: newCfg })).toBe(before.linkPreviewsOff(platform, ids, oldCfg.places, () => undefined))
            counts.previews++
          }
        }
        expect(namedChannels(newCfg, app).map(placeKey)).toEqual(before.namedChannels(oldCfg, app) as unknown as string[])
        expect(routedChannels(newView)).toEqual(before.routedChannels(oldView))
        expect(unresolvedPlaces(newView).map(placeKey)).toEqual(before.unresolvedPlaces(oldView) as unknown as string[])
        expect(dmsDeclared(newView)).toBe(before.dmsDeclared(oldView))
        expect(hearsDms(newView)).toBe(before.hearsDms(oldView))
        if (app !== undefined) {
          const o = before.optionsOfApp(oldCfg, app)
          expect(scopeKeys(newCfg, app), `scopes of ${app}`).toEqual({ channels: o.channels, dms: o.dms, groupDms: o.groupDms, channelNames: o.channelNames, files: o.files, reactionsRead: o.reactionsRead, private: apps.length > 1 && o.channels && o.privateChannels })
          counts.scopes++
        }
      }
    }
  })

  test('the counts: what the fuzz covered', () => {
    console.log(`place-fuzz: ${JSON.stringify(counts)}`)
    expect(counts.decisions).toBeGreaterThan(30_000)
    // every fate was reached, so agreement is not agreement on one answer
    for (const fate of ['deliver', 'refused', 'unrouted', 'ignored'] as const) expect(counts[fate]).toBeGreaterThan(500)
  })
})
