// The operator tagging the bot in a channel admits it: append `[places."<platform>:<id>".access]` to hydra.toml, the way
// `hydra people add` adds a person (under the lock, written only if the result loads, an existing file's text kept as it is).

import { readFileSync } from 'fs'
import { join } from 'path'
import { withHydraTomlLock, writeIfUnchanged } from './append.js'
import { formatIssues, loadHydraConfig } from './load.js'
import { appendText, HYDRA_TOML } from './toml-doc.js'
import type { LoadEnv } from './types.js'

export type AdmitResult = { ok: true } | { ok: false; error: string }

/** The channel hears only `operator` (a person id in `[people]`), when tagged; its session threads listen without a tag. */
export function admitChannel(stateDir: string, env: LoadEnv, platform: string, channelId: string, operator: string): AdmitResult {
  return withHydraTomlLock(stateDir, (): AdmitResult => {
    let from: string
    try { from = readFileSync(join(stateDir, HYDRA_TOML), 'utf8') } catch (e) { return { ok: false, error: `hydra.toml can't be read: ${(e as Error).message}` } }
    const text = appendText(from, `[places.${JSON.stringify(`${platform}:${channelId}`)}.access]\nmention = true\nallow = [${JSON.stringify(operator)}]\nlisten = true\n`)
    const loaded = loadHydraConfig(text, env)
    if (!loaded.ok) return { ok: false, error: `hydra.toml wouldn't load with this channel added:\n${formatIssues(loaded.errors)}` }
    const changed = writeIfUnchanged(stateDir, from, text)
    return changed ? { ok: false, error: changed } : { ok: true }
  }, error => ({ ok: false, error }))
}
