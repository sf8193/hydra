#!/usr/bin/env bun

import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { resolveSocket, sendRequest, printResponse } from './helpers.js'
import {
  lifecycleUp, lifecycleDown, lifecycleRestart,
  lifecycleWatchdog, lifecyclePreflight,
  lifecycleInstall, lifecycleUninstall,
  type InstallOpts,
} from './lifecycle.js'
import { peek } from './peek.js'
import { isPlatform, jobsAttempt, jobsList, jobsRun, jobsSync, parseAttemptArgs } from './jobs.js'
import { MODEL_ALIASES } from '../shared/constants.js'

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
  hydra jobs list <platform>           The clock's last tick; each job's next run and last result
  hydra jobs sync <platform>           Validate jobs.toml; remove the old launchd entries (the daemon runs jobs)
  hydra jobs run <platform> <name>     Run one job now, through the daemon; Ctrl-C cancels it
    --state-dir <dir>                  Use this state dir instead of the platform's

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
    --idempotency-key <key>            Prevent duplicate delivery (optional, 15min TTL)
    --queue                            Queue if bridge disconnected (default: fail)
    --revive                           With --to <thread id> or --thread: a dead session is revived in its thread first
                                       (resume, else fork, else a fresh one that reads the thread); the message queues for it.
  Exit codes: 2 already delivered with this key · 3 gone or refused · 4 running but unreachable · 5 not now (booting,
  busy, or stuck on a dialog) · 6 starting failed or backing off · 7 a delivery with this key is in flight · 8 no such specialist

Specialists (named addresses that refill themselves):
  hydra specialist set <name> [--channel <id>] [--thread <id>] [--kickoff <text> | --kickoff-file <path>] [--model <id>] [--idle <30m|4h|1d>]
                                       a new specialist needs --channel (its first session opens a thread there) or --thread;
                                       a name needs a letter (an all-digit one reads as a thread id)
  hydra specialist show <name> | list | rm <name>

Slack watches (threads whose replies reach a specialist):
  hydra slack-watch list               Watched threads and health
  hydra slack-watch add <channel> <thread-ts>
  hydra slack-watch rm <channel> <thread-ts>

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
  let json = false
  const filtered: string[] = []

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      filtered.push(...args.slice(i))
      break
    } else if (args[i] === '--daemon' && i + 1 < args.length) {
      daemonName = args[++i]
    } else if (args[i] === '--json') {
      json = true
    } else {
      filtered.push(args[i])
    }
  }

  const command = filtered[0]

  if (command === 'jobs') {
    const [, sub, platform, name] = filtered
    if (sub === 'attempt') {
      // Started by the daemon's clock, detached; not for direct use.
      const o = parseAttemptArgs(filtered.slice(2))
      if (!o) { console.error('usage: hydra jobs attempt <platform> <name> --dispatch <id> --nonce <n> --slot <label> [--manual] --state-dir <dir>'); process.exit(64) }
      try { await jobsAttempt(o) } catch (err) { console.error(`attempt error: ${err instanceof Error ? err.stack : err}`); process.exit(1) }
      process.exit(0)
    }
    const sd = filtered.indexOf('--state-dir')
    const stateDir = sd >= 0 ? filtered[sd + 1] : undefined
    if (!['list', 'sync', 'run'].includes(sub) || !platform || !isPlatform(platform) || (sub === 'run' && (!name || name.startsWith('-'))) || (sd >= 0 && !stateDir)) {
      console.error('usage: hydra jobs list|sync <platform> [--state-dir <dir>]   |   hydra jobs run <platform> <name> [--state-dir <dir>]')
      process.exit(1)
    }
    try {
      if (sub === 'list') jobsList(platform, stateDir)
      else if (sub === 'sync') await jobsSync(platform, stateDir)
      else process.exit(await jobsRun(platform, name, stateDir))
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }
    process.exit(0)
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
  const socketPath = () => resolvedSocketPath ??= resolveSocket(daemonName)

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
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'health', id: randomUUID(), params: {},
      })
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

    case 'slack-watch': {
      const [action, channel, threadTs] = [filtered[1], filtered[2], filtered[3]]
      if (!['list', 'add', 'rm'].includes(action ?? '') || (action !== 'list' && (!channel || !threadTs))) {
        console.error('error: usage: hydra slack-watch list | add <channel> <thread-ts> | rm <channel> <thread-ts>')
        process.exit(1)
      }
      const response = await sendRequest(socketPath(), {
        type: 'cli', command: 'slack-watch', id: randomUUID(),
        params: { action, ...(channel && { channel }), ...(threadTs && { threadTs }) },
      })
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
