// `hydra config check [<platform>]`: load the state dir's hydra.toml as the daemon would, and say what's wrong.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { resolveConfig, statePlatform } from './helpers.js'
import { formatIssues, loadHydraConfig } from '../config/load.js'
import { systemEnv } from '../infra/load-env.js'
import { answersLines } from '../routing/route.js'
import { SESSION_NAMES } from '../shared/session-catalog.js'
import { isKnownModel, resolveLaunchModel } from '../shared/constants.js'

export function configCheckCommand(platformArg: string | undefined, stateDirOpt: string | undefined): number {
  if (platformArg && platformArg !== 'discord' && platformArg !== 'slack') { console.error(`error: platform must be discord or slack, not "${platformArg}"`); return 1 }
  const cfg = resolveConfig(platformArg)
  const stateDir = stateDirOpt ?? cfg.stateDir
  const platform = statePlatform(stateDir, platformArg, cfg.platform)
  const path = join(stateDir, 'hydra.toml')
  if (!existsSync(path)) { console.log(`${path}: none: no operator, so every DM is dropped (hydra migrate ${platform} --operator <your user id>)`); return 0 }
  const r = loadHydraConfig(readFileSync(path, 'utf8'), systemEnv(SESSION_NAMES, stateDir, platform, cfg.configDir))
  if (!r.ok) {
    console.log(`${path}: doesn't load; a running daemon keeps its last good config\n${formatIssues(r.errors)}`)
    if (r.warnings.length) console.log(formatIssues(r.warnings))
    return 1
  }
  const lines = r.warnings.map(w => `hydra.toml ${w.path}: ${w.message}`)
  const op = r.config.operator ? r.config.people[r.config.operator] : undefined
  // The daemon on this platform passes admin checks only through the operator's address here.
  if (op && !op.addresses.some(a => a.startsWith(`${platform}:`))) lines.unshift(`hydra.toml operator: ${op.id} has no ${platform}: address, so on ${platform} nobody passes admin checks or reaches main by DM`)
  console.log(`${path}: loads${lines.length ? `, with ${lines.length} warning${lines.length > 1 ? 's' : ''}` : ' clean'}`)
  if (lines.length) console.log(lines.join('\n'))
  const main = r.config.main
  if (main) {
    const model = resolveLaunchModel(main.model)
    const unknown = isKnownModel(model) ? '' : `; not a model hydra knows, so check the spelling (it starts anyway)`
    console.log(`main model: ${model} ([main] model = ${JSON.stringify(main.model)}), applies at main's next start${unknown}`)
  }
  if (Object.keys(r.config.specialists).length) console.log(answersLines(r.config).join('\n'))
  return 0
}
