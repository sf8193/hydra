#!/usr/bin/env bun

import { randomUUID } from 'crypto'
import { join, resolve } from 'path'
import { resolveConfig, resolveSocket, sendRequest, printResponse } from './helpers.js'
import {
  lifecycleUp, lifecycleDown, lifecycleRestart,
  lifecycleWatchdog, lifecyclePreflight,
  lifecycleInstall, lifecycleUninstall,
  type InstallOpts,
} from './lifecycle.js'
import { peek } from './peek.js'
import { migrateCommand } from './migrate.js'
import { readBootRefusal } from './boot-refusal.js'
import { isPlatform, jobsAttempt, jobsLaunchdRun, jobsList, jobsMarkDone, jobsRun, jobsSync } from './jobs.js'
import { parseAttemptArgs } from '../shared/jobs.js'
import { MODEL_ALIASES, parseIdempotencyTtl } from '../shared/constants.js'

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/** A request that may spawn a session (creating a thread and a tmux session) outlasts the 10 s default. */
const SPAWNING_REQUEST_TIMEOUT_MS = 60_000

const USAGE = `hydra — manage hydra daemons and sessions

Setup:
  hydra install <platform>             Generate launchd watchdog + run preflight
    --cwd <path>                       Working directory for spawned sessions
    --config-dir <path>                Claude config dir (default: ~/.claude)
  hydra uninstall <platform>           Remove launchd watchdog

Jobs (recurring, from <state dir>/jobs.toml):
  hydra jobs list <platform>           Each job's runner, next run and last result (validates jobs.toml)
  hydra jobs sync <platform>           Register runner = "launchd" jobs with launchd and have the daemon load the file now
  hydra jobs run <platform> <name>     Run one job now, through the daemon; Ctrl-C cancels it
  hydra jobs mark-done <platform> <name>  Mark a daemon job's latest slot done without running it
  A job's runner is launchd unless it (or the file) says runner = "daemon"; delivery is always the daemon's.

Lifecycle:
  hydra up <platform>                  Start daemon + byte
  hydra down <platform>                Stop byte + daemon
  hydra restart <platform>             Restart with module validation (validates before kill)
  hydra restart <platform> --fast      Skip module validation (compile check only)
  hydra watchdog <platform>            Single watchdog tick (for launchd)
  hydra preflight <platform>           Verify deployment is ready

Session management:
  hydra spawn <prompt>                 Spawn a new session
  hydra spawn [options] -- <prompt>    Everything after -- is the prompt, even text starting with "-"
  hydra spawn --specialist <name>      Spawn the session for a declared specialist (its kickoff is the prompt; refuses if it is already filled)
  hydra list                           List active sessions
  hydra status <name>                  Session details
  hydra kill <name>                    Kill a session
  hydra peek [name]                    Read-only view of live sessions
  hydra attach <name>                  Attach to a running session's tmux surface
                                       <name>: a session's name or id, a specialist's name, or a thread id
  hydra health                         Daemon diagnostics
  hydra clear-key <key>                Clear a stuck idempotency key
  hydra check-key <key>                Check if an idempotency key exists

Deliver (whisper channel — message to session context, not thread):
  hydra deliver --to <specialist|main|thread id> --message "..." [--revive]
                                       resolves in order: main, a declared specialist, an all-digit thread id;
                                       anything else is exit 8 (no such specialist). A specialist always revives.
  hydra deliver --session <name> --message "..."
  hydra deliver --thread <id> --message "..."
  hydra deliver --specialist <name> --message "..."
    --session <name>                   Target session by name (primary)
    --thread <id>                      Target session by thread ID (alternative)
    --specialist <name>                      Target a specialist: its occupant, spawned from the specialist's kickoff if vacant (always queues)
    --message <text>                   Message to deliver (required)
    --initiator <who>                  Who sent this (default: $USER)
    --idempotency-key <key>            Prevent duplicate delivery (optional; remembered 15m)
    --idempotency-ttl <dur>            How long the key is remembered: 1m to 7d, e.g. 24h (default 15m)
    --queue                            Queue if bridge disconnected (default: fail)
    --revive                           With --to <thread id> or --thread: a dead session is revived in its thread first
                                       (resume, else fork, else a fresh one that reads the thread); the message queues for it.
  Exit codes: 2 already delivered with this key · 3 gone or refused · 4 running but unreachable · 5 not now (booting,
  busy, or stuck on a dialog) · 6 starting failed or backing off · 7 a delivery with this key is in flight · 8 no such specialist

Config:
  hydra migrate [<platform>] [--dry-run]   write <state>/hydra.toml once from access.json's allowFrom, specialists.json and slack-watch.json,
                                       keeping each file it changes or retires as *.migrated; --dry-run prints it and writes
                                       nothing. Stop the daemon first; an interrupted run is finished by running it again

Specialists (named addresses that refill themselves):
  hydra specialist set <name> [--channel <id>] [--thread <id>] [--kickoff <text> | --kickoff-file <path>] [--model <id>] [--idle <30m|4h|1d>]
                                       a new specialist needs --channel (its first session opens a thread there) or --thread;
                                       a name needs a letter (an all-digit one reads as a thread id);
                                       once hydra.toml declares specialists, recipes live there and set takes only --thread
  hydra specialist show <name> | list | rm <name>   (rm: without hydra.toml only)

Routing (hydra.toml):
  hydra route --as <person|address|stranger> --at <place> [--bound <specialist>]
                                       What a new message there would do: every candidate, and why the winner won
  hydra conversations [list]           Conversations, the specialist each is bound to, and health
  hydra conversations bind <conversation> <specialist>
                                       Bind or move a conversation (as list prints it: slack:C0ABC:1793732224.093059)
  hydra conversations unbind <conversation>

Platform: slack | discord (required for lifecycle commands)

Spawn options:
  --initiator <name>                   Who triggered this spawn (required)
  --idempotency-key <key>              Prevent duplicate spawns (required)
  --model <id|alias>                   Model ID or alias (see below)
  --channel <id>                       Target channel for the spawned thread
  --message <id>                       Create thread on this message (requires --channel)
  --read-thread [limit] [thread-id]    Read thread history first (default: 50 msgs from --channel, max 200)
  --quiet                              Suppress spawn announcement in chat
  --ephemeral                          Auto-kill on [done], skip death visuals
  --idle-ttl <dur>                     With --ephemeral: how long with no message in the thread before nudge-then-reap (default 30m, max 7d; e.g. 4d)
  --force-cleanup                      Remove worktree + branch on kill even with uncommitted/unpushed work (unpushed commits become unreachable)

Model aliases:
${Object.entries(MODEL_ALIASES).map(([k, v]) => `  ${k.padEnd(16)} → ${v}`).join('\n')}

Global options:
  --daemon <name>                      Target a specific daemon
  --state-dir <dir>                    Target the daemon (and jobs state) in this state dir: a worktree or test daemon
  --json                               Output raw JSON
  -h, --help                           Show this help
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  // `--` ends the options: what follows is data (a prompt that starts with "-", say), never a flag.
  const end = args.indexOf('--')
  const options = end < 0 ? args : args.slice(0, end)
  if (args.length === 0 || options.includes('-h') || options.includes('--help')) {
    console.log(USAGE)
    process.exit(0)
  }

  let daemonName: string | undefined
  let stateDirOpt: string | undefined   // a daemon's address by its state dir: <dir>/daemon.sock
  let json = false
  const filtered: string[] = []

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      filtered.push(...args.slice(i))
      break
    } else if (args[i] === '--daemon' && i + 1 < args.length) {
      daemonName = args[++i]
    } else if (args[i] === '--state-dir' && i + 1 < args.length) {
      stateDirOpt = args[++i]
    } else if (args[i] === '--json') {
      json = true
    } else {
      filtered.push(args[i])
    }
  }

  const command = filtered[0]

  if (daemonName && stateDirOpt) {
    console.error('error: --daemon and --state-dir both name a daemon; use one')
    process.exit(1)
  }

  if (command === 'jobs' && daemonName) {
    console.error('error: jobs commands take --state-dir <dir>, not --daemon (a job\'s state lives in the daemon\'s state dir)')
    process.exit(1)
  }

  if (command === 'jobs') {
    const [, sub, platform, name] = filtered
    if (sub === 'attempt') {
      // Started by the daemon's clock, detached; not for direct use.
      const o = parseAttemptArgs(args)
      if (!o) { console.error('usage: hydra --state-dir <dir> jobs attempt <platform> <name> --dispatch <id> --nonce <n> --slot <label> [--manual]'); process.exit(64) }
      try { await jobsAttempt(o) } catch (err) { console.error(`attempt error: ${err instanceof Error ? err.stack : err}`); process.exit(1) }
      process.exit(0)
    }
    if (sub === 'launchd-run') {
      // Run by a launchd-runner job's plist at each slot; not for direct use.
      if (!platform || !isPlatform(platform) || !name) { console.error('usage: hydra [--state-dir <dir>] jobs launchd-run <platform> <name>'); process.exit(64) }
      process.exit(await jobsLaunchdRun(platform, name, stateDirOpt ?? resolveConfig(platform).stateDir))
    }
    const named = sub === 'run' || sub === 'mark-done'
    if (!['list', 'sync', 'run', 'mark-done'].includes(sub) || !platform || !isPlatform(platform) || (named && (!name || name.startsWith('-')))) {
      console.error('usage: hydra [--state-dir <dir>] jobs list|sync <platform>   |   hydra [--state-dir <dir>] jobs run|mark-done <platform> <name>')
      process.exit(1)
    }
    try {
      if (sub === 'list') jobsList(platform, stateDirOpt)
      else if (sub === 'sync') process.exit(await jobsSync(platform, stateDirOpt))
      else if (sub === 'mark-done') process.exit(await jobsMarkDone(platform, name, stateDirOpt))
      else process.exit(await jobsRun(platform, name, stateDirOpt))
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }
    process.exit(0)
  }

  if (command === 'migrate') {
    if (daemonName) { console.error('error: migrate takes --state-dir <dir> or a platform, not --daemon'); process.exit(1) }
    const platform = filtered.slice(1).find(a => !a.startsWith('-'))
    process.exit(await migrateCommand({ platform, stateDir: stateDirOpt, dryRun: filtered.includes('--dry-run') }))
  }

  // Lifecycle commands
  if (['install', 'uninstall', 'up', 'down', 'restart', 'watchdog', 'preflight'].includes(command)) {
    const platform = filtered[1]
    if (!platform) {
      console.error('error: platform is required (e.g. discord, slack)')
      process.exit(1)
    }
    switch (command) {
      case 'install': {
        const installOpts: InstallOpts = {}
        for (let i = 2; i < filtered.length; i++) {
          if (filtered[i] === '--cwd' && i + 1 < filtered.length) {
            installOpts.cwd = filtered[++i]
          } else if (filtered[i] === '--config-dir' && i + 1 < filtered.length) {
            installOpts.configDir = filtered[++i]
          }
        }
        await lifecycleInstall(platform, installOpts)
        break
      }
      case 'uninstall': lifecycleUninstall(platform); break
      case 'up': await lifecycleUp(platform); break
      case 'down': await lifecycleDown(platform); break
      case 'restart': await lifecycleRestart(platform, { validate: !filtered.includes('--fast') }); break
      case 'watchdog': await lifecycleWatchdog(platform); break
      case 'preflight': await lifecyclePreflight(platform); break
    }
    process.exit(0)
  }

  // Lazy: resolved on first actual use, so a command's own argument validation runs first.
  let resolvedSocketPath: string | undefined
  const socketPath = () => resolvedSocketPath ??= stateDirOpt ? join(stateDirOpt, 'daemon.sock') : resolveSocket(daemonName)

  switch (command) {
    case 'spawn': {
      let idempotencyKey: string | undefined
      let initiator: string | undefined
      let channel: string | undefined
      let message: string | undefined
      let quiet = false
      let ephemeral = false
      let idleTtl: string | undefined
      let forceWorktreeCleanup = false
      let readThreadLimit = 0  // 0 = disabled
      let model: string | undefined
      let specialist: string | undefined
      const promptParts: string[] = []

      for (let i = 1; i < filtered.length; i++) {
        if (filtered[i] === '--') {
          promptParts.push(...filtered.slice(i + 1))
          break
        } else if (filtered[i] === '--idempotency-key' && i + 1 < filtered.length) {
          idempotencyKey = filtered[++i]
        } else if (filtered[i] === '--initiator' && i + 1 < filtered.length) {
          initiator = filtered[++i]
        } else if (filtered[i] === '--channel' && i + 1 < filtered.length) {
          channel = filtered[++i]
        } else if (filtered[i] === '--message' && i + 1 < filtered.length) {
          message = filtered[++i]
        } else if (filtered[i] === '--quiet') {
          quiet = true
        } else if (filtered[i] === '--ephemeral') {
          ephemeral = true
        } else if (filtered[i] === '--idle-ttl') {
          if (i + 1 >= filtered.length) {
            console.error('error: --idle-ttl needs a duration, e.g. 90m, 12h or 4d')
            process.exit(1)
          }
          idleTtl = filtered[++i]
        } else if (filtered[i] === '--force-cleanup') {
          forceWorktreeCleanup = true
        } else if (filtered[i] === '--read-thread') {
          readThreadLimit = 50  // default
          // peek at next arg — if it's a number, use it as the limit
          if (i + 1 < filtered.length && /^\d+$/.test(filtered[i + 1])) {
            readThreadLimit = Math.min(parseInt(filtered[++i], 10), 200)
          }
        } else if (filtered[i] === '--model' && i + 1 < filtered.length) {
          model = filtered[++i]
        } else if (filtered[i] === '--specialist') {
          if (i + 1 >= filtered.length) {
            console.error('error: --specialist needs a name')
            process.exit(1)
          }
          specialist = filtered[++i]
        } else if (filtered[i].startsWith('--')) {
          console.error(`error: unknown flag ${filtered[i]}`)
          process.exit(1)
        } else {
          promptParts.push(filtered[i])
        }
      }

      let prompt = promptParts.join(' ')
      if (specialist && (prompt || readThreadLimit > 0)) {
        console.error("error: --specialist uses the specialist's own kickoff as the prompt; drop the prompt and --read-thread")
        process.exit(1)
      }
      if (specialist) {
        const owned = Object.entries({ '--channel': channel, '--message': message, '--model': model, '--ephemeral': ephemeral || undefined, '--idle-ttl': idleTtl, '--force-cleanup': forceWorktreeCleanup || undefined })
          .filter(([, v]) => v !== undefined).map(([k]) => k)
        if (owned.length) {
          console.error(`error: --specialist takes its channel and model from the declaration; remove ${owned.join(', ')}`)
          process.exit(1)
        }
      }
      if (!prompt && !specialist) {
        console.error('error: prompt is required')
        process.exit(1)
      }
      if (!idempotencyKey) {
        console.error('error: --idempotency-key is required')
        process.exit(1)
      }
      if (!initiator) {
        console.error('error: --initiator is required')
        process.exit(1)
      }
      if (message && !channel) {
        console.error('error: --message requires --channel')
        process.exit(1)
      }
      if (readThreadLimit > 0 && !channel) {
        console.error('error: --read-thread requires --channel (the thread/channel to read)')
        process.exit(1)
      }
      if (readThreadLimit > 0 && channel) {
        prompt = `Read the recent history in this channel for context: fetch_messages(channel="${channel}", limit=${readThreadLimit}). Then continue with the task below.\n\n${prompt}`
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli',
        command: 'spawn',
        id: randomUUID(),
        params: { ...(specialist ? { specialist } : { prompt }), idempotencyKey, initiator, model, ...(channel && { channel }), ...(message && { message }), ...(quiet && { quiet }), ...(ephemeral && { ephemeral }), ...(idleTtl !== undefined && { idleTtl }), ...(forceWorktreeCleanup && { forceWorktreeCleanup }) },
      }, specialist ? SPAWNING_REQUEST_TIMEOUT_MS : undefined)
      printResponse(response, json)
      break
    }

    case 'list': {
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'list', id: randomUUID(), params: {},
      })
      printResponse(response, json)
      break
    }

    case 'status': {
      const name = filtered[1]
      if (!name) {
        console.error('error: session name required')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'status', id: randomUUID(), params: { name },
      })
      printResponse(response, json)
      break
    }

    case 'kill': {
      const name = filtered[1]
      if (!name) {
        console.error('error: session name required')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'kill', id: randomUUID(), params: { name },
      })
      printResponse(response, json)
      break
    }

    case 'health': {
      let response: Record<string, unknown>
      try {
        response = await sendRequest(socketPath(), { type: 'cli', command: 'health', id: randomUUID(), params: {} })
      } catch (err) {
        // A daemon that refused to start left its reason; it's the one thing worth saying here.
        const refused = stateDirOpt || !daemonName ? readBootRefusal(stateDirOpt ?? resolveConfig().stateDir) : undefined
        console.error(`error: daemon not reachable: ${err instanceof Error ? err.message : err}`)
        if (refused) console.error(`the daemon is ${refused}`)
        process.exit(1)
      }
      printResponse(response, json)
      break
    }

    case 'clear-key': {
      const key = filtered[1]
      if (!key) {
        console.error('error: idempotency key required')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'clear-key', id: randomUUID(), params: { key },
      })
      printResponse(response, json)
      break
    }

    case 'check-key': {
      const key = filtered[1]
      if (!key) {
        console.error('error: idempotency key required')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'check-key', id: randomUUID(), params: { key },
      })
      printResponse(response, json)
      break
    }

    case 'deliver': {
      let to: string | undefined
      let thread: string | undefined
      let session: string | undefined
      let specialist: string | undefined
      let message: string | undefined
      let initiator: string | undefined
      let idempotencyKey: string | undefined
      let idempotencyTtl: string | undefined
      let queue = false
      let revive = false

      for (let i = 1; i < filtered.length; i++) {
        if (filtered[i] === '--to' && i + 1 < filtered.length) {
          to = filtered[++i]
        } else if (filtered[i] === '--thread' && i + 1 < filtered.length) {
          thread = filtered[++i]
        } else if (filtered[i] === '--session' && i + 1 < filtered.length) {
          session = filtered[++i]
        } else if (filtered[i] === '--specialist' && i + 1 < filtered.length) {
          specialist = filtered[++i]
        } else if (filtered[i] === '--message' && i + 1 < filtered.length) {
          message = filtered[++i]
        } else if (filtered[i] === '--initiator' && i + 1 < filtered.length) {
          initiator = filtered[++i]
        } else if (filtered[i] === '--idempotency-key' && i + 1 < filtered.length) {
          idempotencyKey = filtered[++i]
        } else if (filtered[i] === '--idempotency-ttl') {
          idempotencyTtl = filtered[++i] ?? ''   // given with no value: refused below, never silently dropped
        } else if (filtered[i] === '--queue') {
          queue = true
        } else if (filtered[i] === '--revive') {
          revive = true
        }
      }

      if (!message) {
        console.error('error: --message is required')
        process.exit(1)
      }
      if (!to && !thread && !session && !specialist) {
        console.error('error: --to, --session, --thread or --specialist is required')
        process.exit(1)
      }
      if (idempotencyTtl !== undefined && (!idempotencyKey || parseIdempotencyTtl(idempotencyTtl) === null)) {
        console.error(idempotencyKey ? `error: --idempotency-ttl "${idempotencyTtl}" must be a duration like 90m, 12h or 2d, at most 7d` : 'error: --idempotency-ttl needs --idempotency-key')
        process.exit(1)
      }

      if (!initiator) initiator = process.env.USER ?? 'unknown'

      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'deliver', id: randomUUID(),
        params: {
          ...(to && { to }),
          ...(thread && { thread }),
          ...(session && { session }),
          ...(specialist && { specialist }),
          message,
          initiator,
          ...(idempotencyKey && { idempotencyKey }),
          ...(idempotencyTtl !== undefined && { idempotencyTtl }),
          ...(queue && { queue }),
          ...(revive && { revive }),
        },
      }, to || specialist || revive ? SPAWNING_REQUEST_TIMEOUT_MS : undefined)
      printResponse(response, json)
      break
    }

    case 'specialist': {
      const [action, name] = [filtered[1], filtered[2]]
      if (!['set', 'show', 'rm', 'list'].includes(action ?? '')) {
        console.error('error: usage: hydra specialist set|show|rm|list <name> [flags]')
        process.exit(1)
      }
      const flags: Record<string, string> = {}
      for (let i = 3; i < filtered.length; i++) {
        const f = filtered[i]
        if (!['--thread', '--channel', '--kickoff', '--kickoff-file', '--model', '--idle'].includes(f) || i + 1 >= filtered.length) {
          console.error(`error: unknown or incomplete flag ${f}`)
          process.exit(1)
        }
        flags[f.slice(2)] = filtered[++i]
      }
      // set and rm wait on the specialist's lock, which a refill in flight holds for as long as a spawn takes.
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'specialist', id: randomUUID(),
        params: {
          action, ...(name && { name }),
          ...(flags.thread && { thread: flags.thread }),
          ...(flags.channel && { channel: flags.channel }),
          ...(flags.kickoff && { kickoff: flags.kickoff }),
          // The daemon reads the file, so it must see a path that means the same there.
          ...(flags['kickoff-file'] && { kickoffFile: resolve(flags['kickoff-file']) }),
          ...(flags.model && { model: flags.model }),
          ...(flags.idle && { idle: flags.idle }),
        },
      }, action === 'set' || action === 'rm' ? SPAWNING_REQUEST_TIMEOUT_MS : undefined)
      printResponse(response, json)
      break
    }

    case 'conversations': {
      const [action = 'list', conversation, to] = [filtered[1], filtered[2], filtered[3]]
      if (!['list', 'bind', 'unbind'].includes(action) || (action === 'bind' && (!conversation || !to)) || (action === 'unbind' && !conversation)) {
        console.error('error: usage: hydra conversations [list] | bind <conversation> <specialist> | unbind <conversation>')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'conversations', id: randomUUID(),
        params: { action, ...(conversation && { conversation }), ...(to && { to }) },
      })
      printResponse(response, json)
      break
    }

    case 'route': {
      const flag = (name: string) => { const i = filtered.indexOf(name); return i > 0 ? filtered[i + 1] : undefined }
      const [as, at, bound] = [flag('--as'), flag('--at'), flag('--bound')]
      if (!as || !at) {
        console.error('error: usage: hydra route --as <person|address|stranger> --at <place> [--bound <specialist>]')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), { type: 'cli', command: 'route', id: randomUUID(), params: { as, at, ...(bound && { bound }) } })
      if (!json && response.ok) { console.log((response.data as { report: string }).report); break }
      printResponse(response, json)
      break
    }

    case 'peek': {
      await peek(filtered.slice(1), daemonName)
      break
    }

    case 'attach': {
      const name = filtered[1]
      if (!name) {
        console.error('error: session name required. Usage: hydra attach <name>')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'status', id: randomUUID(), params: { name, attach: true },
      })
      if (!response.ok) {
        console.error(`error: ${response.error}`)
        process.exit(typeof response.exitCode === 'number' ? response.exitCode : 1)
      }
      const target = (response.data as { attachTarget?: string | null } | undefined)?.attachTarget
      if (!target) {
        console.error(`error: session "${name}" has no attachable surface — is it still running?`)
        process.exit(1)
      }
      const { spawnSync } = await import('child_process')
      process.exit(spawnSync('tmux', ['attach', '-t', target], { stdio: 'inherit' }).status ?? 1)
    }

    default:
      console.error(`error: unknown command "${command}"`)
      console.error(USAGE)
      process.exit(1)
  }
}

main().catch(err => {
  console.error(`fatal: ${err.message}`)
  process.exit(1)
})
