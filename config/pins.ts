// Which specialist an app can deliver to. One predicate for the loader (which refuses what can never be reached) and for routing
// (which skips it): a specialist pinned to apps takes only messages that come through them, and an app that any specialist is
// pinned to delivers only to specialists pinned to it. Pure, and over the specialists alone so it needs no loaded config.

import type { Specialist } from './types.js'

export type Pinnable = Pick<Specialist, 'id' | 'apps'>
export type Specialists = Record<string, Pinnable>

/** The specialists pinned to `app`. */
export function pinnersOf(specialists: Specialists, app: string): string[] {
  return Object.values(specialists).filter(s => s.apps?.includes(app)).map(s => s.id)
}

/** Whether a message that came through `app` (none: it did not come through a Slack app) can be delivered to `s`. */
export function serves(specialists: Specialists, s: Pinnable, app: string | undefined): boolean {
  if (s.apps) return app !== undefined && s.apps.includes(app)
  return app === undefined || pinnersOf(specialists, app).length === 0
}

/** Why `app` cannot deliver to `s`, in words that need no other context; undefined when it can. */
export function whyNotServed(specialists: Specialists, s: Pinnable, app: string | undefined): string | undefined {
  if (serves(specialists, s, app)) return undefined
  const via = app === undefined ? 'no Slack app' : `app ${app}`
  if (s.apps) return `${s.id} is pinned to app${s.apps.length > 1 ? 's' : ''} ${s.apps.join(', ')}, and this message came through ${via}`
  return `app ${app} serves only specialists pinned to it (${pinnersOf(specialists, app!).join(', ')}), and ${s.id} is not pinned`
}

/** The one wording for a name that is no declared Slack app. */
export function noSuchApp(id: string, declared: string[]): string {
  return `no app "${id}": declare [slack.apps.${id}]; hydra.toml declares ${declared.length ? declared.join(', ') : 'no apps'}`
}
