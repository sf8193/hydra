// `hydra config add <fragment.toml> [--dry-run]`: add an outside repo's [specialists.*] and [schedules.*] to hydra.toml (config/add.ts).

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { resolveConfig } from './helpers.js'
import { addFragment } from '../config/add.js'
import { systemEnv } from '../config/load.js'
import { SESSION_NAMES } from '../shared/session-catalog.js'

export function configAddCommand(args: string[], stateDirOpt: string | undefined): number {
  const files = args.filter(a => a !== '--dry-run')
  if (files.length !== 1 || files[0].startsWith('-')) {
    console.error('usage: hydra [--state-dir <dir>] config add <fragment.toml> [--dry-run]')
    console.error('  the fragment holds [specialists.<id>] and [schedules.<id>] tables, as in hydra.example.toml')
    return 1
  }
  const file = resolve(files[0])
  let text: string
  try { text = readFileSync(file, 'utf8') } catch (e) { console.error(`error: can't read ${file}: ${(e as Error).message}`); return 1 }
  const cfg = stateDirOpt ? undefined : resolveConfig()
  const stateDir = stateDirOpt ?? cfg!.stateDir
  const dryRun = args.includes('--dry-run')
  const plan = addFragment(stateDir, systemEnv(SESSION_NAMES, stateDir, cfg?.configDir), text, file, { dryRun })
  if (!plan.ok) { console.error(`error: ${plan.error}`); console.error('hydra.toml was not changed'); return 1 }
  const already = plan.already.length ? `already there: ${plan.already.join(', ')}` : ''
  if (!plan.added.length) { console.log(`${already}; hydra.toml was not changed`); return 0 }
  if (dryRun) {
    console.log(plan.text.slice(plan.from.length).replace(/^\r?\n+/, ''))
    console.log(`dry run: would append ${plan.added.join(', ')}${already && `; ${already}`}`)
    return 0
  }
  console.log(`added ${plan.added.join(', ')} to ${stateDir}/hydra.toml; the daemon picks it up within a second${already && `; ${already}`}`)
  return 0
}
