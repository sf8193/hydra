// `hydra migrate`'s step for `<state>/slack-watch.json`: its routes become hydra.toml tables. `migrateSlackWatch` is
// pure: the old file's JSON in, the tables (in the file's own snake_case keys) and what could not be carried over out.
//
//   (the file existing)               → [slack.apps.default], with the token variables the Slack connector has always read
//   people {U…: {name, role}}         → [people.<id>] addresses = ["slack:U…"], roles = [<role>]
//   route {channels, to}              → [[rules]] place = "slack:C…", target = "specialist:<to>"
//   route {dms: true, to}             → [[rules]] place = "slack:dm", target = "specialist:<to>"
//   route from                        → that specialist's reachable_by (user ids get a role of their own)
//   route files / ack                 → [places."slack:…"] files / ack
//   beforeDeliver                     → [guard]
// The rest (botUserId, workspaceUrl, idleExpiry, coalesceMs, maxWatches, maxMentionsPer10Min) is learned at connect or a
// constant now, so it is dropped, with a note when it was set to something other than the default.

export type SlackWatchMigration = {
  slack: { apps: { default: { bot_token_env: string; socket_token_env: string } } }
  people: Record<string, { addresses: string[]; roles?: string[]; name?: string }>
  /** Only the keys this file decides; the specialist's workdir and kickoff come from specialists.json. */
  specialists: Record<string, { reachable_by: string[] }>
  /** Where each specialist is heard: one rule per place, in route order. */
  rules: { place: string; target: string }[]
  places: Record<string, { files?: true; ack?: string }>
  guard?: { command: string; timeout?: string; include_text?: true }
  /** One line each, for the operator to read. */
  notes: string[]
}

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { MigrateStep } from './migrate.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'
const SLACK_ID = /^[UW][A-Z0-9]+$/

export function migrateSlackWatch(raw: unknown): SlackWatchMigration {
  if (!isObj(raw)) throw new Error('slack-watch.json: must be an object')
  const out: SlackWatchMigration = {
    slack: { apps: { default: { bot_token_env: 'SLOPBOT_SLACK_BOT_TOKEN', socket_token_env: 'SLOPBOT_SLACK_APP_TOKEN' } } },
    people: {}, specialists: {}, rules: [], places: {}, notes: [],
  }
  const note = (s: string) => { out.notes.push(s) }

  // People: an id from their name, else their Slack id; a free-text role becomes a role label.
  const personOf = new Map<string, string>()
  const taken = new Set<string>()
  const addPerson = (user: string, name?: string, role?: string) => {
    let id = slug(name ?? user)
    for (let n = 2; taken.has(id); n++) id = `${slug(name ?? user)}-${n}`
    taken.add(id)
    personOf.set(user, id)
    out.people[id] = { addresses: [`slack:${user}`], ...(name && { name }) , ...(role && { roles: [slug(role)] }) }
  }
  const roleOf = new Map<string, string>() // free text → label
  for (const [user, p] of Object.entries(isObj(raw.people) ? raw.people : {})) {
    if (!SLACK_ID.test(user) || !isObj(p)) { note(`people.${user}: not a Slack user id with {name, role}; left out`); continue }
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : undefined
    const role = typeof p.role === 'string' && p.role.trim() ? p.role.trim() : undefined
    if (role) {
      roleOf.set(role, slug(role))
      if (slug(role) !== role) note(`people.${user}: role "${role}" is now the label "${slug(role)}"`)
    }
    addPerson(user, name, role)
  }

  // Routes, or the one-route legacy form.
  const legacy = raw.channels !== undefined || raw.specialist !== undefined
  const routes: Json[] = legacy
    ? [{ channels: raw.channels, to: raw.specialist, from: raw.from ?? (Object.keys(out.people).length ? 'people' : 'anyone') }]
    : Array.isArray(raw.routes) ? raw.routes.filter(isObj) : []
  for (const [i, r] of routes.entries()) {
    const to = typeof r.to === 'string' ? r.to.trim() : ''
    if (!to) { note(`routes[${i}]: no "to"; left out`); continue }
    const s = out.specialists[to] ??= { reachable_by: [] }
    const places = [
      ...(Array.isArray(r.channels) ? r.channels.filter((c): c is string => typeof c === 'string').map(c => `slack:${c}`) : []),
      ...(r.dms === true ? ['slack:dm'] : []),
    ]
    for (const p of places) {
      if (!out.rules.some(x => x.place === p && x.target === `specialist:${to}`)) out.rules.push({ place: p, target: `specialist:${to}` })
      if (r.files === true || (typeof r.ack === 'string' && r.ack)) {
        out.places[p] = { ...(r.files === true && { files: true as const }), ...(typeof r.ack === 'string' && r.ack && { ack: r.ack }) }
      }
    }
    // from → reachable_by. A user id has no role to name, so it gets one: `<to>-reach`.
    const from = r.from ?? 'people'
    const reachableBy = from === 'anyone' ? ['anyone'] : from === 'people' ? ['people'] : Array.isArray(from) ? from.flatMap(x => {
      if (typeof x !== 'string') return []
      if (roleOf.has(x)) return [roleOf.get(x)!]
      if (SLACK_ID.test(x)) {
        const role = `${slug(to)}-reach`
        if (!personOf.has(x)) addPerson(x)
        const p = out.people[personOf.get(x)!]
        p.roles = [...new Set([...(p.roles ?? []), role])]
        note(`routes[${i}].from: ${x} is a user id, so they now hold the role "${role}"`)
        return [role]
      }
      note(`routes[${i}].from: "${x}" is neither a role in people nor a user id; left out`)
      return []
    }) : []
    if (s.reachable_by.length && JSON.stringify([...s.reachable_by].sort()) !== JSON.stringify([...new Set(reachableBy)].sort())) {
      note(`routes[${i}]: ${to} is reached from several routes with different "from"; its reachable_by is now their union, since one specialist has one reachable_by`)
    }
    s.reachable_by = [...new Set([...s.reachable_by, ...reachableBy])]
    if (r.dms === true) note(`routes[${i}]: the operator's own DMs reach ${to} too, since the operator reaches every specialist; their Slack id must be in [people.<operator>] addresses`)
    if (r.beforeDeliver !== undefined) note(`routes[${i}].beforeDeliver: a guard per route has no hydra.toml form; [guard] applies to every specialist`)
  }

  // The guard.
  const g = raw.beforeDeliver
  if (isObj(g) && typeof g.command === 'string' && g.command.trim()) {
    out.guard = {
      command: g.command.trim(),
      ...(typeof g.timeout === 'string' && g.timeout && { timeout: g.timeout }),
      ...(g.includeText === true && { include_text: true as const }),
    }
    note('beforeDeliver is now [guard]: its stdin is {person, roles, place, conversation, target} (it was {from, channel, thread, dm, to}; hydra still sends `to` beside `target`), a redirect is printed as {"target": ...}, and exit 75 holds a message for at most owed_max = "1h" (it was a day)')
  }

  // What's learned at connect or a constant now.
  const defaults: Record<string, unknown> = { idleExpiry: '7d', coalesceMs: 4000, maxWatches: 50, maxMentionsPer10Min: 10 }
  for (const [k, d] of Object.entries(defaults)) {
    if (raw[k] !== undefined && raw[k] !== '' && raw[k] !== d) note(`${k} = ${JSON.stringify(raw[k])} has no hydra.toml key; the default (${JSON.stringify(d)}) applies`)
  }
  return out
}

const FILE = 'slack-watch.json'

/** The step `hydra migrate` runs: slack-watch.json in, its tables merged with the other steps', the file retired. */
export const slackWatchStep: MigrateStep = {
  name: FILE,
  pending: stateDir => existsSync(join(stateDir, FILE)),
  run({ stateDir }) {
    const path = join(stateDir, FILE)
    if (!existsSync(path)) return undefined
    let raw: unknown
    try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { throw new Error(`${FILE} is not valid JSON: ${(e as Error).message}`) }
    const { notes, ...doc } = migrateSlackWatch(raw)
    return { doc, consumed: [FILE], notes }
  },
}
