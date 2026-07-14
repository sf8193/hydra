import { readdirSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Lens definition — a composable review pass loaded from protocols/lenses/
// ---------------------------------------------------------------------------

export type LensDef = {
  lens: string
  aliases: string[]
  instructions: string
}

export function defineLens(def: { lens: string; aliases?: string[]; instructions: string }): LensDef {
  if (!def.lens || typeof def.lens !== 'string') throw new Error(`defineLens: lens must be a non-empty string`)
  if (!def.instructions || typeof def.instructions !== 'string') throw new Error(`defineLens("${def.lens}"): instructions must be a non-empty string`)
  return {
    lens: def.lens,
    aliases: def.aliases ?? [],
    instructions: def.instructions,
  }
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
    files = readdirSync(lensesDir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  } catch {
    return lenses
  }

  for (const file of files) {
    try {
      const mod = await import(join(lensesDir, file))
      const def: LensDef = mod.default
      if (!def?.lens) {
        process.stderr.write(`daemon: skipping lens ${file}: no default export with lens field\n`)
        continue
      }
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
