// ---------------------------------------------------------------------------
// Modifier registry — composable `+name` modifiers for protocol runs
// ---------------------------------------------------------------------------

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

export function resolveModifier(name: string): Modifier | undefined {
  return registry.get(name)
}

export function resolveModifiers(names: string[]): { resolved: Modifier[]; unknown: string[] } {
  const seen = new Set<string>()
  const resolved: Modifier[] = []
  const unknown: string[] = []
  for (const name of names) {
    const mod = registry.get(name)
    if (mod) {
      if (!seen.has(mod.name)) { resolved.push(mod); seen.add(mod.name) }
    } else {
      unknown.push(name)
    }
  }
  return { resolved, unknown }
}

export function listModifierKeys(): string[] {
  return [...registry.keys()]
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
