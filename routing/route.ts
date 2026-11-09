// Which specialist hears a message, and whether its sender may reach it. Pure: config and message in, a decision out.
// Content-blind: it reads who sent a message and where, never what it says.
//
//   1. A bound conversation follows its binding (unless hydra.toml no longer declares that specialist: then it is routed anew).
//   2. Otherwise the first matching [[rules]] entry at that place.
//   3. Otherwise the specialist that `listens` there.
//   4. Otherwise, the operator's DM goes to `main`; anything else is unrouted.
// Then `allow`: the operator is always allowed, `anyone` admits strangers, `people` admits the roster, a role admits who holds it.

import type { Address, HydraConfig, Person, Place } from '../config/types.js'

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
  /** A DM, or a message that tags the bot: either may open a conversation. Ambient chatter may only where `listen = "all"`. */
  addressed: boolean
  /** The conversation's binding, if it has one. A bound conversation is addressed: everything in it is for its specialist. */
  bound?: string
}

/** One candidate considered, in order, and what became of it. What `hydra route` prints. */
export type Step = { via: Via; to: string; matched: boolean; why: string }
export type Via = 'binding' | 'rule' | 'listens' | 'operator-dm'

export type Decision =
  /** Delivered to `to`; `bind` is set when this message opens the conversation. */
  | { fate: 'deliver'; to: string; via: Via; bind: boolean; sender: Sender; trace: Step[] }
  /** Routed, but `allow` does not admit the sender. Nothing is bound or owed. */
  | { fate: 'refused'; to: string; via: Via; sender: Sender; trace: Step[]; why: string }
  /** Addressed, but no specialist hears this place. */
  | { fate: 'unrouted'; sender: Sender; trace: Step[] }
  /** Not addressed, and not in a bound conversation: not for hydra. */
  | { fate: 'ignored'; sender: Sender; trace: Step[] }

export const MAIN = 'main'

/** Who an address belongs to. A stranger holds only `anyone`. */
export function identify(cfg: HydraConfig, from: Address | undefined): Sender {
  const person = from ? Object.values(cfg.people).find(p => p.ids.includes(from)) : undefined
  return {
    ...(from && { address: from }),
    ...(person && { person }),
    roles: person ? [...person.roles, 'people', 'anyone'] : ['anyone'],
    operator: !!person && person.id === cfg.operator,
  }
}

/** Why `allow` refuses this sender at this specialist, or undefined when it admits them. `main` admits only the operator. */
export function refusal(cfg: HydraConfig, to: string, sender: Sender): string | undefined {
  if (sender.operator) return undefined
  if (to === MAIN) return 'main hears only the operator'
  const s = cfg.specialists[to]
  if (!s) return `no specialist "${to}"`
  if (s.allow.some(r => sender.roles.includes(r))) return undefined
  const who = sender.person ? sender.person.id : `a stranger${sender.address ? ` (${sender.address})` : ''}`
  return s.allow.length ? `${to} allows ${s.allow.join(', ')}; ${who} holds ${sender.roles.join(', ')}` : `${to} allows only the operator`
}

/** A binding names the specialist as it was called then; a rename lists the old id in `was`. */
export function currentId(cfg: HydraConfig, id: string): string {
  if (id === MAIN || cfg.specialists[id]) return id
  return Object.values(cfg.specialists).find(s => s.was.includes(id))?.id ?? id
}

/** Whether an unaddressed message at this place may open a conversation (`[places]` `listen = "all"`). */
export function listensToAll(cfg: HydraConfig, at: Place[]): boolean {
  return at.some(p => cfg.places[p]?.listen === 'all')
}

const isDmPlace = (p: Place) => p.endsWith(':dm')

export function route(cfg: HydraConfig, msg: Inbound): Decision {
  const sender = identify(cfg, msg.from)
  const trace: Step[] = []
  const decide = (to: string, via: Via, bind: boolean): Decision => {
    const why = refusal(cfg, to, sender)
    return why ? { fate: 'refused', to, via, sender, trace, why } : { fate: 'deliver', to, via, bind, sender, trace }
  }

  if (msg.bound) {
    const to = currentId(cfg, msg.bound)
    const declared = to === MAIN || !!cfg.specialists[to]
    trace.push({ via: 'binding', to, matched: declared, why: !declared ? `this conversation was bound to ${msg.bound}, which hydra.toml no longer declares; routed anew` : to === msg.bound ? 'this conversation is bound to it' : `this conversation is bound to ${msg.bound}, now called ${to}` })
    if (declared) return decide(to, 'binding', false)
  }

  if (!msg.addressed && !msg.bound && !listensToAll(cfg, msg.at)) {
    trace.push({ via: 'listens', to: '', matched: false, why: 'not a DM or a mention, and no place here has listen = "all"' })
    return { fate: 'ignored', sender, trace }
  }

  let winner: { to: string; via: Via } | undefined
  for (const [i, r] of cfg.rules.entries()) {
    const here = msg.at.includes(r.at)
    const fromOk = r.from === undefined || r.from === sender.person?.id || sender.roles.includes(r.from)
    const matched = !winner && here && fromOk
    const why = !here ? `rules[${i}] is at ${r.at}` : !fromOk ? `rules[${i}] is from ${r.from}` : winner ? `rules[${i}] matches, but an earlier rule won` : `rules[${i}]: first rule that matches`
    trace.push({ via: 'rule', to: r.to, matched, why })
    if (matched) winner = { to: r.to, via: 'rule' }
  }

  // Most specific name first: a specialist listening on the channel's id outranks one listening on its name.
  for (const [p, s] of msg.at.flatMap(p => Object.values(cfg.specialists).filter(s => s.listens.includes(p)).map(s => [p, s] as const))) {
    const matched = !winner
    trace.push({ via: 'listens', to: s.id, matched, why: matched ? `listens on ${p}` : `listens on ${p}, but ${winner!.via === 'rule' ? 'a rule' : 'a more specific place'} won` })
    if (matched) winner = { to: s.id, via: 'listens' }
  }

  if (!winner && sender.operator && msg.at.some(isDmPlace)) {
    trace.push({ via: 'operator-dm', to: MAIN, matched: true, why: 'the operator\'s DM, and no specialist listens here' })
    winner = { to: MAIN, via: 'operator-dm' }
  }

  if (!winner) return { fate: 'unrouted', sender, trace }
  return decide(winner.to, winner.via, true)
}

/** `hydra route`'s report: every candidate, the winner, and the allow check. */
export function explain(d: Decision, guardCommand?: string): string {
  const who = d.sender.person ? `${d.sender.person.id}${d.sender.operator ? ' (operator)' : ''}, roles ${d.sender.roles.join(', ')}` : `a stranger, roles ${d.sender.roles.join(', ')}`
  const lines = [`from: ${who}`]
  for (const s of d.trace) lines.push(`  ${s.matched ? '→' : ' '} ${s.via}${s.to ? ` ${s.to}` : ''}: ${s.why}`)
  if (d.fate === 'deliver') {
    lines.push(`delivers to ${d.to} (by ${d.via})${d.bind ? ', and binds the conversation to it' : ''}`)
    if (guardCommand && !d.sender.operator) lines.push(`then the guard judges it: ${guardCommand}`)
  } else if (d.fate === 'refused') lines.push(`refused (🚫): ${d.why}`)
  else if (d.fate === 'unrouted') lines.push('unrouted (🚫): no rule or specialist hears this place')
  else lines.push('ignored: not addressed to hydra')
  return lines.join('\n')
}
