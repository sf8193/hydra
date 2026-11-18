// `hydra specialist browser <name> [--server <name>] [--dry-run]`: open a write-confined specialist's browser profile in a normal, headed window, once, so the operator can log it
// in to exactly what it should have (the trust ladder's rung 2). Generic: the command that opens the browser is the specialist's own server's `login_command`
// (hydra.toml, `[mcp_servers.<name>]`), with `{profile_dir}` and `{download_dir}` filled in as the launch fills `profile_args`; no browser is named here.
//
// Run by the operator at their own terminal, never by a session (a session's environment names it; this refuses). `--dry-run` opens and writes nothing, so a session may run it to see the plan. It never reads the profile: it looks for the lock files
// the server declares (`profile_locks`) by name, and says so. A browser using the profile holds those; the command refuses and says to `hydra kill` the specialist's
// session first. If the server declares a `setup_command` (installing what it needs on this machine), that runs first, in the foreground. It spawns the login command detached and prints exactly what it ran.

import { spawn } from 'child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { resolveConfig, statePlatform } from './helpers.js'
import { loadHydraConfig, nearestRealpath, systemEnv, formatIssues } from '../config/load.js'
import { SESSION_NAMES } from '../shared/session-catalog.js'
import { browserDownloadDir, browserProfileDir, browserProfileProblem, canonicalFolder, fillProfile } from '../config/write-confinement.js'
import type { HydraConfig } from '../config/types.js'

/** The file hydra writes in a profile folder it made (or found empty): outside any browser's own files. A populated folder without it was filled by something else first. */
export const LOGIN_MARKER = '.hydra-browser-login'
export type ProfileState = 'missing' | 'empty' | 'marked' | 'populated'
export type BrowserProbes = {
  /** A file by name, without following a symlink (Chromium's `SingletonLock` is a symlink to nothing while the browser runs). */
  present: (path: string) => boolean
  isSession: boolean
  realpath?: (path: string) => string
  /** Whether the folder is missing, empty, holds the marker, or holds anything else: it lists nothing more than whether it is empty, and reads no file. */
  profileState?: (dir: string) => ProfileState
}
export type BrowserPlan = { ok: true; server: string; profile: string; downloads: string; argv: string[]; setup?: string[]; state: ProfileState } | { ok: false; error: string }
export const UNTRUSTED_NOTE = 'this profile folder is writable by the specialist\'s session: treat it as untrusted (an extension, a startup page or a native-messaging host planted in it would run as you when you open it); run hydra specialist browser before the specialist\'s first session, and hydra kill its session before and while you use it'

export function planBrowser(config: HydraConfig, id: string, opts: { server?: string; trustExisting?: boolean; dryRun?: boolean }, probes: BrowserProbes): BrowserPlan {
  const fail = (error: string): BrowserPlan => ({ ok: false, error })
  if (probes.isSession && !opts.dryRun) return fail('hydra specialist browser is for the operator at their own terminal; it is not run from a hydra session')
  const qualifies = Object.values(config.specialists).filter(s => s.canOnlyWriteTo && (s.mcpServerNames ?? []).some(n => config.mcpServers?.[n]?.loginCommand)).map(s => s.id)
  const s = Object.hasOwn(config.specialists, id) ? config.specialists[id] : undefined
  if (!s) return fail(`no specialist ${id} in hydra.toml (write-confined ones with a browser: ${qualifies.join(', ') || 'none'})`)
  if (!s.canOnlyWriteTo) return fail(`specialist ${id} has no can_only_write_to: its browser profile is the one that level gives it; without it the browser is the operator's own`)
  const candidates = (s.mcpServerNames ?? []).filter(n => config.mcpServers?.[n]?.loginCommand)
  if (candidates.length === 0) return fail(`specialist ${id} lists no server that declares login_command in [mcp_servers.<name>]: declare how to open its browser there`)
  let name = opts.server
  if (name !== undefined && !candidates.includes(name)) return fail(`specialist ${id} has no listed server ${name} that declares login_command (${candidates.join(', ')})`)
  if (name === undefined) { if (candidates.length > 1) return fail(`specialist ${id} lists several servers that declare login_command (${candidates.join(', ')}): choose one with --server <name>`); name = candidates[0] }
  const server = config.mcpServers![name]
  const profile = browserProfileDir(s.workdir, s.browserProfile), downloads = browserDownloadDir(s.workdir, s.browserProfile)
  // The folder as it resolves now, not as hydra.toml was loaded: a session can swap `.browser` or the named folder for a link out of the workdir.
  const real = probes.realpath ?? (p => p)
  const dir = canonicalFolder(profile, real), root = canonicalFolder(s.workdir, real)
  const why = s.browserProfile !== undefined ? browserProfileProblem(s.workdir, profile, real, [])
    : (dir.startsWith(`${root}/`) ? undefined : `${profile} resolves outside the workdir ${s.workdir}: it would keep the specialist's logins outside its own folder`)
  if (why) return fail(`the profile folder cannot be used now: ${why}`)
  for (const lock of server.profileLocks ?? []) {
    const path = `${profile}/${lock}`
    if (probes.present(path)) return fail(`the profile is in use: ${path} exists, which a browser using that profile leaves (declared as profile_locks of [mcp_servers.${name}]); hydra only looked for that name and read nothing else. If a session of ${id} is running, run \`hydra kill ${id}\` first; if a browser is open on it, close it; a stale file is yours to remove`)
  }
  const state = probes.profileState ? probes.profileState(profile) : 'missing'
  if (state === 'populated' && !opts.trustExisting) return fail(`${profile} already holds files and hydra did not make it (it has no ${LOGIN_MARKER}): something else, possibly a session of ${id}, filled it first, and what is in it would run as you in a headed browser. If you have looked at it and it is yours, run again with --trust-existing; otherwise remove the folder and run hydra specialist browser before the first session`)
  return { ok: true, server: name, profile, downloads, state, argv: server.loginCommand!.map(a => fillProfile(a, s.workdir, s.browserProfile)), ...(server.setupCommand && { setup: server.setupCommand }) }
}

export type BrowserIO = { config: HydraConfig; probes: BrowserProbes; mkdir: (dir: string) => void; mark: (profile: string) => void; setup: (argv: string[]) => Promise<void>; spawn: (argv: string[]) => Promise<void>; log: (line: string) => void; error: (line: string) => void }

export async function browserCommand(args: string[], io: BrowserIO): Promise<number> {
  const opts: { server?: string; trustExisting?: boolean; dryRun?: boolean } = {}
  let id: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--trust-existing') opts.trustExisting = true
    else if (a === '--server' && args[i + 1]) opts.server = args[++i]
    else if (a.startsWith('-')) { io.error(`error: unknown option ${a}`); return 1 }
    else if (id === undefined) id = a
    else { io.error(`error: unexpected argument ${a}`); return 1 }
  }
  if (!id) { io.error('usage: hydra [--state-dir <dir>] specialist browser <name> [--server <name>] [--trust-existing] [--dry-run]'); return 1 }
  const plan = planBrowser(io.config, id, opts, io.probes)
  if (!plan.ok) { io.error(`error: ${plan.error}`); return 1 }
  const shown = plan.argv.join(' ')
  const setupShown = plan.setup?.join(' ')
  if (opts.dryRun) { if (setupShown) io.log(`would first run: ${setupShown}`); io.log(`would open: ${shown}`); io.log(`profile folder: ${plan.profile} (downloads: ${plan.downloads})`); io.log(`note: ${UNTRUSTED_NOTE}`); return 0 }
  // Setup can take minutes (a download), so the plan is made again after it: the lock files and the profile's state are read immediately before the folders are made and the window opens.
  let go = plan
  if (plan.setup) {
    io.log(`setting up: ${setupShown}`)
    try { await io.setup(plan.setup) } catch (err) { io.error(`error: setup failed: ${setupShown}: ${err instanceof Error ? err.message : String(err)}`); return 1 }
    const again = planBrowser(io.config, id, opts, io.probes)
    if (!again.ok) { io.error(`error: ${again.error}`); return 1 }
    go = again
  }
  io.mkdir(go.profile); io.mkdir(go.downloads)
  if (go.state !== 'marked') io.mark(go.profile)
  try { await io.spawn(go.argv) } catch (err) { io.error(`error: could not start ${go.argv[0]}: ${err instanceof Error ? err.message : String(err)}`); return 1 }
  io.log(`opened: ${shown}`)
  io.log(`profile folder: ${go.profile} (downloads: ${go.downloads})`)
  io.log(`note: ${UNTRUSTED_NOTE}`)
  io.log(`log in to what ${id} should have, then close the browser window; hydra did not read the profile`)
  return 0
}

/** The real thing: the state dir's hydra.toml, the real filesystem, a detached spawn that is awaited until the process has started (or failed to). */
export async function browserMain(args: string[], stateDirOpt: string | undefined): Promise<number> {
  const cfg = stateDirOpt ? undefined : resolveConfig()
  const stateDir = stateDirOpt ?? cfg!.stateDir
  const path = join(stateDir, 'hydra.toml')
  if (!existsSync(path)) { console.error(`error: ${path} does not exist`); return 1 }
  const r = loadHydraConfig(readFileSync(path, 'utf8'), systemEnv(SESSION_NAMES, stateDir, statePlatform(stateDir, undefined, cfg?.platform), cfg?.configDir))
  if (!r.ok) { console.error(`error: ${path} doesn't load:\n${formatIssues(r.errors)}`); return 1 }
  return browserCommand(args, {
    config: r.config,
    // The session check is an environment check, a courtesy guard: a session's shell cannot reach the daemon anyway, and unsetting HYDRA_SESSION_ID would get past it.
    probes: { present: lstatPresent, isSession: !!process.env.HYDRA_SESSION_ID, realpath: nearestReal, profileState: realProfileState },
    mkdir: realMkdir, mark: realMark,
    setup: realSetup,
    spawn: argv => new Promise<void>((resolve, reject) => { const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' }); c.once('error', reject); c.once('spawn', () => { c.unref(); resolve() }) }),
    log: l => console.log(l), error: l => console.error(l),
  })
}

/** The setup command in the foreground, its output on the operator's terminal (an install shows progress); a non-zero exit or a failure to start rejects. */
export const realSetup = (argv: string[]): Promise<void> => new Promise<void>((resolve, reject) => {
  const c = spawn(argv[0], argv.slice(1), { stdio: 'inherit' })
  c.once('error', reject)
  c.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(signal ? `killed by ${signal}` : `exit ${code}`)))
})

export const lstatPresent = (p: string): boolean => { try { lstatSync(p); return true } catch { return false } }
export const nearestReal = nearestRealpath   // the nearest existing ancestor resolved, the rest appended (a folder not yet made still resolves through its parents)
export function realProfileState(dir: string): ProfileState {
  try { lstatSync(dir) } catch { return 'missing' }
  let names: string[]
  try { names = readdirSync(dir) } catch { return 'populated' }
  if (names.length === 0) return 'empty'
  return names.includes(LOGIN_MARKER) ? 'marked' : 'populated'
}
/** A folder made 0700, or an existing one brought to it (mkdir's mode applies only to a folder it makes). */
export const realMkdir = (d: string): void => { mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700) }
export const realMark = (profile: string): void => writeFileSync(join(profile, LOGIN_MARKER), 'made or adopted by hydra specialist browser\n', { mode: 0o600 })
