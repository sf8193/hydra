// Claude Code mods hydra sessions load: the tracked mod/ plus each gitignored mods.local/<name>/.
// The daemon copies them at boot into <stateDir>/mods/, so a branch switch in the shared
// checkout can't change what sessions run; Claude Code hot-reloads a session's mods when
// the copy changes. Each session gets the copies through CLAUDE_CODE_PLUGIN_DIRS.

import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'

/** Copies every mod into <stateDir>/mods/<name> and removes copies whose source is gone. Returns the names. */
export function syncMods(repoDir: string, stateDir: string): string[] {
  const sources = new Map<string, string>([['hydra', join(repoDir, 'mod')]])
  const local = join(repoDir, 'mods.local')
  if (existsSync(local)) {
    for (const name of readdirSync(local)) {
      if (!statSync(join(local, name)).isDirectory()) continue
      // `hydra` is the tracked mod's copy; ':' separates CLAUDE_CODE_PLUGIN_DIRS entries.
      if (name === 'hydra' || name.includes(':')) { process.stderr.write(`hydra: mods.local/${name} skipped: rename it\n`); continue }
      sources.set(name, join(local, name))
    }
  }
  const dest = join(stateDir, 'mods')
  if (existsSync(dest)) {
    for (const name of readdirSync(dest)) if (!sources.has(name)) rmSync(join(dest, name), { recursive: true, force: true })
  }
  // Replaced whole, so a file deleted from a mod (a skill, a module) leaves its copy too.
  for (const [name, src] of sources) {
    rmSync(join(dest, name), { recursive: true, force: true })
    cpSync(src, join(dest, name), { recursive: true })
  }
  return [...sources.keys()]
}

/** The `export` line that hands a session the mods the daemon synced at boot. */
export function modsExport(stateDir: string): string {
  const dest = join(stateDir, 'mods')
  const dirs = readdirSync(dest).map(n => join(dest, n))
  return `export CLAUDE_CODE_PLUGIN_DIRS='${dirs.join(':').replace(/'/g, "'\\''")}'`
}
