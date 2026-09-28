// ---------------------------------------------------------------------------
// Modifier registry — composable `+name` modifiers for protocol runs
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'

export type SeedModifier = {
  type: 'seed'
  name: string
  aliases: string[]
  target: string
  instructions: string
}

// A template modifier applies a spawn template's settings (prompt, disallowed
// tools, main-tool access) to a spawn or respawn — so `spawn +f: topic` composes
// the factory template the same way `factory: topic` does.
export type TemplateModifier = {
  type: 'template'
  name: string
  aliases: string[]
  templateName: string   // key in the templates registry (templates.ts)
}

// A flag modifier carries no text. It names a run param the protocol command
// sets to `true`, and is stripped from the modifier list before the run starts —
// so nothing downstream (seed composition, the summary's `+mod` note) ever sees
// it. It lives in this registry for one reason: to be a name the router's
// `+name` regex recognises. Distinct from a seed modifier with empty
// instructions, which would leak an empty `**+name:**` block into a seed if it
// were ever left in the list.
export type FlagModifier = {
  type: 'flag'
  name: string
  aliases: string[]
  param: string   // key set to `true` in the protocol run's params
}

export type Modifier = SeedModifier | TemplateModifier | FlagModifier

const registry = new Map<string, Modifier>()

// Run params a protocol run reads for its own shape. A flag whose `param` is one
// of these would silently win over the caller's value — partitionFlagModifiers
// spreads flags last — so a rounds-shadowing flag would quietly rewrite the
// round count. Refuse at registration rather than debug it at runtime; same
// discipline the protocol() factory applies to a half-declared fallback.
const RESERVED_RUN_PARAMS = new Set(['rounds', 'topic', 'model', 'modifiers', 'strike'])

/** Reserved run params, exported so a test can pin the list this guards. */
export function reservedRunParams(): string[] { return [...RESERVED_RUN_PARAMS] }

/**
 * Everything a modifier must satisfy to be registrable. Separated from register()
 * so it can be exercised without mutating the live registry — a test that had to
 * register its fixtures would leak names into listModifierKeys(), which is what
 * the router builds its `+name` matcher from.
 */
export function validateModifier(mod: Modifier): void {
  if (!mod.name) throw new Error('modifier must have a name')
  if (mod.type === 'flag') {
    if (!mod.param) throw new Error(`modifier "${mod.name}": a flag must name the run param it sets`)
    if (RESERVED_RUN_PARAMS.has(mod.param)) {
      throw new Error(`modifier "${mod.name}": param "${mod.param}" is a reserved run param — a flag setting it would silently override the caller's value`)
    }
  }
}

function register(mod: Modifier): void {
  validateModifier(mod)
  for (const key of [mod.name, ...mod.aliases]) {
    registry.set(key, mod)
  }
}

// Local lenses: <STATE_DIR>/lenses/<name>.md — uncommitted, read on every lookup
// so a new file works without a restart. The body is the lens instructions.
// Optional frontmatter: `aliases: a, b` and `default: true` (auto-included in
// every review that runs automatic lenses). Built-in names win on a clash.
export const LOCAL_LENSES_DIR = join(STATE_DIR, 'lenses')

export type LocalLens = SeedModifier & { isDefault: boolean }

// Lens names become `+name` tokens the router matches and the review gate builds a
// regex from (protocol-runner validateRequestedReviewLenses) — keep them to this shape.
const LENS_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const warned = new Set<string>()
const warnOnce = (msg: string) => { if (!warned.has(msg)) { warned.add(msg); process.stderr.write(`daemon: lens: ${msg}\n`) } }

export function localLenses(): LocalLens[] {
  let files: string[]
  try { files = readdirSync(LOCAL_LENSES_DIR).filter(f => f.endsWith('.md')) } catch { return [] }
  const taken = new Set(registry.keys())
  return files.flatMap(file => {
    const name = file.slice(0, -3)
    if (!LENS_NAME_RE.test(name)) { warnOnce(`skipping ${file}: name must match ${LENS_NAME_RE}`); return [] }
    if (taken.has(name)) { warnOnce(`skipping ${file}: "${name}" is already a modifier`); return [] }
    let raw: string
    try { raw = readFileSync(join(LOCAL_LENSES_DIR, file), 'utf8') } catch { return [] }
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
    const meta = (key: string) => fm?.[1].match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'mi'))?.[1]
    const instructions = (fm ? raw.slice(fm[0].length) : raw).trim()
    if (!instructions) { warnOnce(`skipping ${file}: no instructions`); return [] }
    taken.add(name)
    const aliases = (meta('aliases') ?? '').split(',').map(a => a.trim()).filter(Boolean).filter(a => {
      if (taken.has(a)) { warnOnce(`${file}: alias "${a}" ignored, already taken`); return false }
      taken.add(a)
      return true
    })
    return [{ type: 'seed' as const, name, aliases, target: 'critic', instructions, isDefault: /^(true|yes)$/i.test(meta('default') ?? '') }]
  })
}

export function resolveModifier(name: string): Modifier | undefined {
  return registry.get(name) ?? localLenses().find(l => l.name === name || l.aliases.includes(name))
}

/**
 * The lenses a review run must cover: every requested lens (explicit + local defaults)
 * plus ponytail by default when automatic lenses run. Single owner for the critic
 * prompt, the +subagent prompt and the advance() gate.
 */
export function requiredLenses(params: { [key: string]: unknown }): string[] {
  const names = ((params.modifiers as Modifier[] | undefined) ?? [])
    .filter((m): m is SeedModifier => m.type === 'seed' && m.target === 'critic')
    .map(m => m.name)
  const autoPonytail = params.autoReviewLenses === true && !params.noAutoLenses && !params.noPonytail
  return [...new Set(autoPonytail ? [...names, 'ponytail'] : names)]
}

/**
 * Add local `default: true` lenses to a run's requested modifiers wherever automatic
 * lenses run (+no-lenses opts out), so every path — critic seed and subagent fallback — sees them.
 */
export function withDefaultLenses<P extends { [key: string]: unknown }>(params: P): P {
  if (params.autoReviewLenses !== true || params.noAutoLenses) return params
  const mods = (params.modifiers as Modifier[] | undefined) ?? []
  const extra = localLenses().filter(l => l.isDefault && !mods.some(m => m.name === l.name))
  return extra.length > 0 ? { ...params, modifiers: [...mods, ...extra] } : params
}

export function resolveModifiers(names: string[]): { resolved: Modifier[]; unknown: string[] } {
  const seen = new Set<string>()
  const resolved: Modifier[] = []
  const unknown: string[] = []
  for (const name of names) {
    const mod = resolveModifier(name)
    if (mod) {
      if (!seen.has(mod.name)) { resolved.push(mod); seen.add(mod.name) }
    } else {
      unknown.push(name)
    }
  }
  return { resolved, unknown }
}

export function listModifierKeys(): string[] {
  return [...registry.keys(), ...localLenses().flatMap(l => [l.name, ...l.aliases])]
}

// Split resolved modifiers into the run params their flags set and the
// modifiers that survive into the run. Flags are consumed here so a protocol
// run never carries one: `+subagent` means "start in subagent review", not "add
// a lens", and leaving it in the list would show up as a `+subagent` note on a
// summary whose critic never existed.
export function partitionFlagModifiers(mods: Modifier[]): { params: Record<string, true>; rest: Modifier[] } {
  const params: Record<string, true> = {}
  const rest: Modifier[] = []
  for (const mod of mods) {
    if (mod.type === 'flag') params[mod.param] = true
    else rest.push(mod)
  }
  return { params, rest }
}

// Split spawn/respawn `+mods` into the single template modifier that applies
// (first one wins — a spawn uses exactly one template) and everything else that
// was ignored: unknown names, seed modifiers (which only apply to protocol
// critics, not spawns), and any second template modifier. The caller warns on
// `ignored` so nothing is silently dropped.
export function partitionSpawnModifiers(names: string[]): { template?: TemplateModifier; ignored: string[] } {
  let template: TemplateModifier | undefined
  const ignored: string[] = []
  for (const name of names) {
    const mod = registry.get(name)
    if (mod?.type === 'template' && !template) template = mod
    else ignored.push(name)
  }
  return { template, ignored }
}

// ---------------------------------------------------------------------------
// Modifier definitions
// ---------------------------------------------------------------------------

export const SECURITY_INSTRUCTIONS = [
  'Review for security vulnerabilities. Correctness and readability are settled — focus purely on attack surface.',
  '',
  'Check for:',
  '- Injection (SQL, command, template, log)',
  '- Authentication and authorization bypass',
  '- Secrets in code, logs, or error messages',
  '- Unsafe deserialization or eval',
  '- Path traversal and symlink attacks',
  '- Race conditions with security implications',
  '- Missing input validation at system boundaries',
  '- Overly permissive defaults',
  '',
  'For each finding: name the vulnerability class, show the specific line, and describe a concrete exploit. No hypotheticals — if you can\'t construct an attack, it\'s not a finding.',
].join('\n')

register({
  type: 'seed',
  name: 'security',
  aliases: ['s'],
  target: 'critic',
  instructions: SECURITY_INSTRUCTIONS,
})

export const READABILITY_INSTRUCTIONS = [
  'Review for readability and maintainability only. Correctness and security are settled unless a readability problem actually hides a defect.',
  '',
  'Check for:',
  '- Unclear or misleading names, and names that disagree with behavior',
  '- Control flow that is hard to follow (deep nesting, tangled branches, hidden early exits)',
  '- Unnecessary complexity: needless abstraction, indirection, flags, or duplicated logic',
  '- Functions or modules doing too many things; mixed levels of abstraction',
  '- Comments that restate code, or missing "why" where the reason is non-obvious',
  '- Inconsistency with the surrounding code\'s idioms and conventions',
  '',
  'For each finding: cite the specific line, say what a reader would misread or struggle with, and give a concrete, smaller rewrite. Skip pure taste — if you can\'t name the comprehension cost, it\'s not a finding.',
].join('\n')

register({
  type: 'seed',
  name: 'readability',
  aliases: ['r'],
  target: 'critic',
  instructions: READABILITY_INSTRUCTIONS,
})

// Unlike prose lenses, +ponytail is a specialized delegated workflow: the
// critic hands one private helper the `/ponytail review` skill, verbatim.
/** How to start a native subagent on each engine — one wording for every lens prompt. */
export const NATIVE_SUBAGENT = '(Claude: the Agent tool; Codex: spawn_agent, then wait_agent)'

export const PONYTAIL_INSTRUCTIONS = [
  'Specialized workflow — do NOT treat this as a generic prose lens and do NOT emulate it yourself.',
  '',
  `Run exactly ONE native subagent for this block ${NATIVE_SUBAGENT}. Quote this entire \`+ponytail:\` block verbatim in its assignment, with the review target inline.`,
  '',
  'Subagent assignment (quoted verbatim):',
  '- Invoke `/ponytail review` (the ponytail-review skill) against the review target, and follow that workflow.',
  '- Return its structured findings as your final answer.',
  '- If you cannot access or invoke `/ponytail review`, answer with a line starting `UNAVAILABLE: /ponytail review` and a one-line reason. Do NOT substitute a generic review.',
  '',
  'Parent reviewer: deduplicate the findings into your single top-level `advance()` critique, under a `+ponytail:` section; this lens does not replace your own review. If the subagent answered `UNAVAILABLE: /ponytail review`, state that visibly in that section — never drop the lens silently or emulate it. If it failed or returned nothing, write `+ponytail: helper returned nothing`.',
].join('\n')

register({
  type: 'seed',
  name: 'ponytail',
  aliases: [],
  target: 'critic',
  instructions: PONYTAIL_INSTRUCTIONS,
})

/** Names of the named review lenses (seed modifiers aimed at the critic), for help/error text. */
export function listLensNames(): string[] {
  return [...new Set([...registry.values(), ...localLenses()].filter((m): m is SeedModifier => m.type === 'seed' && m.target === 'critic').map(m => m.name))]
}

// Factory-as-modifier: `spawn +f: topic` / `respawn +f:` apply the factory
// template. The template itself lives in templates.ts; this just names it.
register({
  type: 'template',
  name: 'factory',
  aliases: ['f'],
  templateName: 'factory',
})

// `review +subagent` — skip the adversarial critic and go straight to the
// owner-run subagent review that a critic death would have fallen back to.
// Cheaper and quieter than a real critic; no adversarial tension either.
register({
  type: 'flag',
  name: 'subagent',
  aliases: ['sa'],
  param: 'directSubagent',
})

// `review +no-fallback` — a critic death cancels the run instead of handing the
// review to the owner. For callers who want adversarial review or nothing.
register({
  type: 'flag',
  name: 'no-fallback',
  aliases: ['nf'],
  param: 'noFallback',
})

// Review lens policy overrides. Ordinary review automatically selects useful
// private helpers and attempts Ponytail; these flags let callers opt out.
register({
  type: 'flag',
  name: 'no-lenses',
  aliases: ['nl'],
  param: 'noAutoLenses',
})

register({
  type: 'flag',
  name: 'no-ponytail',
  aliases: ['np'],
  param: 'noPonytail',
})
