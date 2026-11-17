// `hydra route`'s request, answered from a loaded config: pure, so the daemon and the tests ask it the same way.
import { normalizeAddress } from '../config/load.js'
import { noSuchApp } from '../config/pins.js'
import { DEFAULT_SLACK_APP, isEvery, parsePlace, type Address, type HydraConfig, type Place } from '../config/types.js'
import { readValue, spelledApp } from '../shared/value-kind.js'
import { explain, answersLines, route } from './route.js'

export const ROUTE_USAGE = 'usage: hydra route --person <person:id|address|stranger> --place <place> [--app <app:id>] [--heard-by <app:id,app:id>] [--mentioned <app:id,app:id>] [--bound <specialist> [--bound-app <app:id>]]'

/** What `hydra route` asks. The app lists are comma-separated apps, each `app:<id>`. */
export type RouteParams = { person?: string; place?: string; bound?: string; app?: string; heardBy?: string; mentioned?: string; boundApp?: string }

/** The flags of `hydra route`, read from its arguments. */
export function routeFlags(args: string[]): { ok: true; params: RouteParams } {
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  const [person, place, bound, app, heardBy, mentioned, boundApp] = [flag('--person'), flag('--place'), flag('--bound'), flag('--app'), flag('--heard-by'), flag('--mentioned'), flag('--bound-app')]
  return { ok: true, params: { person, place, ...(bound && { bound }), ...(app && { app }), ...(heardBy && { heardBy }), ...(mentioned && { mentioned }), ...(boundApp && { boundApp }) } }
}

/**
 * `hydra route --person <person:id|address|stranger> --place <place> [--app <app:id>]`: what routing would do with a new message there, every
 * candidate and why the winner won. `--app` is the app this check runs for, the one that heard the message (default: the app named
 * `default`); `--heard-by` adds the other apps in the channel, and `--mentioned` lists the apps the text tags, first tag first, so
 * ownership shows too. It reads the config and binds nothing.
 */
export function routeFor(h: HydraConfig, p: RouteParams, aliases: (place: Place, app?: string) => Place[]): { ok: true; fate: string; to?: string; report: string } | { ok: false; error: string } {
  if (!p.person || !p.place) return { ok: false, error: ROUTE_USAGE }
  // An app is `app:<id>`. A person is `person:<id>`, an address (`slack:U0ABC`) or `stranger`.
  const appName = (flag: string, v: string): string | Error => { const r = readValue(v, ['app']); return r.ok ? r.name : new Error(`${flag}: ${r.error}`) }
  const named0: [string, string | undefined][] = [['`--app`', p.app], ['`--bound-app`', p.boundApp]]
  for (const [flag, v] of named0) if (v) { const r = appName(flag, v); if (r instanceof Error) return { ok: false, error: r.message } }
  const listFlag = (flag: string, v: string | undefined): string[] | Error | undefined => {
    if (!v) return undefined
    const out: string[] = []
    for (const a of v.split(',').map(x => x.trim()).filter(Boolean)) { const r = appName(flag, a); if (r instanceof Error) return r; out.push(r) }
    return out
  }
  const [heardBy, mentioned] = [listFlag('`--heard-by`', p.heardBy), listFlag('`--mentioned`', p.mentioned)]
  if (heardBy instanceof Error) return { ok: false, error: heardBy.message }
  if (mentioned instanceof Error) return { ok: false, error: mentioned.message }
  const bare = (v: string | undefined) => v === undefined ? undefined : (appName('', v) as string)
  const [person, place] = [p.person, p.place]
  const parsed = parsePlace(place)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  if (isEvery(parsed.place)) return { ok: false, error: `"${place}" names every place of a kind; a message happens at one, so name it (for example slack:app-dm:<app>)` }
  p = { ...p, ...(p.app && { app: bare(p.app) }), ...(p.boundApp && { boundApp: bare(p.boundApp) }) }
  // A DM with an app's bot is heard through that app.
  if (parsed.place.platform === 'slack' && parsed.place.kind === 'app-dm') {
    if (p.app && p.app !== parsed.place.ref) return { ok: false, error: `--app ${spelledApp(p.app)} contradicts --place ${place}: a DM with an app's bot is heard through that app` }
    p = { ...p, app: parsed.place.ref }
  }
  if (p.boundApp && !p.bound) return { ok: false, error: '--bound-app goes with --bound: it names the app the conversation bound to that specialist is bound through' }
  let from: Address | undefined
  if (person !== 'stranger') {
    const known = person.startsWith('person:') ? h.people[person.slice('person:'.length)] : undefined
    from = known ? known.addresses[0] : normalizeAddress(person)
    if (!from) return { ok: false, error: `"${person}" is neither a person in hydra.toml (person:<id>) nor an address like slack:U0ABC` }
  }
  const at = aliases(parsed.place, p.app)   // channel names are read per app: each reads its own workspace's
  // An app only means something on a Slack place; elsewhere the message came through no app.
  const slack = at.some(x => x.platform === 'slack')
  const app = p.app || DEFAULT_SLACK_APP
  const named: [string, string][] = [
    ...(slack ? [[p.app ? '`--app`' : `\`--app\` (default \`${spelledApp(DEFAULT_SLACK_APP)}\`)`, app] as [string, string]] : []),
    ...(heardBy ?? []).map(a => ['`--heard-by`', a] as [string, string]),
    ...(mentioned ?? []).map(a => ['`--mentioned`', a] as [string, string]),
    ...(p.boundApp ? [['`--bound-app`', p.boundApp] as [string, string]] : []),
  ]
  for (const [flag, id] of named) {
    if (!Object.hasOwn(h.slackApps, id)) return { ok: false, error: `${flag}: ${noSuchApp(id, Object.keys(h.slackApps))}` }
  }
  const d = route(h, { ...(from && { from }), at, addressed: true, ...(p.bound && { bound: p.bound }), ...(slack && { app, ...(heardBy && { heardBy }), ...(mentioned && { mentioned }), ...(p.boundApp && { boundApp: p.boundApp }) }) })
  const note = p.app && !slack ? `(\`--app\` ignored: ${p.place} is not a Slack place)\n` : ''
  return { ok: true, fate: d.fate, ...('to' in d && { to: d.to }), report: note + explain(d, h.guard?.command) + (Object.keys(h.specialists).length ? `\n${answersLines(h).join('\n')}` : '') }
}
