// @ts-nocheck
// FROZEN COPY of how the Slack connector turned a channel into places and read them (connectors/slack/watch.ts, listener.ts,
// shared/link-previews.ts), at the parent of the typed-Place change, where a place was a string and a DM with the bot was `slack:dm`.
// connectors/slack/__tests__/place-fuzz.test.ts runs it beside the typed code on generated inputs. Do not edit it to follow the code.
import { DEFAULT_SLACK_APP } from '../../../../config/types.js'
import { reachableBy } from '../../../../routing/__tests__/fixtures/route-before-typed-place.js'
const placesAnsweredBy = (cfg, id) => [...new Set(cfg.rules.flatMap(r => r.target === id && r.place !== undefined && (r.person === undefined || r.person === 'anyone') ? [r.place] : []))]

const SLACK_DM = 'slack:dm'
const SLACK_GROUP_DM = 'slack:group-dm'
const dmWith = (person: string) => `slack:dm:${person}`
const dmPerson = (p: string) => p.startsWith('slack:dm:') ? p.slice('slack:dm:'.length) : undefined
const namesDmWithOthers = (p: string) => p === SLACK_GROUP_DM || dmPerson(p) !== undefined
const namesAChannel = (p: string) => p !== SLACK_DM && !namesDmWithOthers(p)
const isDm = (channel: string): boolean => /^D[A-Z0-9]+$/.test(channel)

export function placesOf(cfg, channel) {
  const d = cfg.directory
  if (isDm(channel)) {
    const other = d.otherPartyOf ? d.otherPartyOf(channel) : 'bot'
    if (other === 'bot') return [SLACK_DM]
    const who = other && Object.values(cfg.hydra.people).find(p => p.addresses.includes(`slack:${other.user}`))
    return who ? [dmWith(who.id)] : []
  }
  const name = d.nameOf(channel)
  return [`slack:${channel}`, ...(name ? [`slack:#${name}`] : []), ...(d.isGroupDm?.(channel) ? [SLACK_GROUP_DM] : [])]
}

export const placeName = (cfg, channel) => placesOf(cfg, channel).at(-1) ?? `slack:${channel}`

export function namedChannels(h, app) {
  const r = reachableBy(h, app)
  return [...new Set(r.rules.map(x => x.place).filter(p => !!p && p.startsWith('slack:') && namesAChannel(p)))]
}

const channelIdOf = (cfg, place) => {
  const rest = place.slice('slack:'.length)
  return rest.startsWith('#') ? cfg.directory.idOf(rest.slice(1)) : rest
}

export function routedChannels(cfg) {
  if (!cfg) return []
  return [...new Set(namedChannels(cfg.hydra, cfg.app).flatMap(p => channelIdOf(cfg, p) ?? []))]
}

export function unresolvedPlaces(cfg) {
  return namedChannels(cfg.hydra, cfg.app).filter(p => !channelIdOf(cfg, p))
}

export function dmsDeclared(cfg) {
  const r = reachableBy(cfg.hydra, cfg.app)
  return r.rules.some(x => x.place === SLACK_DM)
}

export function namedPlace(cfg, at, app) {
  const r = reachableBy(cfg.hydra, app ?? cfg.app)
  return at.some(p => Object.hasOwn(cfg.hydra.places, p) || r.rules.some(x => x.place === p))
}

export function hearsDms(cfg) {
  if (!cfg) return false
  const h = cfg.hydra
  return dmsDeclared({ hydra: h, app: cfg.app }) || (!!h.operator && !!h.people[h.operator]?.addresses.some(a => a.startsWith('slack:')))
}

export function placeOptions(cfg, channel) {
  for (const p of placesOf(cfg, channel)) if (cfg.hydra.places[p]) return cfg.hydra.places[p]
  return undefined
}

/** The part of `scopesNeeded` that reads places: which options of `[places]` apply to the app (the scopes themselves are SLACK_APP_NEEDS, unchanged). */
export function optionsOfApp(h, app = DEFAULT_SLACK_APP) {
  const r = reachableBy(h, app)
  const places = namedChannels(h, app)
  const dms = hearsDms({ hydra: h, app })
  const everyPlace = r.rules.some(x => x.place === undefined)
  const channels = places.length > 0 || everyPlace || r.specialists.some(sp => placesAnsweredBy(h, sp.id).length === 0)
  const groupDms = r.rules.some(x => x.place === SLACK_GROUP_DM)
  const slackOpts = Object.entries(h.places).filter(([p]) => p.startsWith('slack:') && (everyPlace || places.includes(p) || (p === SLACK_DM && dms) || (p === SLACK_GROUP_DM && groupDms))).map(([, o]) => o)
  return { channels, dms, groupDms, channelNames: places.some(p => p.startsWith('slack:#')), privateChannels: places.some(p => /^slack:G/.test(p)), files: slackOpts.some(o => o.files), reactionsRead: slackOpts.some(o => o.reactions !== 'off') }
}

// shared/link-previews.ts
export function placeKeysOf(platform, ids, slackName) {
  const keys = []
  for (const id of ids) {
    keys.push(`${platform}:${id}`)
    if (platform === 'slack') {
      if (id.startsWith('D')) keys.push('slack:dm')
      const name = slackName(id)
      if (name) keys.push(`slack:#${name}`)
    }
  }
  return keys
}
export function linkPreviewsOff(platform, ids, places, slackName) {
  return placeKeysOf(platform, ids, slackName).some(k => Object.hasOwn(places, k) && places[k].linkPreviews === false)
}
