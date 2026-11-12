// `hydra slack manifest`: print the Slack app manifest for this hydra, from hydra.toml's [connectors.slack]
// (connectors/slack/app.ts). Stdout only: nothing is written, nothing is sent.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { resolveConfig } from './helpers.js'
import { formatIssues, loadHydraConfig, systemEnv } from '../config/load.js'
import { slackManifest } from '../connectors/slack/app.js'
import { SESSION_NAMES } from '../shared/session-catalog.js'

export function slackCommand(args: string[], stateDirOpt: string | undefined): number {
  if (args.length !== 1 || args[0] !== 'manifest') {
    console.error('usage: hydra [--state-dir <dir>] slack manifest')
    return 1
  }
  const path = join(stateDirOpt ?? resolveConfig().stateDir, 'hydra.toml')
  if (!existsSync(path)) {
    console.error(`${path}: none, so the app gets the default name and description and no user scopes`)
    process.stdout.write(slackManifest(undefined))
    return 0
  }
  const r = loadHydraConfig(readFileSync(path, 'utf8'), systemEnv(SESSION_NAMES))
  if (!r.ok) {
    console.error(`${path}: doesn't load, so no manifest\n${formatIssues(r.errors)}`)
    return 1
  }
  const slack = r.config.connectors.slack
  if (!slack) console.error(`${path}: no [connectors.slack], so the app gets the default name and description and no user scopes`)
  process.stdout.write(slackManifest(slack))
  return 0
}
