// The spawn prompt, handed to a session's pane by file. A prompt on the pane's command line is matched by any `pkill -f` or
// `pgrep -f` that names a word of it, and so can end a live session. The command holds a file path instead; the pane's shell
// reads the file (`load`) into a shell variable and the engine's launch command uses the variable (`ref`).
//
// <state>/spawn-prompts/<session name>-<session id>.prompt, mode 0600 in a 0700 folder. Written by a launch, before the pane
// exists; removed when the session ends, by kill or by death (removeLaunchFiles), or when the launch fails. The next launch of
// the same name removes the earlier file. A relaunch writes its own, from the prompt the daemon builds for it: nothing reads an
// old file again, so a respawn after a crash needs none (a Claude resume takes no prompt at all).

import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, STATE_WRITABLE } from './config.js'
import { removeRestrictedFiles } from './restricted-files.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const spawnPromptDir = () => join(STATE_DIR, 'spawn-prompts')
const pathOf = (tmuxName: string, sessionId: string) => join(spawnPromptDir(), `${tmuxName}-${sessionId}.prompt`)

const VAR = '_hydra_prompt'

export type SpawnPromptFile = {
  path: string
  /** A step in the pane's `&&` chain: puts the file's exact bytes in a shell variable. Fails the chain when the file cannot be read. */
  load: string
  /** The variable, quoted: the prompt as one word. */
  ref: string
}

/**
 * Writes the prompt to its file (earlier files of this exact session name removed first) and gives the shell text that reads it.
 * `$(...; printf x)` and the strip after it keep trailing newlines, which `$(...)` alone would drop; `&&` inside the substitution
 * makes an unreadable file fail the chain, where `;` would leave an empty prompt.
 */
export function writeSpawnPrompt(tmuxName: string, sessionId: string, text: string): SpawnPromptFile {
  // A shell variable cannot hold NUL, so `a\0b` would reach the session as `ab`. A command line could not carry it either (exec refuses): fail the same way, loudly.
  if (text.includes('\0')) throw new Error(`the spawn prompt for ${tmuxName} holds a NUL byte, which a session's prompt cannot carry`)
  mkdirSync(spawnPromptDir(), { recursive: true, mode: 0o700 })
  chmodSync(spawnPromptDir(), 0o700)   // mkdir's mode applies to a new folder only
  const earlier = new RegExp(`^${escapeRe(tmuxName)}-${UUID}\\.prompt$`)
  for (const f of readdirSync(spawnPromptDir())) if (earlier.test(f) && f !== `${tmuxName}-${sessionId}.prompt`) rmSync(join(spawnPromptDir(), f), { force: true })
  const path = pathOf(tmuxName, sessionId)
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)   // the mode above is masked by the umask on create only
  return { path, load: `${VAR}=$(cat ${shq(path)} && printf x) && ${VAR}=\${${VAR}%x}`, ref: `"$${VAR}"` }
}

/** Removes one session's prompt file. Quiet when there is none. A process that does not own the state dir removes nothing. */
export function removeSpawnPrompt(session: { tmuxName: string; sessionId: string }, writable: boolean = STATE_WRITABLE): void {
  if (!writable) return
  rmSync(pathOf(session.tmuxName, session.sessionId), { force: true })
}

/** Everything a launch wrote for one session (its restricted config, its prompt file): the one call for a session's end. */
export function removeLaunchFiles(session: { tmuxName: string; sessionId: string }, writable: boolean = STATE_WRITABLE): void {
  removeRestrictedFiles(session, writable)
  removeSpawnPrompt(session, writable)
}
