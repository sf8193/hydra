// `hydra migrate`: write <state>/hydra.toml once from the old files (config/migrate.ts), and say what changed.

import { resolveConfig } from './helpers.js'
import { applyMigrate, planMigrate } from '../config/migrate.js'
import { formatIssues, systemEnv } from '../config/load.js'
import { SESSION_NAMES } from '../shared/session-catalog.js'

export function migrateCommand(opts: { platform?: string; stateDir?: string; dryRun: boolean }): number {
  const cfg = resolveConfig(opts.platform)
  const stateDir = opts.stateDir ?? cfg.stateDir
  const platform = cfg.platform === 'slack' ? 'slack' : 'discord'
  const plan = planMigrate({ stateDir, env: systemEnv(SESSION_NAMES), spawnCwd: cfg.spawnCwd, platform })
  if (!plan.ok) {
    for (const e of plan.errors) console.error(`error: ${e}`)
    console.error('nothing was written')
    return 1
  }
  console.log(plan.text)
  if (plan.warnings.length) console.log(`warnings:\n${formatIssues(plan.warnings)}\n`)
  if (plan.notes.length) console.log(`notes:\n${plan.notes.map(n => `- ${n}`).join('\n')}\n`)
  if (opts.dryRun) {
    const also = Object.keys(plan.writes).filter(f => !f.endsWith('.migrated'))
    console.log(`dry run: nothing written. Without --dry-run this writes ${stateDir}/hydra.toml${also.length ? ` and ${also.join(', ')}` : ''}, keeping every file it changes or retires as *.migrated.`)
    return 0
  }
  applyMigrate(stateDir, plan)
  console.log(`wrote ${stateDir}/hydra.toml${plan.consumed.length ? `; ${plan.consumed.map(f => `${f} is now ${f}.migrated`).join(', ')}` : ''}. A running daemon switches over within a second.`)
  return 0
}
