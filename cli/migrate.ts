// `hydra migrate`: write <state>/hydra.toml once from the old files (config/migrate.ts), and say what changed.

import { connect } from 'net'
import { homedir } from 'os'
import { basename, join } from 'path'
import { readEnvFileValue, resolveConfig } from './helpers.js'
import { applyMigrate, finishMigrate, MIGRATE_JOURNAL, planMigrate } from '../config/migrate.js'
import { formatIssues, systemEnv } from '../config/load.js'
import { SESSION_NAMES } from '../shared/session-catalog.js'
import { existsSync } from 'fs'

/** A daemon answers on the state dir's socket. */
function daemonListening(stateDir: string): Promise<boolean> {
  return new Promise(done => {
    const s = connect(join(stateDir, 'daemon.sock'))
    const timer = setTimeout(() => { s.destroy(); done(false) }, 1000)
    s.on('connect', () => { clearTimeout(timer); s.end(); done(true) })
    s.on('error', () => { clearTimeout(timer); done(false) })
  })
}

export async function migrateCommand(opts: { platform?: string; stateDir?: string; dryRun: boolean }): Promise<number> {
  if (opts.platform && opts.platform !== 'discord' && opts.platform !== 'slack') {
    console.error(`error: platform must be discord or slack, not "${opts.platform}"`)
    return 1
  }
  const cfg = resolveConfig(opts.platform)
  const stateDir = opts.stateDir ?? cfg.stateDir
  // The ids in allowFrom are this state dir's platform's: a state dir named for one says which.
  const dirPlatform = ['discord', 'slack'].includes(basename(stateDir)) ? basename(stateDir) : undefined
  if (opts.platform && dirPlatform && opts.platform !== dirPlatform) {
    console.error(`error: ${stateDir} is a ${dirPlatform} state dir, not ${opts.platform}`)
    return 1
  }
  const platform = (opts.platform ?? dirPlatform ?? cfg.platform) === 'slack' ? 'slack' : 'discord'
  // Its own .env says where its sessions start; another state dir's doesn't.
  const spawnCwd = readEnvFileValue(join(stateDir, '.env'), 'SPAWN_CWD')?.trim() || (stateDir === cfg.stateDir ? cfg.spawnCwd : homedir())

  if (!opts.dryRun && await daemonListening(stateDir)) {
    console.error(`error: the daemon for ${stateDir} is running. Stop it first (hydra down ${platform}), run hydra migrate, then hydra up ${platform}.`)
    console.error('nothing was written')
    return 1
  }
  if (existsSync(join(stateDir, MIGRATE_JOURNAL))) {
    if (opts.dryRun) { console.log(`a migration in ${stateDir} was interrupted after it committed; run hydra migrate (without --dry-run) to finish it.`); return 0 }
    finishMigrate(stateDir)
    console.log(`finished the interrupted migration in ${stateDir}.`)
    return 0
  }

  const plan = planMigrate({ stateDir, env: systemEnv(SESSION_NAMES), spawnCwd, platform, daemonCwd: cfg.hydraDir })
  if (!plan.ok) {
    for (const e of plan.errors) console.error(`error: ${e}`)
    console.error('nothing was written')
    return 1
  }
  console.log(plan.text)
  if (plan.warnings.length) console.log(`warnings:\n${formatIssues(plan.warnings)}\n`)
  if (plan.notes.length) console.log(`notes:\n${plan.notes.map(n => `- ${n}`).join('\n')}\n`)
  const changed = Object.keys(plan.writes).filter(f => !f.endsWith('.migrated'))
  const kept = Object.keys(plan.writes).filter(f => f.endsWith('.migrated'))
  if (opts.dryRun) {
    console.log(`dry run: nothing written. Without --dry-run this writes ${['hydra.toml', ...changed].join(', ')} in ${stateDir}, keeps ${kept.join(', ')}${plan.consumed.length ? `, and removes ${plan.consumed.join(', ')}` : ''}.`)
    return 0
  }
  applyMigrate(stateDir, plan)
  console.log(`wrote ${['hydra.toml', ...changed].join(', ')}; kept ${kept.join(', ')}${plan.consumed.length ? `; removed ${plan.consumed.join(', ')}` : ''}. Start the daemon: hydra up ${platform}`)
  return 0
}
