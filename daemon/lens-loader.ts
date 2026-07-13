import { readdirSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Lens definition — a composable review pass loaded from protocols/lenses/
// ---------------------------------------------------------------------------

export type LensDef = {
  lens: string
  aliases: string[]
  instructions: string
  source: string
}

const SKELETON_FENCE = /```yaml skeleton\n([\s\S]*?)\n```/

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

  const aliases: string[] = Array.isArray(raw.aliases) ? raw.aliases.map(String) : []

  const instructionsMatch = source.match(/## Instructions\n\n([\s\S]*?)(?:\n## Skeleton\n|\n```yaml skeleton|$)/)
  if (!instructionsMatch) fail('missing ## Instructions section')
  const instructions = instructionsMatch[1].trim()
  if (!instructions) fail('## Instructions section is empty')

  return { lens, aliases, instructions, source }
}

const singletonCache = new Map<string, LensDef>()
let singletonLoaded = false

export async function getLenses(lensesDir: string): Promise<Map<string, LensDef>> {
  if (singletonLoaded) return singletonCache
  const loaded = await loadLensesFromDir(lensesDir)
  singletonCache.clear()
  for (const [k, v] of loaded) singletonCache.set(k, v)
  singletonLoaded = true
  return singletonCache
}

export function getLensesSync(): Map<string, LensDef> {
  return singletonCache
}

export async function loadLensesFromDir(lensesDir: string): Promise<Map<string, LensDef>> {
  const lenses = new Map<string, LensDef>()
  let files: string[]
  try {
    files = readdirSync(lensesDir).filter(f => f.endsWith('.md'))
  } catch {
    return lenses
  }

  for (const file of files) {
    try {
      const def = await loadLensDef(join(lensesDir, file))
      for (const key of [def.lens, ...def.aliases]) {
        const existing = lenses.get(key)
        if (existing && existing.lens !== def.lens) {
          process.stderr.write(`daemon: lens alias collision: "${key}" claimed by both "${existing.lens}" and "${def.lens}" (${file}) — keeping "${existing.lens}"\n`)
          continue
        }
        lenses.set(key, def)
      }
    } catch (err) {
      process.stderr.write(`daemon: skipping malformed lens ${file}: ${err}\n`)
    }
  }

  return lenses
}
