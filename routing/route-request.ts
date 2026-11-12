// `hydra route`'s request, answered from a loaded config: pure, so the daemon and the tests ask it the same way.
import { normalizeAddress } from '../config/load.js'
import { noSuchApp } from '../config/pins.js'
import { DEFAULT_SLACK_APP, type Address, type HydraConfig } from '../config/types.js'
import { explain, route } from './route.js'

export const ROUTE_USAGE = 'usage: hydra route --as <person|address|stranger> --at <place> [--app <app>] [--heard-by <app,app>] [--mentioned <app,app>] [--bound <specialist> [--bound-app <app>]]'

/** What `hydra route` asks. The app lists are comma-separated app ids. */
export type RouteParams = { as?: string; at?: string; bound?: string; app?: string; heardBy?: string; mentioned?: string; boundApp?: string }

/**
 * `hydra route --as <person|address|stranger> --at <place> [--app <app>]`: what routing would do with a new message there, every
 * candidate and why the winner won. `--app` is the app this check runs for, the one that heard the message (default: the app named
 * `default`); `--heard-by` adds the other apps in the channel, and `--mentioned` lists the apps the text tags, first tag first, so
 * ownership shows too. It reads the config and binds nothing.
 */
export function routeFor(h: HydraConfig, p: RouteParams, aliases: (place: string, app?: string) => string[]): { ok: true; fate: string; to?: string; report: string } | { ok: false; error: string } {
  if (!p.as || !p.at) return { ok: false, error: ROUTE_USAGE }
  if (p.boundApp && !p.bound) return { ok: false, error: '--bound-app goes with --bound: it names the app the conversation bound to that specialist is bound through' }
  let from: Address | undefined
  if (p.as !== 'stranger') {
    const person = h.people[p.as]
    from = person ? person.ids[0] : normalizeAddress(p.as)
    if (!from) return { ok: false, error: `"${p.as}" is neither a person in hydra.toml nor an address like slack:U0ABC` }
  }
  const list = (v: string | undefined) => v ? v.split(',').map(a => a.trim()).filter(Boolean) : undefined
  const at = aliases(p.at, p.app)   // channel names are read per app: each reads its own workspace's
  // An app only means something on a Slack place; elsewhere the message came through no app.
  const slack = at.some(x => x.startsWith('slack:'))
  const app = p.app || DEFAULT_SLACK_APP
  const heardBy = list(p.heardBy), mentioned = list(p.mentioned)
  const named: [string, string][] = [
    ...(slack ? [[p.app ? '`--app`' : `\`--app\` (default \`${DEFAULT_SLACK_APP}\`)`, app] as [string, string]] : []),
    ...(heardBy ?? []).map(a => ['`--heard-by`', a] as [string, string]),
    ...(mentioned ?? []).map(a => ['`--mentioned`', a] as [string, string]),
    ...(p.boundApp ? [['`--bound-app`', p.boundApp] as [string, string]] : []),
  ]
  for (const [flag, id] of named) {
    if (!Object.hasOwn(h.slackApps, id)) return { ok: false, error: `${flag}: ${noSuchApp(id, Object.keys(h.slackApps))}` }
  }
  const d = route(h, { ...(from && { from }), at, addressed: true, ...(p.bound && { bound: p.bound }), ...(slack && { app, ...(heardBy && { heardBy }), ...(mentioned && { mentioned }), ...(p.boundApp && { boundApp: p.boundApp }) }) })
  const note = p.app && !slack ? `(\`--app\` ignored: ${p.at} is not a Slack place)\n` : ''
  return { ok: true, fate: d.fate, ...('to' in d && { to: d.to }), report: note + explain(d, h.guard?.command) }
}
