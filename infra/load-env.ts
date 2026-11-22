// The machine, as hydra.toml's loader asks about it: this LoadEnv's answers (folders, commands, symlinks, git work trees, the
// workdir scan, the state dir's `.env`, MCP config files, the macOS version) are read for real. The loader itself is pure but for these answers
// (config/load.ts loadHydraConfig), so the same text and machine give the same result.

import { statSync, accessSync, lstatSync, readdirSync, readFileSync, realpathSync, constants as fsConstants } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve, sep } from 'path'
import { parseEnvLine } from '../shared/env-parse.js'
import { claudeConfigDir as sessionsClaudeConfigDir } from '../shared/constants.js'
import type { LoadEnv, WorkdirScan } from '../config/types.js'

let macosVersionOnce: { value: string | undefined } | undefined

/** `sw_vers -productVersion` on macOS, read once (the OS does not change under a running daemon); undefined when this is not macOS; the empty string when `sw_vers` cannot be read (which unprovenMacos counts as unproven). */
function macosVersion(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  if (!macosVersionOnce) {
    let v = ''
    try { v = new TextDecoder().decode(Bun.spawnSync(['/usr/bin/sw_vers', '-productVersion']).stdout).trim() } catch { /* unreadable: the empty string */ }
    macosVersionOnce = { value: v }
  }
  return macosVersionOnce.value
}

/** The machine as it is: `~` is this user's home, folders and commands are looked up for real. */
export function systemEnv(sessionNames: readonly string[], stateDir: string, platform: LoadEnv['platform'], claudeConfigDir: string = sessionsClaudeConfigDir()): LoadEnv {
  return {
    home: homedir(),
    platform,
    macosVersion: macosVersion(),
    sessionNames,
    stateDir,
    claudeConfigDir,
    exists: path => { try { statSync(path); return true } catch { return false } },
    mcpNamesIn: path => {
      let text: string
      try { text = readFileSync(path, 'utf8') } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return []   // no such file: nothing declared there
        throw new Error(`${path} cannot be read (${err instanceof Error ? err.message : String(err)})`)
      }
      let j: { mcpServers?: object }
      try { j = JSON.parse(text) } catch (err) { throw new Error(`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`) }
      return Object.keys(j?.mcpServers ?? {})
    },
    envFileHas: name => {
      try {
        for (const line of readFileSync(join(stateDir, '.env'), 'utf8').split('\n')) { const kv = parseEnvLine(line); if (kv && kv[0] === name && kv[1].trim() !== '') return true }
      } catch { /* no .env */ }
      return false
    },
    realpath: nearestRealpath,
    isGitWorkTree: path => {
      for (let p = resolve(path); ; p = dirname(p)) {
        try { lstatSync(join(p, '.git')); return true } catch { /* not here */ }
        if (dirname(p) === p) return false
      }
    },
    scanWorkdir: dir => scanWorkdirOnDisk(dir),
    isDir: path => { try { return statSync(path).isDirectory() } catch { return false } },
    isCommand: command => {
      if (!command.includes('/')) return Bun.which(command) !== null
      try { accessSync(command, fsConstants.X_OK); return statSync(command).isFile() } catch { return false }
    },
  }
}

/**
 * The path with symlinks resolved. A path that does not exist yet is resolved through its nearest existing ancestor, with the rest
 * put back: `/tmp/x/y` is `/private/tmp/x/y` whether or not `x` exists, as Seatbelt (which matches resolved paths) sees it.
 */
export function nearestRealpath(path: string): string {
  const rest: string[] = []
  for (let p = path; ; p = dirname(p)) {
    try { return join(realpathSync(p), ...rest.reverse()) } catch { /* not here: try the parent */ }
    if (dirname(p) === p) return path
    rest.push(basename(p))
  }
}

const SCAN_MAX_ENTRIES = 50_000

/**
 * Looks through `dir` for symlinks that resolve outside it (a dangling one counts: where it points cannot be checked) and for
 * git repositories below it. Stops after `maxEntries` entries and says so (`truncated`): a folder too big to look through is not
 * thereby clean.
 */
export function scanWorkdirOnDisk(dir: string, maxEntries = SCAN_MAX_ENTRIES): WorkdirScan {
  const out: WorkdirScan = { escapingSymlinks: [], nestedGit: [], truncated: false }
  let root: string
  try { root = realpathSync(dir) } catch { return out }
  let seen = 0
  const walk = (d: string, top: boolean) => {
    let names: string[]
    try { names = readdirSync(d) } catch { return }
    for (const name of names) {
      if (out.truncated) return
      if (++seen > maxEntries) { out.truncated = true; return }
      const full = join(d, name)
      let st
      try { st = lstatSync(full) } catch { continue }
      if (name === '.git' && !top) { if (out.nestedGit.length < 5) out.nestedGit.push(full); continue }
      if (st.isSymbolicLink()) {
        let target: string
        try { target = realpathSync(full) } catch { if (out.escapingSymlinks.length < 5) out.escapingSymlinks.push(full); continue }
        if (target !== root && !target.startsWith(root + sep) && out.escapingSymlinks.length < 5) out.escapingSymlinks.push(full)
      } else if (st.isDirectory() && name !== '.git') walk(full, false)
    }
  }
  walk(root, true)
  return out
}
