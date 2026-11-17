// Which specialist hears a message, and whether its sender may reach it. Pure: config and message in, a decision out.
// It reads who sent a message, where, and which apps it tags, never the rest of what it says.
//
//   0. When several Slack apps are in the channel, one app owns the message (`owningApp`); the others ignore it, so exactly one answers.
//   1. A bound conversation follows its binding, unless hydra.toml no longer declares that specialist, or this app cannot be served by it
//      (it is pinned elsewhere, or this app serves only specialists pinned to it): then the message is routed anew, and counts as unbound for "is it addressed" (a gone specialist's thread stays addressed).
//   2. Otherwise the first matching [[rules]] entry: its place, app and sender all match (an absent `place` or `app` matches every one). An old `listens` was read as rules at load, after the explicit ones.
//   3. Otherwise, the operator's DM goes to `main`; anything else is unrouted.
// A specialist answers where a rule sends a place to it: nothing else says where.
// Every candidate above must be served by the app the message came through (`notServedBy`, config/pins.ts): a specialist pinned to apps
// takes only messages through them, and an app that any specialist is pinned to delivers only to those. `main` is exempt: it hears only the operator.
// Then `reachable_by`: the operator is always allowed, `anyone` admits strangers, `people` admits the roster, a role admits who holds it.

import { whyNotServed } from '../config/pins.js'
import { DEFAULT_SLACK_APP, isDmPlace, type Address, type HydraConfig, type Person, type Place, type Rule, type Specialist } from '../config/types.js'
import { isSessionThread } from '../shared/specialist-name.js'
import { spelledBare } from '../shared/target-kind.js'
import { spelledApp, spelledPerson, spelledRole, whoSpelled } from '../shared/value-kind.js'
export { isSessionThread }

/** Who sent a message, as hydra knows them. `roles` includes the built-in ones they hold. */
export type Sender = {
  address?: Address
  person?: Person
  roles: string[]
  operator: boolean
}

export type Inbound = {
  from?: Address
  /** Every name this place goes by, most specific first: `slack:C0ABC`, then `slack:#help`. */
  at: Place[]
  /** A DM, or a message that tags the bot: either may open a conversation. Ambient chatter may only where `messages = "all"`. */
  addressed: boolean
  /** The conversation's binding, if it has one. A bound conversation is addressed while its binding holds: everything in it is for its specialist. A binding skipped because this app cannot be served by its specialist does not count. */
  bound?: string
  /**
   * The app this decision is for: the one whose connection delivered the message. Absent on a Slack place: the app named `default`.
   * Absent elsewhere (Discord, GitHub, the CLI): no app, so no app rule matches and no pinned specialist takes it.
   */
  app?: string
  /** Every app in the channel that heard it; `app` is always counted. More than one means ownership decides who answers. */
  heardBy?: string[]
  /** The apps the text tags, first tag first. */
  mentioned?: string[]
  /** The id of the app that opened the conversation, if it is bound. An untagged message stays with it. */
  boundApp?: string
}

/** One candidate considered, in order, and what became of it. What `hydra route` prints. */
export type Step = { via: Via; to: string; matched: boolean; why: string }
/** `owner` is the one step whose `to` is an app id, not a specialist: the app that owns the message. `trigger` is the step where nothing makes the message count: not addressed, and no place here lets everything in. */
export type Via = 'owner' | 'binding' | 'trigger' | 'rule' | 'operator-dm'

/** On every decision: the app that heard the message, and (when it was not alone in the channel) the app that owns it. */
type Heard = { app?: string; owner?: string }

export type Decision = Heard & (
  /** Delivered to `to`; `bind` is set when this message opens the conversation. */
  | { fate: 'deliver'; to: string; via: Via; bind: boolean; sender: Sender; trace: Step[] }
  /** Routed, but `reachable_by` does not admit the sender. Nothing is bound or owed. */
  | { fate: 'refused'; to: string; via: Via; sender: Sender; trace: Step[]; why: string }
  /** Addressed, but no specialist hears this place. */
  | { fate: 'unrouted'; sender: Sender; trace: Step[] }
  /** Not addressed, and not in a bound conversation, or another app owns it: not for this app. */
  | { fate: 'ignored'; sender: Sender; trace: Step[] }
)

export const MAIN = 'main'

/** Who an address belongs to. A stranger holds only `anyone`. */
export function identify(cfg: HydraConfig, from: Address | undefined): Sender {
  const person = from ? Object.values(cfg.people).find(p => p.addresses.includes(from)) : undefined
  return {
    ...(from && { address: from }),
    ...(person && { person }),
    roles: person ? [...person.roles, 'people', 'anyone'] : ['anyone'],
    operator: !!person && person.id === cfg.operator,
  }
}

/**
 * Why this sender may not reach this specialist, or undefined when they may. Given `opts`, the app the message came through must
 * be able to deliver to it too (pins), whoever the sender is; without, only `reachable_by` is judged. `reachable_by` admits the operator always
 * and `main` only the operator.
 */
export function refusal(cfg: HydraConfig, to: string, sender: Sender, opts?: { app?: string }): string | undefined {
  const apart = opts ? notServedBy(cfg, to, opts.app) : undefined
  if (apart) return apart
  if (sender.operator) return undefined
  if (to === MAIN) return 'main hears only the operator'
  // A session bound this thread to itself by hand: whoever posts in it reaches that session, as other people's words.
  if (isSessionThread(to)) return undefined
  const s = cfg.specialists[to]
  if (!s) return `no specialist "${to}"`
  if (s.reachableBy.some(r => sender.roles.includes(r))) return undefined
  const who = sender.person ? spelledPerson(sender.person.id) : `a stranger${sender.address ? ` (${sender.address})` : ''}`
  return s.reachableBy.length ? `${to} is reachable by ${s.reachableBy.map(spelledRole).join(', ')}; ${who} holds ${sender.roles.map(spelledRole).join(', ')}` : `${to} has reachable_by = [], so only the operator reaches it`
}

/** Whether a binding still has somewhere to go: main, a specialist hydra.toml declares (after `renamed_from` renames), or a session's own thread. */
export function isLive(cfg: HydraConfig, id: string): boolean {
  const to = currentId(cfg, id)
  return to === MAIN || !!cfg.specialists[to] || isSessionThread(to)
}

/** A binding names the specialist as it was called then; a rename lists the old id in `renamed_from`. */
export function currentId(cfg: HydraConfig, id: string): string {
  if (id === MAIN || cfg.specialists[id]) return id
  return Object.values(cfg.specialists).find(s => s.renamedFrom.includes(id))?.id ?? id
}

/** Whether an unaddressed message at this place may open a conversation: a place with `messages = "all"`. */
export function messagesAll(cfg: HydraConfig, at: Place[]): boolean {
  return at.some(p => cfg.places[p]?.messages === 'all')
}

const isSlackPlace = (p: Place) => p.startsWith('slack:')

/** The app that heard a message: as given, else `default` on a Slack place, else none. */
export function appOf(msg: Pick<Inbound, 'app' | 'at'>): string | undefined {
  return msg.app ?? (msg.at.some(isSlackPlace) ? DEFAULT_SLACK_APP : undefined)
}

/** Why a message that came through `app` cannot be delivered to `to`, or undefined when it can. `main` and a session's own thread are exempt. */
export function notServedBy(cfg: HydraConfig, to: string, app: string | undefined, what?: string): string | undefined {
  const s = cfg.specialists[currentId(cfg, to)]
  return s ? whyNotServed(cfg.specialists, s, app, what) : undefined
}

/** Every app that heard a message: `app` (see `appOf`) and `heardBy`, once each. The one set `route` and `owningApp` both use. */
export function heardApps(msg: Pick<Inbound, 'app' | 'heardBy' | 'at'>): string[] {
  const app = appOf(msg)
  return [...new Set([...(msg.heardBy ?? []), ...(app ? [app] : [])])]
}

/**
 * What a Slack app can deliver to: the one answer every consumer filters (which channels it reads, whether it hears DMs, which
 * scopes it needs, who an alert about it concerns, whether it delivers to anyone at a place). An app *serves* a specialist when
 * it is pinned to it, or when it is unpinned and no specialist is pinned to that app (`notServedBy`).
 *
 * `specialists`: the declared specialists the app serves. `rules`: the `[[rules]]` that apply to messages through the app (`app`
 * absent or this one) and whose target the app can deliver to: `main`, or a declared specialist it serves. A rule to a specialist
 * that is not declared is ignored everywhere. A rule with no `place` is in `rules` and reaches every place; consumers that need
 * named places read `place`. With no `app`: everything declared (nothing is filtered).
 */
export function reachableBy(cfg: HydraConfig, app?: string): { specialists: Specialist[]; rules: Rule[] } {
  if (app === undefined) return { specialists: Object.values(cfg.specialists), rules: cfg.rules.filter(r => r.target === MAIN || !!cfg.specialists[currentId(cfg, r.target)]) }
  const serves = (id: string) => id === MAIN || (!!cfg.specialists[currentId(cfg, id)] && !notServedBy(cfg, id, app))
  return {
    specialists: Object.values(cfg.specialists).filter(s => !notServedBy(cfg, s.id, app)),
    rules: cfg.rules.filter(r => (r.app === undefined || r.app === app) && serves(r.target)),
  }
}

/** The specialists (and `main`, as a rule's target) that hear Slack through `app`: a Slack rule for the app sends to them. Whom an alert about the app concerns. */
export function slackSpecialistsOf(cfg: HydraConfig, app?: string): string[] {
  const r = reachableBy(cfg, app)
  // a rule with only an app is a Slack rule
  return [...new Set(r.rules.filter(x => x.place === undefined || isSlackPlace(x.place)).map(x => x.target))]
}

/** Whether a message at this place, through `app`, would be delivered to anyone: a rule's target that `app` serves, or `main` in a DM. */
export function reachesAnyone(cfg: HydraConfig, app: string, at: Place[]): boolean {
  if (at.some(isDmPlace)) return true
  const r = reachableBy(cfg, app)
  return r.rules.some(x => x.place === undefined || at.includes(x.place))
}

/**
 * Which app owns a message, so exactly one answers. `contested` is whether more than one app heard it. The first of these that applies:
 *   1. the first app the text tags that heard it: a tag always wins (it opens that app's own conversation);
 *   2. the app that opened the conversation (`boundApp`), if it heard it;
 *   3. the place's `default_app`, if it heard it: honored as written, even if it reaches no one;
 *   4. the app named `default`, if it heard it and would deliver to someone here;
 *   5. the first app, in hydra.toml order, that heard it and would deliver to someone here.
 * If no app that heard it would deliver to anyone here, 4 and 5 pick among all that heard it. Pure: given any app, it names one.
 */
export function owningApp(cfg: HydraConfig, msg: Pick<Inbound, 'app' | 'heardBy' | 'mentioned' | 'boundApp' | 'at'>): { app: string; why: string; contested: boolean } | undefined {
  const heard = heardApps(msg)
  if (!heard.length) return undefined
  const contested = heard.length > 1
  const pick = (app: string, why: string) => ({ app, why, contested })
  if (!contested) return pick(heard[0], `${spelledApp(heard[0])} is the only app that heard it`)
  const here = new Set(heard)
  const tagged = (msg.mentioned ?? []).filter(a => here.has(a))
  if (tagged.length) return pick(tagged[0], `${spelledApp(tagged[0])} is tagged${tagged.length > 1 ? ' first' : ''}`)
  if (msg.boundApp && here.has(msg.boundApp)) return pick(msg.boundApp, `${spelledApp(msg.boundApp)} opened this conversation, and no app is tagged`)
  for (const p of msg.at) {
    const d = cfg.places[p]?.defaultApp
    if (d && here.has(d)) return pick(d, `${spelledApp(d)} is this place's \`default_app\``)
  }
  const serving = heard.filter(a => reachesAnyone(cfg, a, msg.at))
  const pool = serving.length ? serving : heard
  const passed = serving.length && serving.length < heard.length ? ' (apps that deliver to no one here are passed over)' : ''
  if (pool.includes(DEFAULT_SLACK_APP)) return pick(DEFAULT_SLACK_APP, `no tag, and no \`default_app\` for this place; the app named \`${spelledApp(DEFAULT_SLACK_APP)}\` is in the channel${passed}`)
  const first = Object.keys(cfg.slackApps).find(a => pool.includes(a)) ?? pool[0]
  const why = here.has(DEFAULT_SLACK_APP) ? 'delivers to no one here' : 'is not in the channel'
  return pick(first, `no tag, no \`default_app\` for this place, and the app named \`${spelledApp(DEFAULT_SLACK_APP)}\` ${why}; ${spelledApp(first)} is the first declared app ${serving.length ? 'that delivers to someone here' : 'that heard it'}`)
}

export function route(cfg: HydraConfig, msg: Inbound): Decision {
  const sender = identify(cfg, msg.from)
  const trace: Step[] = []
  const app = appOf(msg)
  const heard: Heard = { ...(app && { app }) }
  const decide = (to: string, via: Via, bind: boolean): Decision => {
    const why = refusal(cfg, to, sender, { app })
    return why ? { ...heard, fate: 'refused', to, via, sender, trace, why } : { ...heard, fate: 'deliver', to, via, bind, sender, trace }
  }

  // Several apps in one channel: one owns the message, the rest stand down, whatever else would match.
  const own = owningApp(cfg, msg)
  if (own?.contested) {
    heard.owner = own.app
    const mine = own.app === app
    trace.push({ via: 'owner', to: own.app, matched: mine, why: mine ? `${spelledApp(app!)} owns it: ${own.why}` : `${app ? spelledApp(app) : 'no Slack app'} heard it, but ${spelledApp(own.app)} owns it (${own.why}), so only ${spelledApp(own.app)} answers` })
    if (!mine) return { ...heard, fate: 'ignored', sender, trace }
  }

  // A binding that is skipped is routed anew. If it is skipped because this app cannot be served by its specialist, the message
  // counts as unbound: chatter in that thread is not addressed. If its specialist is gone from hydra.toml, the conversation goes on,
  // so it stays addressed and its new owner takes it.
  let addressed = msg.addressed
  if (msg.bound) {
    const to = currentId(cfg, msg.bound)
    const gone = !isLive(cfg, to)
    const apart = gone ? undefined : notServedBy(cfg, to, app)
    const live = !gone && !apart
    trace.push({ via: 'binding', to, matched: live, why: gone ? `this conversation was bound to ${msg.bound}, which hydra.toml no longer declares; routed anew` : apart ? `this conversation is bound to ${to}, but ${apart}; routed anew` : to === msg.bound ? 'this conversation is bound to it' : `this conversation is bound to ${msg.bound}, now called ${to}` })
    if (live) return decide(to, 'binding', false)
    if (gone) addressed = true
  }

  if (!addressed && !messagesAll(cfg, msg.at)) {
    trace.push({ via: 'trigger', to: '', matched: false, why: 'not a DM or a mention, and no place here has messages = "all"' })
    return { ...heard, fate: 'ignored', sender, trace }
  }

  let winner: { to: string; via: Via } | undefined
  for (const [i, r] of cfg.rules.entries()) {
    const atOk = r.place === undefined || msg.at.includes(r.place)
    const appOk = r.app === undefined || r.app === app
    const fromOk = r.person === undefined || r.person === sender.person?.id || sender.roles.includes(r.person)
    const apart = atOk && appOk && fromOk && !winner ? notServedBy(cfg, r.target, app) : undefined
    const matched = !winner && atOk && appOk && fromOk && !apart
    const why = !atOk ? `rules[${i}] is for place ${r.place}` : !appOk ? `rules[${i}] is for ${spelledApp(r.app!)}, and this came through ${app ? spelledApp(app) : 'no Slack app'}` : !fromOk ? `rules[${i}] is for ${whoSpelled(cfg.people, r.person!)}` : winner ? `rules[${i}] matches, but an earlier rule won` : apart ? `rules[${i}] matches, but ${apart}; skipped` : `rules[${i}]: first rule that matches`
    trace.push({ via: 'rule', to: r.target, matched, why })
    if (matched) winner = { to: r.target, via: 'rule' }
  }

  if (!winner && sender.operator && msg.at.some(isDmPlace)) {
    trace.push({ via: 'operator-dm', to: MAIN, matched: true, why: 'the operator\'s DM, and no rule sends it elsewhere' })
    winner = { to: MAIN, via: 'operator-dm' }
  }

  if (!winner) return { ...heard, fate: 'unrouted', sender, trace }
  return decide(winner.to, winner.via, true)
}

/**
 * Where each declared specialist answers, one line each (`hydra config check`, `hydra route`): read off the `[[rules]]` that name it as
 * their target, in file order. A rule that narrows to a person or an app says so; a specialist no rule names is heard only in a conversation bound to it.
 */
export function answersLines(cfg: HydraConfig): string[] {
  return Object.keys(cfg.specialists).map(id => {
    const heard = cfg.rules.filter(r => r.target === id).map(r => `${r.place ?? 'every place'}${r.app ? ` via ${spelledApp(r.app)}` : ''}${r.person ? ` for ${whoSpelled(cfg.people, r.person)}` : ''}`)
    return `${id} answers: ${heard.length ? heard.join(', ') : 'no place (only a conversation bound to it)'}`
  })
}

/** `hydra route`'s report: every candidate, the winner, and the allow check. */
export function explain(d: Decision, guardCommand?: string): string {
  const roles = d.sender.roles.map(spelledRole).join(', ')
  const who = d.sender.person ? `${spelledPerson(d.sender.person.id)}${d.sender.operator ? ' (operator)' : ''}, roles ${roles}` : `a stranger, roles ${roles}`
  const lines = [`sender: ${who}`]
  // Only when it says something: not for the one app a single-app hydra has.
  if (d.app && (d.owner || d.app !== DEFAULT_SLACK_APP)) lines.push(`through: ${spelledApp(d.app)}${d.owner ? (d.owner === d.app ? ' (owns this message)' : ` (does not own it: ${spelledApp(d.owner)} does)`) : ''}`)
  for (const s of d.trace) lines.push(`  ${s.matched ? '→' : ' '} ${s.via}${s.to ? ` ${s.via === 'owner' ? spelledApp(s.to) : spelledBare(s.to)}` : ''}: ${s.why}`)
  if (d.fate === 'deliver') {
    lines.push(`delivers to ${spelledBare(d.to)} (by ${d.via})${d.bind ? ', and binds the conversation to it' : ''}`)
    if (guardCommand && !d.sender.operator) lines.push(`then the guard judges it: ${guardCommand}`)
  } else if (d.fate === 'refused') lines.push(`refused (🚫): ${d.why}`)
  else if (d.fate === 'unrouted') lines.push('unrouted: no rule sends this place to anyone (a mention gets a 🚫; a DM gets no reply)')
  else lines.push(d.owner && d.owner !== d.app ? `ignored: ${spelledApp(d.owner)} owns this message, so ${d.app ? spelledApp(d.app) : 'no Slack app'} does not answer` : 'ignored: not addressed to hydra')
  return lines.join('\n')
}
