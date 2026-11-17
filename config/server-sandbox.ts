// The sandbox a listed `[mcp_servers.*]` server of a restricted specialist runs under. A macOS implementation (Seatbelt, through
// `/usr/bin/sandbox-exec`); where it is missing, a specialist that lists servers is refused, never run without it.
//
// BEST-EFFORT HYGIENE, NOT CONTAINMENT. A listed server is code the operator trusts with their own privileges (SERVER_TRUST_SENTENCE in
// daemon/restricted.ts); the per-server `tools` list is the control. This profile is a layer proven by probes on one macOS version, written
// to stop a buggy or unsophisticated server from doing the obvious damage. It does not stop a hostile one.
//
// The profile is one fixed text for every operator, which the server's own children inherit. It starts from "allow everything" and
// takes away the following. Each is pinned by a test against the real sandbox-exec (config/__tests__/server-sandbox.test.ts), except
// name lookup, which only an opt-in network test pins:
//   - every unix-socket connect except name lookup: not the daemon's socket, tmux, or another session;
//   - file writes outside the server's own temp folder and two devices (/dev/null, /dev/dtracehelper): no shell rc files, LaunchAgents
//     or ~/.claude.json;
//   - reading the contents of the other servers' temp folders (the parent folder, except its own; their names and sizes stay visible,
//     since `mkdir -p` has to look at its parents);
//   - reads and writes of the places a restricted specialist must not know (restricted-workdir.ts `offLimitRoots`, the one list; a floor, not a
//     complete inventory);
//   - another process's environment: `kern.procargs*` together with process-info on anything but itself and its children. BOTH are
//     needed, and `(target others)` is not enough: it leaves out the server's own process group, where claude sits;
//   - another process's full command line through the system monitor service (`pgrep -fl`: `com.apple.sysmond`);
//   - signals to anything but itself and its own children;
//   - ioctl on terminal devices, which closes keystroke injection (TIOCSTI) into the session's pane. Removing write access to /dev/tty
//     is not enough: a read-only open, or an inherited stderr, still injects;
//   - the LaunchServices and CoreServices mach names (the route out through `open` and the system call behind it: a helper started
//     outside the sandbox), the preferences service (`defaults write` into ~/Library/Preferences) and the pasteboard service. The
//     first also breaks Apple Events to Terminal and claude.ai.
//
// What it does not do: the network is fully open; a place not on the list is readable (shell history, /etc, variables exported in rc
// files, any other folder); the server still receives claude's own environment at launch and runs with the operator's HOME;
// shortcuts (and Apple Events to apps other than the ones probed) can still reach other apps; task_for_pid on hardened targets was
// not tested; the keychain's daemon is reached by a mach service. A server that needs another unix socket, a denied folder, a
// terminal, or to signal its process group or a grandchild stops working: it belongs under restricted = false.

import { resolve } from 'path'
import type { LoadEnv } from './types.js'
import type { PrivateRoot } from './restricted-workdir.js'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
/** The one local socket a server needs: name lookup. */
const RESOLVER_SOCKET = '/private/var/run/mDNSResponder'

/**
 * The macOS major versions on which the profile above is PROVEN: the one list, and nothing else decides it. A version belongs here
 * only once the whole of config/__tests__/server-sandbox.test.ts (the tests that run without an opt-in environment variable) was run
 * on a Mac of that version, by hand, and passed. CI runs `ubuntu-latest`, where the real-sandbox tests are skipped, so no CI run
 * proves any macOS version. Add a major by running that suite on it; never by reasoning that it ought to be the same.
 *
 * Compared by major version: Seatbelt and LaunchServices change between major releases (the way out through `open` is what the
 * suite probes), while a minor or patch release (15.0 to 15.7.9) is a security update within one. Only a major's first Mac to pass
 * is run by hand; its later releases are taken as the same sandbox.
 *
 * Proven: 15 (15.7.9: 62 passed, 0 failed, 3 skipped for opt-in environment variables).
 */
export const PROVEN_MACOS_MAJORS: readonly number[] = [15]

/**
 * Whether this is macOS on a version outside PROVEN_MACOS_MAJORS. A version that cannot be read (the empty string) counts as outside:
 * never proven by default. False when it is proven, or when this is not macOS (`macosVersion` undefined: a missing sandbox-exec is its
 * own refusal).
 */
export function unprovenMacos(macosVersion: string | undefined): boolean {
  if (macosVersion === undefined) return false
  return !PROVEN_MACOS_MAJORS.includes(Number(/^(\d+)(\.|$)/.exec(macosVersion)?.[1]))
}

/** The config key that lets a restricted specialist's servers run on a macOS version outside the list: `[restricted] allow_unproven_macos = true`. */
export const ALLOW_UNPROVEN_MACOS = 'allow_unproven_macos'

/**
 * Why a restricted specialist that lists servers is refused (or, with the opt-in, only warned about) on this macOS version, with the
 * ways out; undefined when the version is proven or this is not macOS. The one text: the load warning, `hydra config check`, the
 * daemon's log and the launch refusal in the thread all say it.
 */
export function macosGateIssue(macosVersion: string | undefined, allowed: boolean): string | undefined {
  if (!unprovenMacos(macosVersion)) return undefined
  const proven = PROVEN_MACOS_MAJORS.map(m => `macOS ${m}`).join(', ')
  const where = `this Mac runs ${macosVersion ? `macOS ${macosVersion}` : 'a macOS version hydra could not read'}, and the sandbox a listed [mcp_servers.*] server runs under (the way out through LaunchServices, \`open\`, above all) was proven only on ${proven}`
  return allowed
    ? `${where}; ${ALLOW_UNPROVEN_MACOS} = true under [restricted] lets it run anyway, so a server may be able to leave its sandbox. Remove the opt-in to refuse such launches`
    : `${where}, so a session that lists servers is refused at launch. Set ${ALLOW_UNPROVEN_MACOS} = true under [restricted] to run it anyway, set restricted = false, or run hydra on ${proven}`
}

/**
 * Why a listed server cannot be run here, with the three ways out; undefined when it can: `sandbox-exec` is missing (`isCommand` is the
 * machine's probe, LoadEnv), or a place the profile must name has a character it cannot hold. One predicate, asked at load and again
 * where the profile is built. Both run in the daemon; the only other machine is `hydra config check`.
 */
export function sandboxIssues(isCommand: (command: string) => boolean, roots: readonly { path: string }[]): string | undefined {
  if (!isCommand(SANDBOX_EXEC)) {
    return `a listed [mcp_servers.*] server runs under ${SANDBOX_EXEC} (macOS only), which blocks its connects to the daemon's socket and its reads of the listed credential folders. This machine does not have it. Remove the servers from the specialist's mcp_servers, set restricted = false, or run hydra on a Mac`
  }
  return roots.map(r => unquotablePath(r.path)).find(Boolean)
}

/**
 * Why a path cannot go in the profile, or undefined when it can. A path is written as a double-quoted string, inside which only
 * `"` and `\` are special: both are escaped, so a quote, a parenthesis or a space cannot end the string or add a rule (the real
 * sandbox test proves it with folders named that way). A control character (a newline, a NUL) is refused instead of escaped: it
 * is not a character a folder name needs, and how a profile reads one is not worth relying on.
 */
export function unquotablePath(path: string): string | undefined {
  return /[\u0000-\u001f\u007f]/.test(path) ? `${JSON.stringify(path)} has a control character in it (a newline, tab or NUL), which cannot go in the sandbox profile: remove it from the path` : undefined
}

function literal(path: string): string {
  const why = unquotablePath(path)
  if (why) throw new Error(why)
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The only devices a server may write besides its own temp folder: the null device and what dtrace-aware runtimes open at start. */
const WRITABLE_DEVICES = ['/dev/null', '/dev/dtracehelper']

/** Where a server may write: its own folder, which sits under `root`, the folder all restricted servers' folders share. */
export type ServerFolders = { root: string; dir: string }

/**
 * The profile text for one server. `roots` (restricted-workdir.ts `offLimitRoots`) are denied for reading and writing, each by its path
 * and by its resolved path (Seatbelt matches the resolved one); `dir` is the one folder the server may write in, also by both, and
 * `root` is unreadable except for it. A later rule wins, so the allowances come after the denials they carve out.
 */
export function sandboxProfile(env: Pick<LoadEnv, 'realpath'>, roots: readonly PrivateRoot[], folders: ServerFolders): string {
  // An empty list would be a rule with nothing in it, which Seatbelt reads as a syntax error: never in production (offLimitRoots always has the home folders).
  if (roots.length === 0) throw new Error('the sandbox profile has no off-limits places to deny: the list of them is empty')
  const both = (paths: readonly string[]) => [...new Set(paths.flatMap(p => [resolve(p), env.realpath(resolve(p))]))]
  const subpaths = (paths: readonly string[]) => both(paths).map(p => `  (subpath ${literal(p)})`).join('\n')
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write*\n${subpaths([folders.dir])}\n${WRITABLE_DEVICES.map(d => `  (literal ${literal(d)})`).join('\n')})`,
    `(deny file-read-data\n${subpaths([folders.root])})`,
    `(allow file-read-data\n${subpaths([folders.dir])})`,
    '(deny network-outbound (remote unix-socket))',
    `(allow network-outbound (remote unix-socket (path-literal ${literal(RESOLVER_SOCKET)})))`,
    `(deny file-read* file-write*\n${subpaths(roots.map(r => r.path))})`,
    '(deny process-info*)',
    '(allow process-info* (target self))',
    '(allow process-info* (target children))',
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
    '(deny signal)',
    '(allow signal (target self))',
    '(allow signal (target children))',
    '(deny mach-lookup (global-name-prefix "com.apple.coreservices."))',
    '(deny mach-lookup (global-name-prefix "com.apple.cfprefsd."))',
    '(deny mach-lookup (global-name "com.apple.sysmond"))',
    '(deny mach-lookup (global-name-prefix "com.apple.pasteboard."))',
    '(deny file-ioctl (regex #"^/dev/(tty|ttys[0-9]+)$"))',
    '',
  ].join('\n')
}

/** `command` run under the profile: what goes in the MCP config in its place. The profile is inline, so there is no file to keep or remove. */
export function sandboxedServer(command: string, env: Pick<LoadEnv, 'realpath'>, roots: readonly PrivateRoot[], folders: ServerFolders): { command: string; args: string[] } {
  return { command: SANDBOX_EXEC, args: ['-p', sandboxProfile(env, roots, folders), command] }
}
