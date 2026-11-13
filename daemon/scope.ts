// What a specialist's session may reach, decided once when the session is born and stored on its record.
//
// A LaunchPolicy is that decision: whose account (`access`), and for `access = "workdir"` the one folder it runs in, its
// built-in tools and its MCP servers. It is made here from hydra.toml, at birth (a fresh start, a respawn, a handoff
// successor) and kept on `SessionInfo.policy`. The folder, argv, env and generated files of a launch come from it in
// `launch()` alone; birth (doSpawnSession) decides it and re-checks the folder; delivery compares it. A resume or fork
// continues the stored policy; if hydra.toml now gives the specialist a different one, that conversation is not continued (it
// holds what the new policy may not know), and a message to a running session under the old one is refused until it is
// replaced (specialist-deliver.ts). Both are the one comparison, `policyDrifted`, which says what differs.
//
// A start that cannot read its policy refuses, in the thread, with the cause and the fix. It never falls back to the
// operator's account or to the operator's spawn directory.

import { createHash } from 'crypto'
import { isAbsolute } from 'path'
import { currentHydraConfig } from './hydra-config.js'
import { specialistOf } from '../specialists/specialists.js'
import { WORKDIR_TOOLS, type Access, type HydraConfig } from '../config/types.js'
import type { SessionInfo } from './sessions.js'
import { threadNotices } from './notice-limit.js'
import { setFlushGate } from './bridge-transport.js'
import { safeSend } from './util.js'

export type PolicyServer = { name: string; command: string; tokenEnv: string[]; tools: string[] }

export type LaunchPolicy = {
  /** The specialist's id when the session was born. */
  specialist: string
  access: Access
  /** `access = "workdir"`: the only folder the session runs in. */
  workdir?: string
  /** `access = "workdir"`: built-in tools, `--tools`. */
  tools?: string[]
  /** `access = "workdir"`: the MCP servers it may use, each with the tools it may call. */
  servers?: PolicyServer[]
  /** Changes whenever the access, workdir, a tool or a server (or its tools) does, and with nothing else. */
  id: string
}

/** A policy that confines: its workdir, tools and servers are all there (checked, never assumed). */
export type ConfinedPolicy = LaunchPolicy & { access: 'workdir'; workdir: string; tools: string[]; servers: PolicyServer[] }

/** The id of the account every non-specialist session, and every `access = "operator"` specialist, runs under. */
export const OPERATOR_SCOPE = 'operator'

/** The id a confining policy's facts give: changes whenever the folder, a tool or a server (its command, token variables or tools) does, and with nothing else. */
export function policyIdFor(workdir: string, tools: readonly string[], servers: readonly PolicyServer[]): string {
  const identity = JSON.stringify({ workdir, tools: [...tools].sort(), servers: servers.map(s => ({ name: s.name, command: s.command, tokenEnv: [...s.tokenEnv].sort(), tools: [...s.tools].sort() })).sort((a, b) => a.name.localeCompare(b.name)) })
  return `workdir:${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`
}

/** The one remedy, said the same everywhere: what to run, what happens next, and that hydra.toml is read again. `sessionName` is the record's own. */
export const remedy = (sessionName: string): string => `Run \`hydra kill ${sessionName}\`; the next message to the specialist starts a new session that re-reads hydra.toml.`

export const policyIdOf = (p: LaunchPolicy | undefined): string => p?.id ?? OPERATOR_SCOPE

/** The one mod a scoped session loads: the tracked hydra mod, never the operator's `mods.local`. */
export const HYDRA_MOD = 'hydra'
export const SCOPED_MODS = [HYDRA_MOD] as const

/** After a start is stopped by verification, the same specialist is not started again for this long: each message would otherwise launch a session and wait to verify it. `now` is a test seam. */
export const verifyBackoff = { ms: 60_000, now: (): number => Date.now() }

/** The permission rule that allows one tool of one MCP server: Claude Code's `mcp__<server>__<tool>`. The launch's settings and the start's check both say it this way. */
export const serverToolRule = (server: string, tool: string): string => `mcp__${server}__${tool}`

/** Sessions whose start is being verified right now (in memory: a restart empties it, which is what leaves an unfinished one unverified). */
const verifying = new Set<string>()
export const startVerifying = (sessionId: string): void => { verifying.add(sessionId) }
export const endVerifying = (sessionId: string): void => { verifying.delete(sessionId) }
export const isVerifying = (sessionId: string): boolean => verifying.has(sessionId)

/** A confined session whose start has not passed verification: the one that takes no message. Operator access and non-specialist sessions are never this. */
export const unverified = (info: Pick<SessionInfo, 'sessionType' | 'policy' | 'verified'>): boolean =>
  (info.sessionType === 'scoped' || info.policy?.access === 'workdir') && !info.verified

/** The text of a start that verification stopped: the session is gone, its launch prompt had reached it, and hydra.toml is not the usual cause. */
export const verifyRefusal = (specialist: string, sessionName: string, why: string): string =>
  `specialist ${specialist}: the session that just started (${sessionName}) loaded something its policy does not give it, so hydra stopped it before routing the thread to it (its launch prompt had already reached it): ${why}. Send another message to start a fresh one. If this repeats, the cause is in Claude Code's setup or its debug file, not in hydra.toml.`

/** Why a stored policy cannot be read (a confining one missing a part), or undefined. */
export function policyProblem(p: unknown): string | undefined {
  if (typeof p !== 'object' || p === null) return 'it is not an object'
  const q = p as Partial<LaunchPolicy>
  if (typeof q.specialist !== 'string' || typeof q.id !== 'string') return 'it names no specialist or no id'
  if (q.access === 'operator') return q.id === OPERATOR_SCOPE ? undefined : 'its id does not match its access (an operator policy has the operator id)'
  if (q.access !== 'workdir') return `its access is ${JSON.stringify(q.access)}`
  if (typeof q.workdir !== 'string' || !isAbsolute(q.workdir)) return 'it has no workdir (a confined session runs in its workdir and nowhere else)'
  if (!Array.isArray(q.tools) || !q.tools.every(t => typeof t === 'string')) return 'it has no tool list'
  if (!Array.isArray(q.servers) || !q.servers.every(s => s && typeof s.name === 'string' && typeof s.command === 'string' && Array.isArray(s.tokenEnv) && Array.isArray(s.tools))) return 'it has no readable server list'
  if (q.id !== policyIdFor(q.workdir, q.tools, q.servers)) return 'its id does not match its folder, tools and servers'
  return undefined
}

/** The confining policy, or undefined for operator access. Throws on a confining policy that cannot be read. */
export function confined(p: LaunchPolicy | undefined, sessionName: string): ConfinedPolicy | undefined {
  if (!p || p.access !== 'workdir') return undefined
  const why = policyProblem(p)
  if (why) throw new PolicyRefusal(`specialist ${p.specialist}: its launch policy cannot be read (${why}), so no session starts under it. ${remedy(sessionName)}`)
  return p as ConfinedPolicy
}

/** A start that must not happen, said with its cause and its fix. Posted in the thread by whoever catches it. */
export class PolicyRefusal extends Error {}

/**
 * The policy hydra.toml gives a specialist now, found by its current id or an old one (`was`): undefined when none is
 * declared. This is what a birth stores.
 */
export function bornPolicy(specialistId: string | undefined, h: HydraConfig = currentHydraConfig(), sessionName = '<session name>'): LaunchPolicy | undefined {
  const declared = specialistId === undefined ? undefined
    : (Object.hasOwn(h.specialists, specialistId) ? h.specialists[specialistId] : undefined) ?? Object.values(h.specialists).find(s => s.was.includes(specialistId))
  if (!declared) return undefined
  if (declared.access !== 'workdir') return { specialist: declared.id, access: 'operator', id: OPERATOR_SCOPE }
  const servers = (declared.mcp ?? []).map((name): PolicyServer => {
    const s = h.mcpServers?.[name]
    // Checked at load; a config that got here without it must not start the specialist with fewer servers than it lists.
    if (!s) throw new PolicyRefusal(`specialist ${declared.id} lists [mcp.${name}], which hydra.toml does not declare: declare it, or remove it from the specialist's mcp. ${remedy(sessionName)}`)
    return { name: s.name, command: s.command, tokenEnv: [...s.tokenEnv], tools: [...s.tools] }
  })
  // A workdir specialist without a tools list (a config that skipped the loader) gets the narrowest set, not every tool.
  const tools = [...(declared.tools ?? WORKDIR_TOOLS)]
  return { specialist: declared.id, access: 'workdir', workdir: declared.workdir, tools, servers, id: policyIdFor(declared.workdir, tools, servers) }
}

/**
 * The first token variable a confined policy's servers need that is not set, as a refusal's text (cause and fix), or undefined.
 * `held` is what the daemon's scrub took out of the environment (a variable may be set there and absent from `env`).
 */
export function missingTokenRefusal(p: ConfinedPolicy, envFile: string, sessionName: string, env: NodeJS.ProcessEnv = process.env, held: Readonly<Record<string, string>> = {}): string | undefined {
  for (const s of p.servers) for (const v of s.tokenEnv) {
    if (env[v] === undefined && held[v] === undefined) return `specialist ${p.specialist}: [mcp.${s.name}] needs ${v}, which is not set: add ${v}=<value> to ${envFile}, then restart the daemon (it reads that file only at start). No session starts without it. ${remedy(sessionName)}`
  }
  return undefined
}

/** What a policy says in words, for a log line or a message (the id is a hash). */
export function describePolicy(p: LaunchPolicy | undefined): string {
  if (!p || p.access !== 'workdir') return 'access = "operator"'
  return `access = "workdir" (folder ${p.workdir ?? '?'}; tools ${(p.tools ?? []).join(',') || 'none'}; mcp ${(p.servers ?? []).map(s => s.name).join(',') || 'none'})`
}

const csv = (a: readonly string[] | undefined): string => (a ?? []).join(',')
const sameSet = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => csv([...(a ?? [])].sort()) === csv([...(b ?? [])].sort())

/**
 * The one comparison: what differs between the policy a session was born under and the one hydra.toml gives its specialist now,
 * one phrase per difference (`tools: Read,Grep -> Read`, `mcp datadog tools: a -> a,b`). Empty: the same. Used by a resume (not
 * continued when it differs), by delivery (not delivered when it differs) and in both messages.
 */
export function policyDrifted(stored: LaunchPolicy | undefined, current: LaunchPolicy | undefined): string[] {
  const was = stored?.access === 'workdir'
  const now = current?.access === 'workdir'
  if (was !== now) return [`access: ${was ? 'workdir' : 'operator'} -> ${now ? 'workdir' : 'operator'}`]
  if (!was || !stored || !current) return []
  const out: string[] = []
  if (stored.workdir !== current.workdir) out.push(`folder: ${stored.workdir} -> ${current.workdir}`)
  if (!sameSet(stored.tools, current.tools)) out.push(`tools: ${csv(stored.tools)} -> ${csv(current.tools)}`)
  const before = new Map((stored.servers ?? []).map(s => [s.name, s]))
  const after = new Map((current.servers ?? []).map(s => [s.name, s]))
  for (const name of [...new Set([...before.keys(), ...after.keys()])]) {
    const x = before.get(name), y = after.get(name)
    if (!x && y) out.push(`mcp ${name}: not listed -> listed (tools ${csv(y.tools)})`)
    else if (x && !y) out.push(`mcp ${name}: listed (tools ${csv(x.tools)}) -> not listed`)
    else if (x && y) {
      if (x.command !== y.command) out.push(`mcp ${name} command: ${x.command} -> ${y.command}`)
      if (!sameSet(x.tokenEnv, y.tokenEnv)) out.push(`mcp ${name} token_env: ${csv(x.tokenEnv)} -> ${csv(y.tokenEnv)}`)
      if (!sameSet(x.tools, y.tools)) out.push(`mcp ${name} tools: ${csv(x.tools)} -> ${csv(y.tools)}`)
    }
  }
  return out
}

/** What a start works out from the records it continues or replaces and from hydra.toml. */
export type Resolved = {
  specialistId: string | undefined
  /** The policy the conversation being continued or replaced was born with (the first record that carries one). */
  stored: LaunchPolicy | undefined
  /** What hydra.toml gives the specialist now. */
  current: LaunchPolicy | undefined
  /** What differs between the stored policy and the current one (empty: the same): a conversation born under the old one is not continued. */
  drift: string[]
}

/**
 * Whom a start acts for, and the two policies that matter: the one its conversation was born with and the one hydra.toml gives
 * now. The specialist is the one a caller names (a fill, a conversation's own session); else the first record that carries a
 * policy; else the one whose thread this is (`sits`; absent for a protocol guest, which sits in a specialist's thread without
 * acting for it). Throws a PolicyRefusal for a stored policy that cannot be read, and for a confined specialist hydra.toml no
 * longer declares: those start nothing.
 */
export function resolvePolicy(from: {
  named?: string
  records?: ReadonlyArray<Pick<SessionInfo, 'policy'> | undefined>
  sits?: Pick<SessionInfo, 'threadId' | 'tmuxName'>
  /** The record's session name, for the remedy a refusal ends with. */
  sessionName?: string
}, h: HydraConfig = currentHydraConfig()): Resolved {
  const sessionName = from.sessionName ?? from.sits?.tmuxName ?? '<session name>'
  const stored = (from.records ?? []).find(r => r?.policy !== undefined)?.policy
  if (stored !== undefined) {
    const why = policyProblem(stored)
    if (why) throw new PolicyRefusal(`specialist ${(stored as Partial<LaunchPolicy>).specialist ?? '?'}: the launch policy stored with its session cannot be read (${why}), so no session starts under it. ${remedy(sessionName)}`)
  }
  const specialistId = from.named ?? stored?.specialist ?? (from.sits ? specialistOf(from.sits, h) : undefined)
  const current = bornPolicy(specialistId, h, sessionName)
  if (specialistId !== undefined && !current && stored?.access === 'workdir') {
    throw new PolicyRefusal(`specialist ${specialistId} ran with ${describePolicy(stored)} and hydra.toml no longer declares it: restore [specialists.${specialistId}] (access = "workdir"). ${remedy(sessionName)}`)
  }
  return { specialistId, stored, current, drift: specialistId !== undefined ? policyDrifted(stored, current) : [] }
}

/**
 * What differs between a running session's stored policy and the one hydra.toml gives its specialist now: empty when nothing, or
 * when no specialist fills it. No side effects (typed delivery asks this before it pastes into a pane). Throws a PolicyRefusal as
 * `bornPolicy` does.
 */
export function sessionDrift(info: Pick<SessionInfo, 'policy' | 'threadId' | 'tmuxName'>, h: HydraConfig = currentHydraConfig()): { specialist?: string; current?: LaunchPolicy; drift: string[] } {
  const specialist = info.policy?.specialist ?? specialistOf(info, h)
  if (specialist === undefined) return { drift: [] }
  const current = bornPolicy(specialist, h, info.tmuxName)
  return { specialist, current, drift: policyDrifted(info.policy, current) }
}

/**
 * Why a message must not reach this running session, or undefined: the one gate every delivery to a Claude session passes
 * (the adapter's `deliver`: a CLI deliver, a Slack or Discord message, a send_to_thread, a queued notification). A session keeps
 * the policy it was born with; if hydra.toml now gives its specialist another (access, workdir, tools or mcp), delivering would
 * hand a message to a session that is not what the file says. Nothing is delivered, killed or restarted: the thread is told
 * the remedy (at most once a minute per cause) and the log names the old and new access in words.
 */
export function deliveryRefusal(info: SessionInfo): string | undefined {
  // A confined session takes nothing until its start has been checked: the first line of the gate, whatever route the message took.
  if (unverified(info)) {
    const name = info.tmuxName
    const reason = verifying.has(info.sessionId)
      ? `specialist ${info.policy?.specialist ?? '?'}: its session ${name} is still being checked against its policy and takes no message until that passes; send it again in a moment.`
      : `specialist ${info.policy?.specialist ?? '?'}: its running session ${name} has not been checked against its policy (hydra restarted while it was being checked, or it started before hydra checked each start), so nothing is delivered to it. ${remedy(name)}`
    process.stderr.write(`daemon: delivery to ${name} refused: its start is not verified\n`)
    if (threadNotices.allow(`${info.threadId}\n${reason}`)) void safeSend(info.threadId, `⚠️ ${reason.replace(/^specialist [^:]+: /, '')}`).catch(() => {})
    return reason
  }
  let found: ReturnType<typeof sessionDrift>
  try { found = sessionDrift(info) } catch (err) { return err instanceof Error ? err.message : String(err) }
  if (!found.drift.length) return undefined
  const was = describePolicy(info.policy)
  const now = describePolicy(found.current)
  const changed = found.drift.join('; ')
  const reason = `specialist ${found.specialist}: its running session ${info.tmuxName} was born with ${was}, and hydra.toml now says ${now} (changed: ${changed}); nothing was delivered. ${remedy(info.tmuxName)}`
  process.stderr.write(`daemon: delivery to ${info.tmuxName} refused: specialist ${found.specialist} was born with ${was}; hydra.toml now says ${now} (changed: ${changed})\n`)
  if (threadNotices.allow(`${info.threadId}\n${reason}`)) void safeSend(info.threadId, `⚠️ ${reason.replace(/^specialist [^:]+: /, '')}`).catch(() => {})
  return reason
}

// What was queued for a session is held to the same rule when it is flushed (bridge-transport.ts).
setFlushGate(deliveryRefusal)
