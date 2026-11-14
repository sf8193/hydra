// The sandbox a listed `[mcp.*]` server of an `access = "workdir"` specialist runs under. A macOS implementation (Seatbelt, through
// `/usr/bin/sandbox-exec`); where it is missing, a specialist that lists servers is refused, never run without it.
//
// BEST-EFFORT HYGIENE, NOT CONTAINMENT. A listed server is code the operator trusts with their own privileges (SERVER_TRUST_SENTENCE in
// daemon/scope.ts); the per-server `tools` list is the control. This profile is a layer proven by probes on one macOS version, written
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
//   - reads and writes of the places a scoped specialist must not know (workdir-scope.ts `offLimitRoots`, the one list; a floor, not a
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
// terminal, or to signal its process group or a grandchild stops working: it belongs under access = "operator".

import { resolve } from 'path'
import type { LoadEnv } from './types.js'
import type { PrivateRoot } from './workdir-scope.js'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
/** The one local socket a server needs: name lookup. */
const RESOLVER_SOCKET = '/private/var/run/mDNSResponder'

/**
 * Why a listed server cannot be run here, with the three ways out; undefined when it can: `sandbox-exec` is missing (`isCommand` is the
 * machine's probe, LoadEnv), or a place the profile must name has a character it cannot hold. One predicate, asked at load and again
 * where the profile is built. Both run in the daemon; the only other machine is `hydra config check`.
 */
export function sandboxIssues(isCommand: (command: string) => boolean, roots: readonly { path: string }[]): string | undefined {
  if (!isCommand(SANDBOX_EXEC)) {
    return `a listed [mcp.*] server runs under ${SANDBOX_EXEC} (macOS only), which blocks its connects to the daemon's socket and its reads of the listed credential folders. This machine does not have it. Remove the servers from the specialist's mcp, set access = "operator", or run hydra on a Mac`
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

/** Where a server may write: its own folder, which sits under `root`, the folder all scoped servers' folders share. */
export type ServerFolders = { root: string; dir: string }

/**
 * The profile text for one server. `roots` (workdir-scope.ts `offLimitRoots`) are denied for reading and writing, each by its path
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
