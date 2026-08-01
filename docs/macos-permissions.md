# macOS filesystem permissions and hydra

hydra spawns long-lived processes from a tmux server that may itself have been
started by launchd and may have been running for months. On macOS, filesystem
access for those processes is subject to two independent gates — TCC, and any
endpoint security agent installed on the machine. Both can produce `EPERM` on a
path the user can read perfectly well from their own shell.

The result is a failure mode that presents as almost anything except a
permission problem. This document is about recognising it quickly.

## The signature

Children of an affected tmux server fail like this:

```
$ bun run daemon.ts
error: An unknown error occurred, possibly due to low max file descriptors (Unexpected)
Current limit: 256

$ claude --version
error: An internal error occurred (EPERM)
```

**Do not trust the file-descriptor hint.** bun scans its working directory for
`package.json` / `node_modules` / `bunfig.toml` at startup; when that scan is
denied it reports the failure as a descriptor limit. Raising `ulimit -n` changes
nothing. `bun --version` succeeds because it never touches the working
directory, which makes the fault look intermittent.

Shell builtins keep working throughout, so the tmux session itself looks
healthy — `ls` from a pane fails while `echo` succeeds.

## Diagnosing it

Probe from **inside a pane of the suspect server**, never from your own shell —
your shell almost certainly holds a grant, so testing there proves nothing:

```bash
tmux new-session -d -s _probe 'ls <spawn-cwd> > /tmp/probe.txt 2>&1; sleep 30'
sleep 2 && cat /tmp/probe.txt && tmux kill-session -t _probe
```

`Operation not permitted` means access is being denied to that process tree.
Neither the code nor the descriptor limit is the problem.

To distinguish a *server-scoped* denial from a machine-wide one, start a second
tmux server on its own socket and repeat the probe:

```bash
tmux -L probe new-session -d -s p 'ls <spawn-cwd> > /tmp/probe2.txt 2>&1; sleep 30'
```

If the fresh server can read the path and the old one cannot, the denial is
scoped to the original server process — not to the binary, the user, or the
directory.

## Gate 1 — TCC

`~/Documents`, `~/Desktop`, and `~/Downloads` are gated by default. Everything
else, including `~/.claude` and `/tmp`, is not. Full Disk Access supersedes all
three.

TCC attributes access to the **responsible process** of the chain, fixed when
that process starts — so a tmux server inherits its verdict at creation and
keeps it for life. A server created by a launchd job has no responsible
application and may therefore inherit no grant, even when the tmux binary itself
is granted.

Inspect the tables:

```bash
# Per-folder grants
sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
  "select service, client, auth_value, datetime(last_modified,'unixepoch','localtime')
   from access where service like '%Documents%' order by last_modified desc;"

# Full Disk Access
sqlite3 /Library/Application\ Support/com.apple.TCC/TCC.db \
  "select client, auth_value, datetime(last_modified,'unixepoch','localtime')
   from access where service='kTCCServiceSystemPolicyAllFiles';"
```

`auth_value`: `2` allowed, `0` explicitly denied, absent means never asked.
Grants for command-line binaries are keyed by path *and* code signature, so an
upgrade that changes the binary invalidates the grant while leaving the row in
place and the System Settings toggle still reading "on".

Claude Code appears in System Settings as several rows all labelled `2.1` —
macOS shows the executable's filename, and each release installs to its own
versioned path. Every update needs its own grant.

## Gate 2 — endpoint security agents

EDR agents (SentinelOne, CrowdStrike, and similar) use Apple's Endpoint Security
framework and can deny filesystem access to a specific process tree. That denial
also arrives as `EPERM`, leaves no entry in the TCC tables, and produces no TCC
log record.

Suspect this when the TCC tables show a valid grant that is nevertheless not
being honoured, and when the denial is scoped to one process tree while an
identical fresh one works.

hydra's runtime shape resembles several persistence heuristics — a launchd
watchdog respawning daemons indefinitely, many long-lived shells under a single
tmux server, and a bridge that writes files into a plugin cache. Agents may
flag it.

**Do not attempt to suppress or evade the agent.** Take the affected pid and the
time window to whoever administers it and ask for an exclusion; the agent's own
console is the only place the mitigation record can be read.

## Recovering

TCC attribution is fixed at server creation and EDR mitigations are scoped to a
process tree, so in both cases recreating the tmux server is what clears the
condition:

```bash
hydra down <platform>
tmux kill-server                 # ends every session on that socket
hydra up <platform>              # from a terminal that holds a grant
```

Sessions do not survive this. Threads do, and threads are the continuity
substrate — capture an inventory first if you want to respawn selectively.

Avoid letting a watchdog be the first thing to create the server after a reboot;
a watchdog-created server has no responsible application.

## Related

- `shared/tmux-env.ts` — why every pane raises its descriptor limit, and how a
  low limit corrupts the diagnosis above
