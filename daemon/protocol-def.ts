import { readdirSync } from 'fs'
import { join } from 'path'
import { parseDuration } from './util.js'
import type { TransitionTable } from './state-machine.js'

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export type PhaseSpec = {
  actor?: string
  half?: 'top' | 'bottom'
  terminal?: boolean
  on?: Record<string, string>
}

export type ProtocolDef = {
  protocol: string
  emoji: string
  displayName: string
  roles: Record<string, { label: string }>
  initialPhase: string
  phases: Record<string, PhaseSpec>
  sentinels: Record<string, string>
  windows: Record<string, number>
  disconnectGrace: Record<string, number>
  completionEvent: { protocol: string; fields: string[] }
  source: string
}

// ---------------------------------------------------------------------------
// Lens definition
// ---------------------------------------------------------------------------

export type LensDef = {
  lens: string
  aliases: string[]
  instructions: string
  source: string
}

// ---------------------------------------------------------------------------
// Parse — protocol
// ---------------------------------------------------------------------------

const SKELETON_FENCE = /```yaml skeleton\n([\s\S]*?)\n```/

export async function loadProtocolDef(path: string): Promise<ProtocolDef> {
  const source = await Bun.file(path).text()
  return parseProtocolDef(source, path)
}

export function parseProtocolDef(source: string, origin = '<protocol>'): ProtocolDef {
  const fence = source.match(SKELETON_FENCE)
  if (!fence) throw new Error(`${origin}: no \`\`\`yaml skeleton block found`)

  let raw: any
  try {
    raw = Bun.YAML.parse(fence[1])
  } catch (err) {
    throw new Error(`${origin}: skeleton is not valid YAML — ${err instanceof Error ? err.message : err}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error(`${origin}: skeleton must be a mapping`)

  const fail = (msg: string): never => { throw new Error(`${origin}: ${msg}`) }

  const str = (v: unknown, what: string): string =>
    typeof v === 'string' && v.length > 0 ? v : fail(`${what} must be a non-empty string`)

  const protocol = str(raw.protocol, 'protocol')
  const emoji = str(raw.emoji, 'emoji')
  const displayName = str(raw.display_name, 'display_name')
  const initialPhase = str(raw.initial_phase, 'initial_phase')

  // Roles
  if (!raw.roles || typeof raw.roles !== 'object') fail('roles must be a mapping')
  const roles: ProtocolDef['roles'] = {}
  for (const [id, spec] of Object.entries<any>(raw.roles)) {
    roles[id] = { label: str(spec?.label, `roles.${id}.label`) }
  }
  if (Object.keys(roles).length === 0) fail('at least one role is required')

  // Phases
  if (!raw.phases || typeof raw.phases !== 'object') fail('phases must be a mapping')
  const phases: Record<string, PhaseSpec> = {}
  for (const [name, spec] of Object.entries<any>(raw.phases)) {
    const terminal = spec?.terminal === true
    const on = spec?.on
    if (terminal && on) fail(`phase "${name}" is terminal but declares transitions`)
    if (!terminal && (!on || typeof on !== 'object' || Object.keys(on).length === 0))
      fail(`phase "${name}" is non-terminal but declares no transitions`)
    if (spec?.actor !== undefined && !roles[spec.actor]) fail(`phase "${name}" actor "${spec.actor}" is not a declared role`)
    if (spec?.half !== undefined && spec.half !== 'top' && spec.half !== 'bottom')
      fail(`phase "${name}" half must be "top" or "bottom"`)
    phases[name] = { actor: spec?.actor, half: spec?.half, terminal, on: on ?? undefined }
  }

  // Referential integrity
  if (!phases[initialPhase]) fail(`initial_phase "${initialPhase}" is not a declared phase`)
  for (const [name, spec] of Object.entries(phases)) {
    for (const [event, target] of Object.entries(spec.on ?? {})) {
      if (!phases[target]) fail(`phase "${name}" transition ${event} → "${target}" targets an unknown phase`)
    }
  }

  // Sentinels
  const sentinels: Record<string, string> = {}
  for (const [phase, tag] of Object.entries<any>(raw.sentinels ?? {})) {
    if (!phases[phase]) fail(`sentinel on unknown phase "${phase}"`)
    if (!phases[phase].actor) fail(`sentinel on phase "${phase}" which has no actor`)
    sentinels[phase] = str(tag, `sentinels.${phase}`)
  }

  // Windows
  const windows: Record<string, number> = {}
  for (const [phase, dur] of Object.entries<any>(raw.windows ?? {})) {
    if (!phases[phase]) fail(`window on unknown phase "${phase}"`)
    const ms = parseDuration(String(dur))
    if (ms == null) fail(`window on "${phase}" has invalid duration "${dur}"`)
    windows[phase] = ms
  }

  // Disconnect grace
  const disconnectGrace: Record<string, number> = {}
  for (const [role, dur] of Object.entries<any>(raw.disconnect_grace ?? {})) {
    if (!roles[role]) fail(`disconnect_grace for unknown role "${role}"`)
    const ms = parseDuration(String(dur))
    if (ms == null) fail(`disconnect_grace for "${role}" has invalid duration "${dur}"`)
    disconnectGrace[role] = ms
  }

  // Completion event
  const ce = raw.completion_event
  if (!ce || typeof ce !== 'object') fail('completion_event must be a mapping')
  if (!Array.isArray(ce.fields) || ce.fields.length === 0) fail('completion_event.fields must be a non-empty list')

  return {
    protocol, emoji, displayName, roles, initialPhase, phases,
    sentinels, windows, disconnectGrace,
    completionEvent: { protocol: str(ce.protocol, 'completion_event.protocol'), fields: ce.fields.map(String) },
    source,
  }
}

// ---------------------------------------------------------------------------
// Parse — lens
// ---------------------------------------------------------------------------

export async function loadLensDef(path: string): Promise<LensDef> {
  const source = await Bun.file(path).text()
  return parseLensDef(source, path)
}

export function parseLensDef(source: string, origin = '<lens>'): LensDef {
  const fence = source.match(SKELETON_FENCE)
  if (!fence) throw new Error(`${origin}: no \`\`\`yaml skeleton block found`)

  let raw: any
  try {
    raw = Bun.YAML.parse(fence[1])
  } catch (err) {
    throw new Error(`${origin}: skeleton is not valid YAML — ${err instanceof Error ? err.message : err}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error(`${origin}: skeleton must be a mapping`)

  const fail = (msg: string): never => { throw new Error(`${origin}: ${msg}`) }

  const lens = typeof raw.lens === 'string' && raw.lens.length > 0
    ? raw.lens
    : fail('lens must be a non-empty string')

  const aliases: string[] = Array.isArray(raw.aliases)
    ? raw.aliases.map(String)
    : []

  // Extract instructions from the ## Instructions section
  const instructionsMatch = source.match(/## Instructions\n\n([\s\S]*?)(?:\n## |\n```yaml skeleton|$)/)
  if (!instructionsMatch) fail('missing ## Instructions section')
  const instructions = instructionsMatch[1].trim()
  if (!instructions) fail('## Instructions section is empty')

  return { lens, aliases, instructions, source }
}

// ---------------------------------------------------------------------------
// Load protocol + discover lenses
// ---------------------------------------------------------------------------

export async function loadProtocolWithLenses(
  protocolPath: string,
  lensesDir: string,
): Promise<{ protocol: ProtocolDef; lenses: Map<string, LensDef> }> {
  const protocol = await loadProtocolDef(protocolPath)

  const lenses = new Map<string, LensDef>()
  let files: string[]
  try {
    files = readdirSync(lensesDir).filter(f => f.endsWith('.md'))
  } catch {
    return { protocol, lenses }
  }

  for (const file of files) {
    const def = await loadLensDef(join(lensesDir, file))
    lenses.set(def.lens, def)
    for (const alias of def.aliases) {
      lenses.set(alias, def)
    }
  }

  return { protocol, lenses }
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

export function toTransitionTable(def: ProtocolDef): TransitionTable<string, string> {
  const table: Record<string, Record<string, string>> = {}
  for (const [name, spec] of Object.entries(def.phases)) {
    table[name] = { ...(spec.on ?? {}) }
  }
  return table as TransitionTable<string, string>
}

export function expectedTag(def: ProtocolDef, phase: string, role: string): string | null {
  const tag = def.sentinels[phase]
  if (!tag) return null
  return def.phases[phase]?.actor === role ? tag : null
}

export function windowMs(def: ProtocolDef, phase: string): number | undefined {
  return def.windows[phase]
}

export function graceMs(def: ProtocolDef, role: string): number | undefined {
  return def.disconnectGrace[role]
}

export function isTerminal(def: ProtocolDef, phase: string): boolean {
  return def.phases[phase]?.terminal === true
}
