// `hydra config check [<platform>]`: load the state dir's hydra.toml as the daemon would, and say what's wrong.

import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { resolveConfig } from './helpers.js'
import { formatIssues, loadHydraConfig, systemEnv } from '../config/load.js'
import { SESSION_NAMES } from '../shared/session-catalog.js'

export function configCheckCommand(platformArg: string | undefined, stateDirOpt: string | undefined): number {
  if (platformArg && platformArg !== 'discord' && platformArg !== 'slack') { console.error(`error: platform must be discord or slack, not "${platformArg}"`); return 1 }
  const cfg = resolveConfig(platformArg)
  const stateDir = stateDirOpt ?? cfg.stateDir
  const platform = platformArg ?? (['discord', 'slack'].includes(basename(stateDir)) ? basename(stateDir) : cfg.platform)
  const path = join(stateDir, 'hydra.toml')
  if (!existsSync(path)) { console.log(`${path}: none (the old files still apply)`); return 0 }
  const r = loadHydraConfig(readFileSync(path, 'utf8'), systemEnv(SESSION_NAMES, stateDir, cfg.configDir))
  if (!r.ok) {
    console.log(`${path}: doesn't load; a running daemon keeps its last good config\n${formatIssues(r.errors)}`)
    if (r.warnings.length) console.log(formatIssues(r.warnings))
    return 1
  }
  const lines = r.warnings.map(w => `hydra.toml ${w.path}: ${w.message}`)
  const op = r.config.operator ? r.config.people[r.config.operator] : undefined
  // The daemon on this platform passes admin checks only through the operator's address here.
  if (op && !op.ids.some(a => a.startsWith(`${platform}:`))) lines.unshift(`hydra.toml operator: ${op.id} has no ${platform}: address, so on ${platform} nobody passes admin checks or reaches main by DM`)
  console.log(`${path}: loads${lines.length ? `, with ${lines.length} warning${lines.length > 1 ? 's' : ''}` : ' clean'}`)
  if (lines.length) console.log(lines.join('\n'))
  return 0
}
