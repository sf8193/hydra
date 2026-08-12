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

export type Modifier = SeedModifier | TemplateModifier

const registry = new Map<string, Modifier>()

function register(mod: Modifier): void {
  if (!mod.name) throw new Error('modifier must have a name')
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
