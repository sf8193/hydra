// `hydra people add <id> <address> [--role <r>]... [--name <n>] [--dry-run]`: add a person to hydra.toml (config/people.ts).

import { resolveConfig } from './helpers.js'
import { addPerson } from '../config/people.js'
import { systemEnv } from '../config/load.js'
import { SESSION_NAMES } from '../shared/session-catalog.js'

export function peopleCommand(args: string[], stateDirOpt: string | undefined): number {
  const [sub, id, address] = args
  if (sub !== 'add' || !id || !address || id.startsWith('-') || address.startsWith('-')) {
    console.error('usage: hydra [--state-dir <dir>] people add <id> <address> [--role <role>]... [--name <name>] [--dry-run]')
    console.error('  <address>: discord:<user id>, slack:<user id> or github:<login>')
    return 1
  }
  const roles: string[] = []
  let name: string | undefined
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--role' && args[i + 1]) roles.push(args[++i])
    else if (args[i] === '--name' && args[i + 1]) name = args[++i]
    else if (args[i] !== '--dry-run') { console.error(`error: unknown option ${args[i]}`); return 1 }
  }
  const cfg = stateDirOpt ? undefined : resolveConfig()
  const stateDir = stateDirOpt ?? cfg!.stateDir
  const dryRun = args.includes('--dry-run')
  const plan = addPerson(stateDir, systemEnv(SESSION_NAMES, stateDir, cfg?.configDir), { id, address, roles, ...(name && { name }) }, { dryRun })
  if (!plan.ok) { console.error(`error: ${plan.error}`); console.error('hydra.toml was not changed'); return 1 }
  if (dryRun) { console.log(plan.text); console.log(`dry run: would append ${plan.added}`); return 0 }
  console.log(`added ${plan.added} to ${stateDir}/hydra.toml; the daemon picks it up within a second`)
  return 0
}
