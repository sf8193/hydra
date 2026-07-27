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

export type Modifier = SeedModifier

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
