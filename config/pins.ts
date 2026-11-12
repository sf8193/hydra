// Which specialist an app can deliver to. One predicate for the loader (which refuses what can never be reached) and for routing
// (which skips it): a specialist pinned to apps takes only messages that come through them, and an app that any specialist is
// pinned to delivers only to specialists pinned to it. Pure, and over the specialists alone so it needs no loaded config.

import { DEFAULT_SLACK_APP, type Specialist } from './types.js'

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

/**
 * Why `app` cannot deliver to `s`, in words that need no other context; undefined when it can. `what` says what is going
 * through the app, so each caller reads true: a message ("this message came through"), a conversation ("this conversation is
 * through"), a post ("it would post through").
 */
export function whyNotServed(specialists: Specialists, s: Pinnable, app: string | undefined, what = 'this message came through'): string | undefined {
  if (serves(specialists, s, app)) return undefined
  const via = app === undefined ? 'no Slack app' : `app ${app}`
  if (s.apps) return `${s.id} is pinned to app${s.apps.length > 1 ? 's' : ''} ${s.apps.join(', ')}, and ${what} ${via}`
  return `app ${app} serves only specialists pinned to it (${pinnersOf(specialists, app!).join(', ')}), and ${s.id} is not pinned`
}

/** The one wording for a name that is no declared Slack app. */
export function noSuchApp(id: string, declared: string[]): string {
  return `no app "${id}": declare [slack.apps.${id}]; hydra.toml declares ${declared.length ? declared.join(', ') : 'no apps'}`
}

/**
 * The app a specialist posts as when no message came in (its `home`, a new thread): `speaks_as`, else the first app it is pinned
 * to, else `default`, else the one app there is. Undefined when none of those names one: `speaks_as` is then required.
 */
export function speaksAsOf(s: Pick<Specialist, 'apps' | 'speaksAs'>, declared: string[]): string | undefined {
  return s.speaksAs ?? s.apps?.[0] ?? (declared.includes(DEFAULT_SLACK_APP) ? DEFAULT_SLACK_APP : declared.length === 1 ? declared[0] : undefined)
}
