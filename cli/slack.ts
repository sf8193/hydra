// `hydra slack manifest`: print the Slack app manifest for this hydra, from hydra.toml's Slack apps
// ([slack.apps.<id>], or [connectors.slack] as the app `default`; connectors/slack/app.ts). Stdout only: nothing is written, nothing is sent.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { resolveConfig } from './helpers.js'
import { formatIssues, loadHydraConfig, systemEnv } from '../config/load.js'
import { slackManifest } from '../connectors/slack/app.js'
import { SESSION_NAMES } from '../shared/session-catalog.js'

export function slackCommand(args: string[], stateDirOpt: string | undefined): number {
  if (args.length < 1 || args.length > 2 || args[0] !== 'manifest') {
    console.error('usage: hydra [--state-dir <dir>] slack manifest [<app>]')
    return 1
  }
  const name = args[1]
  const path = join(stateDirOpt ?? resolveConfig().stateDir, 'hydra.toml')
  if (!existsSync(path)) {
    if (name) { console.error(`${path}: none, so there is no app named ${name}`); return 1 }
    console.error(`${path}: none, so the app gets the default name and description and no user scopes`)
    process.stdout.write(slackManifest(undefined))
    return 0
  }
  const r = loadHydraConfig(readFileSync(path, 'utf8'), systemEnv(SESSION_NAMES))
  if (!r.ok) {
    console.error(`${path}: doesn't load, so no manifest\n${formatIssues(r.errors)}`)
    return 1
  }
  const ids = Object.keys(r.config.slackApps)
  const declared = ids.length ? `declares: ${ids.join(', ')}` : 'declares no Slack app'
  if (name) {
    if (!Object.hasOwn(r.config.slackApps, name)) { console.error(`${path}: no app named ${name}; hydra.toml ${declared}`); return 1 }
    process.stdout.write(slackManifest(r.config.slackApps[name], { several: ids.length > 1 }))
    return 0
  }
  if (ids.length > 1) { console.error(`${path}: declares ${ids.length} Slack apps; pass one: hydra slack manifest <app> (${ids.join(', ')})`); return 1 }
  if (!ids.length) console.error(`${path}: declares no Slack app, so the app gets the default name and description and no user scopes`)
  process.stdout.write(slackManifest(r.config.slackApps[ids[0]]))
  return 0
}
