import { existsSync, statSync, lstatSync, unlinkSync, readFileSync, symlinkSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { homedir, tmpdir } from 'os'
import { execSync, execFileSync } from 'child_process'

import type { HydraConfig } from './helpers.js'
import {
  resolveConfig, tmuxExists, tmuxKill, tmuxSpawn, tmuxSessionAge,
  compileCheck, killOrphanBytes, hasOrphanBytes, appendLog, shq,
  waitForSocket, buildDaemonEnvs, pluginVersionDir, probeDaemonHealth,
} from './helpers.js'
import { isKnownModel } from '../shared/constants.js'

// ---------------------------------------------------------------------------
// Start byte (replaces start-byte.sh)
// ---------------------------------------------------------------------------

export async function startByte(cfg: HydraConfig): Promise<void> {
  if (!existsSync(cfg.sockPath) || !statSync(cfg.sockPath).isSocket()) {
    console.error(`error: daemon socket not found at ${cfg.sockPath}`)
    console.error(`Start the daemon first: hydra up ${cfg.platform}`)
    process.exit(1)
  }

  tmuxKill(cfg.byteTmux)
  killOrphanBytes(cfg.sockPath, cfg.byteLog)
  await Bun.sleep(2000)
  killOrphanBytes(cfg.sockPath, cfg.byteLog, '-9')

  // Symlink bridge.ts into plugin cache
  const bridgeSrc = join(cfg.hydraDir, 'bridge.ts')
  if (!existsSync(bridgeSrc)) {
    console.error(`error: bridge.ts missing at ${bridgeSrc}`)
    process.exit(1)
  }
  const pluginDir = pluginVersionDir(cfg.configDir)
  if (!pluginDir) {
    console.error(`error: discord bridge plugin not found under ${cfg.configDir}`)
    console.error(`Install it: claude plugin install discord@claude-plugins-official`)
    process.exit(1)
  }
  const bridgeDest = join(pluginDir, 'server.ts')
  try { unlinkSync(bridgeDest) } catch {}
  symlinkSync(bridgeSrc, bridgeDest)
  appendLog(cfg.byteLog, 'symlinked bridge.ts into plugin cache')

  // Build prompt
  let prompt: string
  if (cfg.byteChannel) {
    prompt = `You just restarted with a fresh context. You're running on ${cfg.platform} via the bridge. Read your memory files, then send a brief greeting to chat ${cfg.byteChannel} using reply(chat_id=${cfg.byteChannel}).`
  } else {
    prompt = `You just restarted with a fresh context. You're running on ${cfg.platform} via the bridge. Read your memory files to orient, then wait silently for incoming messages — do NOT post anything proactively. When a message arrives, reply with the reply tool using the chat_id from the incoming message.`
  }

  // Auth token setup
  let authExport = ''
  const tokenFile = join(cfg.stateDir, '.byte-token')
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (oauthToken) {
    writeFileSync(tokenFile, oauthToken, { mode: 0o600 })
    authExport = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shq(tokenFile)})"`
  } else {
    const angellistToken = join(homedir(), '.angellist-claude-token')
    if (cfg.platform === 'slack' && existsSync(angellistToken)) {
      authExport = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shq(angellistToken)})"`
    }
  }

  // HYDRA_AUTH=keychain: copy the macOS keychain credential into the config dir so a
  // detached tmux byte that can't read the keychain still authenticates. Opt-in —
  // default 'auto' preserves today's behavior (token env, else claude's native keychain read).
  if (cfg.byteAuth === 'keychain' && !oauthToken && process.platform === 'darwin') {
    const credFile = join(cfg.configDir, '.credentials.json')
    if (!existsSync(credFile)) {
      try {
        const cred = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
        if (cred) {
          JSON.parse(cred)
          writeFileSync(credFile, cred, { mode: 0o600 })
          appendLog(cfg.byteLog, 'HYDRA_AUTH=keychain: copied keychain credential into config dir')
        }
      } catch (err) {
        appendLog(cfg.byteLog, `HYDRA_AUTH=keychain: keychain copy failed (non-fatal): ${err}`)
      }
    }
  }

  if (!isKnownModel(cfg.byteModel)) {
    console.warn(`\u26a0\ufe0f  Unrecognized model "${cfg.byteModel}" \u2014 may be a new release or typo. Starting anyway.`)
  }
  const inner = [
    `cd ${shq(cfg.byteCwd)}`,
    `export DAEMON_SOCK=${shq(cfg.sockPath)}`,
    `export CLAUDE_CONFIG_DIR=${shq(cfg.configDir)}`,
    `export CHAT_PLATFORM=${cfg.platform}`,
    authExport || null,
    `caffeinate -i claude --model ${shq(cfg.byteModel)} --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions ${shq(prompt)}`,
  ].filter(Boolean).join(' && ')

  tmuxSpawn(cfg.byteTmux, inner)

  appendLog(cfg.byteLog, `${cfg.platform} byte started (daemon+bridge)`)
  console.log(`${cfg.platform} byte started. Attach with: tmux attach -t ${cfg.byteTmux}`)
}

// ---------------------------------------------------------------------------
// Transcription sidecar (voice dictation)
// ---------------------------------------------------------------------------

// Delegates to start-transcribe.sh --auto: quiet no-op unless the sidecar is
// set up (or explicitly enabled), idempotent when already running. Returns a
// message to surface, or null when there's nothing to report. Never throws —
// dictation must not block the daemon lifecycle.
function startTranscribeAuto(cfg: HydraConfig): string | null {
  try {
    const out = execFileSync(join(cfg.hydraDir, 'start-transcribe.sh'), ['--auto'], {
      encoding: 'utf-8', stdio: 'pipe', timeout: 15_000,
      env: { ...process.env, HYDRA_STATE_DIR: cfg.stateDir, CHAT_PLATFORM: cfg.platform } as Record<string, string>,
    })
    return out.trim() || null
  } catch (err: unknown) {
    return `transcribe sidecar autostart failed: ${err instanceof Error ? err.message : err}`
  }
}

// ---------------------------------------------------------------------------
// up (replaces start-daemon.sh + start-byte.sh)
// ---------------------------------------------------------------------------

export async function lifecycleUp(platform: string): Promise<void> {
  const cfg = resolveConfig(platform)

  const aliveSessions = [cfg.daemonTmux, cfg.byteTmux].filter(tmuxExists)
  if (aliveSessions.length > 0) {
    console.error(`error: ${platform} is already running (${aliveSessions.join(', ')})`)
    console.error(`use 'hydra restart ${platform}' to restart the daemon, or 'hydra down ${platform}' first`)
    process.exit(1)
  }

  if (hasOrphanBytes(cfg.sockPath)) {
    console.error(`error: orphaned claude processes found for ${platform}`)
    console.error(`run 'hydra down ${platform}' first to clean them up`)
    process.exit(1)
  }

  console.log('compile check...')
  const check = await compileCheck(cfg.hydraDir)
  if (!check.ok) {
    console.error('compile check FAILED — refusing to start:')
    console.error(check.errors)
    appendLog(cfg.daemonLog, 'COMPILE FAILED — refusing to start daemon')
    process.exit(1)
  }

  try { unlinkSync(cfg.sockPath) } catch {}

  console.log(`starting ${platform} daemon...`)
  tmuxSpawn(cfg.daemonTmux,
    `cd ${shq(cfg.hydraDir)} && ${buildDaemonEnvs(cfg)} bun run daemon.ts 2>&1 | tee -a ${cfg.daemonLog}`)
  appendLog(cfg.daemonLog, `Daemon started in tmux session '${cfg.daemonTmux}' (SPAWN_CWD=${cfg.spawnCwd})`)

  const transcribeMsg = startTranscribeAuto(cfg)
  if (transcribeMsg) console.log(transcribeMsg)

  if (!await waitForSocket(cfg.sockPath, cfg.socketTimeout)) {
    console.error(`error: ${platform} daemon socket did not appear`)
    process.exit(1)
  }

  console.log(`starting ${platform} byte...`)
  await startByte(cfg)

  // Reload watchdog so it monitors the new daemon
  const plist = plistPath(platform)
  if (existsSync(plist)) {
    try { execSync(`launchctl load ${shq(plist)} 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    console.log(`loaded watchdog`)
  }

  console.log(`${platform} is up`)
}

// ---------------------------------------------------------------------------
// down (replaces stop-byte.sh + daemon kill)
// ---------------------------------------------------------------------------

export async function lifecycleDown(platform: string): Promise<void> {
  const cfg = resolveConfig(platform)

  console.log(`stopping ${platform}...`)

  // Unload watchdog first so it doesn't revive the daemon
  const plist = plistPath(platform)
  if (existsSync(plist)) {
    try { execSync(`launchctl unload ${shq(plist)} 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    console.log(`unloaded watchdog`)
  }

  tmuxKill(cfg.byteTmux)
  killOrphanBytes(cfg.sockPath, cfg.byteLog)
  await Bun.sleep(2000)
  killOrphanBytes(cfg.sockPath, cfg.byteLog, '-9')

  tmuxKill(cfg.daemonTmux)
  const otherDaemonAlive = ['slack', 'discord']
    .filter(p => p !== cfg.platform)
    .some(p => tmuxExists(`${p}-daemon`))
  if (!otherDaemonAlive) {
    tmuxKill(cfg.transcribeTmux)
  }

  for (const f of ['daemon.sock', 'daemon.pid']) {
    try { unlinkSync(join(cfg.stateDir, f)) } catch {}
  }

  // Clean up credential file copied by HYDRA_AUTH=keychain
  if (cfg.byteAuth === 'keychain') {
    const credFile = join(cfg.configDir, '.credentials.json')
    if (existsSync(credFile)) {
      try { unlinkSync(credFile) } catch {}
    }
  }

  console.log(`${platform} is down`)
}

// ---------------------------------------------------------------------------
// restart — fast by default, +v opts into module validation before kill
// ---------------------------------------------------------------------------

export async function lifecycleRestart(platform: string, opts?: { validate?: boolean }): Promise<void> {
  const cfg = resolveConfig(platform)
  const validate = opts?.validate ?? false

  appendLog(cfg.daemonLog, `Restart requested${validate ? ' (+v)' : ''}`)

  console.log('pre-flight compile check...')
  const check = await compileCheck(cfg.hydraDir)
  if (!check.ok) {
    console.error('compile check FAILED — old daemon left running.')
    console.error(check.errors)
    appendLog(cfg.daemonLog, 'Restart ABORTED — compile check failed (old daemon untouched)')
    process.exit(1)
  }

  if (validate) {
    console.log('module validation...')
    const probeResult = await validateModuleGraph(cfg)
    if (!probeResult.ok) {
      console.error('module validation FAILED — old daemon left running.')
      console.error(`  ${probeResult.error}`)
      appendLog(cfg.daemonLog, `Restart ABORTED — module validation failed: ${probeResult.error}`)
      process.exit(1)
    }
    console.log('module validation passed')
  }

  if (tmuxExists(cfg.daemonTmux)) {
    console.log('killing daemon...')
    tmuxKill(cfg.daemonTmux)
    await Bun.sleep(500)
  } else {
    console.log('no daemon running.')
  }

  try { unlinkSync(cfg.sockPath) } catch {}

  console.log('starting daemon...')
  tmuxSpawn(cfg.daemonTmux,
    `cd ${shq(cfg.hydraDir)} && ${buildDaemonEnvs(cfg)} bun run daemon.ts 2>&1 | tee -a ${cfg.daemonLog}`)

  if (!tmuxExists(cfg.daemonTmux)) {
    appendLog(cfg.daemonLog, 'CRITICAL: tmuxSpawn failed — no daemon process created')
    console.error('CRITICAL: tmuxSpawn failed — no daemon running')
    process.exit(1)
  }

  if (await waitForSocket(cfg.sockPath, cfg.socketTimeout)) {
    appendLog(cfg.daemonLog, `Daemon restarted successfully${validate ? ' (+v)' : ''}`)
    console.log(`${platform} daemon restarted`)
  } else {
    appendLog(cfg.daemonLog, 'Restart FAILED — socket timeout')
    console.error('TIMEOUT — socket did not appear after 15s')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Module graph validation — runs inside a tmux pane (same execution context
// as the real daemon) to catch broken imports, missing exports, and top-level
// evaluation errors that compile checks miss.
// ---------------------------------------------------------------------------

async function validateModuleGraph(cfg: HydraConfig): Promise<{ ok: boolean; error?: string }> {
  const scratchDir = join(tmpdir(), `hydra-probe-${process.pid}`)
  const scratchSock = join(scratchDir, 'probe.sock')
  const probeTmux = `${cfg.platform}-module-probe-${process.pid}`
  mkdirSync(scratchDir, { recursive: true })
  try { unlinkSync(scratchSock) } catch {}
  tmuxKill(probeTmux)

  const probeScript = join(cfg.hydraDir, 'daemon', 'boot-probe.ts')
  try {
    tmuxSpawn(probeTmux,
      `cd ${shq(cfg.hydraDir)} && ${buildDaemonEnvs(cfg)} HYDRA_PROBE_SOCK=${shq(scratchSock)} bun run ${shq(probeScript)}`)

    const socketReady = await waitForSocket(scratchSock, cfg.socketTimeout, true)
    if (!socketReady) {
      let paneOutput = ''
      try {
        paneOutput = execFileSync('tmux', ['capture-pane', '-t', probeTmux, '-p'],
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
      } catch {}
      const lastLine = paneOutput.split('\n').filter(l => l.trim()).pop() ?? 'probe failed to start'
      return { ok: false, error: lastLine }
    }

    const health = await probeDaemonHealth(scratchSock, cfg.socketTimeout)
    if (!health.ok) {
      return { ok: false, error: `modules loaded but health check failed: ${health.error}` }
    }

    return { ok: true }
  } finally {
    tmuxKill(probeTmux)
    try { unlinkSync(scratchSock) } catch {}
    try { rmSync(scratchDir, { recursive: true }) } catch {}
  }
}

// ---------------------------------------------------------------------------
// watchdog (replaces watchdog.sh)
// ---------------------------------------------------------------------------

export async function lifecycleWatchdog(platform: string): Promise<void> {
  const cfg = resolveConfig(platform)
  const staleSeconds = 300
  const now = Math.floor(Date.now() / 1000)

  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe', env: process.env as Record<string, string> })
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      appendLog(cfg.watchdogLog, `ERROR: tmux not found in PATH (${process.env.PATH})`)
      process.exit(1)
    }
  }

  let daemonRestartedThisTick = false

  if (!tmuxExists(cfg.daemonTmux)) {
    appendLog(cfg.watchdogLog, 'Daemon tmux session missing, starting')
    await restartDaemonForWatchdog(cfg)
    daemonRestartedThisTick = true
  }

  if (!daemonRestartedThisTick) {
    const heartbeat = join(cfg.stateDir, 'daemon.alive')
    if (!existsSync(heartbeat)) {
      const age = tmuxSessionAge(cfg.daemonTmux)
      if (age !== null && age > staleSeconds) {
        appendLog(cfg.watchdogLog, `No heartbeat after ${age}s, restarting daemon`)
        await restartDaemonForWatchdog(cfg)
        daemonRestartedThisTick = true
      }
    } else {
      const mtime = Math.floor(statSync(heartbeat).mtimeMs / 1000)
      const elapsed = now - mtime

      if (elapsed > staleSeconds) {
        const healthUrl = platform === 'slack'
          ? 'https://slack.com/api/api.test'
          : 'https://discord.com/api/v10/gateway'
        let networkUp = true
        try {
          execFileSync('curl', ['-sS', '--max-time', '5', healthUrl], { stdio: 'pipe', env: process.env as Record<string, string> })
        } catch {
          networkUp = false
        }
        if (networkUp) {
          appendLog(cfg.watchdogLog, `Heartbeat stale (${elapsed}s > ${staleSeconds}s), restarting daemon`)
          await restartDaemonForWatchdog(cfg)
          daemonRestartedThisTick = true
        }
      }
    }
  }

  // Skip byte revival if daemon was just restarted — socket won't be ready yet.
  // Next watchdog tick (120s) will revive the byte once daemon is up.
  if (!daemonRestartedThisTick && !tmuxExists(cfg.byteTmux) && tmuxExists(cfg.daemonTmux)) {
    appendLog(cfg.watchdogLog, `Bot session '${cfg.byteTmux}' missing (daemon alive), reviving`)
    await startByte(cfg)
  }

  if (!tmuxExists(cfg.transcribeTmux)) {
    const transcribeMsg = startTranscribeAuto(cfg)
    if (transcribeMsg) appendLog(cfg.watchdogLog, transcribeMsg)
  }
}

async function restartDaemonForWatchdog(cfg: HydraConfig): Promise<void> {
  const check = await compileCheck(cfg.hydraDir)
  if (!check.ok) {
    appendLog(cfg.watchdogLog, 'COMPILE FAILED — refusing to restart daemon')
    return
  }

  tmuxKill(cfg.daemonTmux)
  try { unlinkSync(cfg.sockPath) } catch {}
  tmuxSpawn(cfg.daemonTmux,
    `cd ${shq(cfg.hydraDir)} && ${buildDaemonEnvs(cfg)} bun run daemon.ts 2>&1 | tee -a ${cfg.daemonLog}`)
}

// ---------------------------------------------------------------------------
// preflight (replaces preflight.sh)
// ---------------------------------------------------------------------------

export async function lifecyclePreflight(platform: string): Promise<void> {
  const cfg = resolveConfig(platform)
  let fail = false
  let warn = false

  const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
  const bad = (msg: string) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); fail = true }
  const wrn = (msg: string) => { console.log(`  \x1b[33m⚠\x1b[0m ${msg}`); warn = true }

  console.log(`hydra preflight — platform=${platform}`)
  console.log(`  state dir : ${cfg.stateDir}`)
  console.log(`  config dir: ${cfg.configDir}`)
  console.log()

  const toolChecks: [string, string[]][] = [['bun', ['--version']], ['tmux', ['-V']], ['claude', ['--version']]]
  for (const [cmd, args] of toolChecks) {
    try {
      execFileSync(cmd, args, { stdio: 'pipe', env: process.env as Record<string, string> })
      ok(`${cmd} on PATH`)
    } catch {
      bad(`${cmd} not found on PATH`)
    }
  }

  try {
    execFileSync('freeze', ['--version'], { stdio: 'pipe', env: process.env as Record<string, string> })
    ok('freeze on PATH (pane screenshots)')
  } catch {
    wrn('freeze not installed — reply guard escalation will fall back to text. Install: brew install charmbracelet/tap/freeze')
  }

  const check = await compileCheck(cfg.hydraDir)
  if (check.ok) {
    ok('daemon + bridge compile')
  } else {
    bad('compile FAILED — daemon would crash-loop on boot:')
    console.log(check.errors.split('\n').map(l => `      ${l}`).join('\n'))
  }

  const envFile = join(cfg.stateDir, '.env')
  if (existsSync(envFile)) {
    ok('.env present')
    const envContent = readFileSync(envFile, 'utf-8')
    if (platform === 'slack') {
      if (/^SLACK_BOT_TOKEN=xoxb-/m.test(envContent)) ok('SLACK_BOT_TOKEN set (xoxb-)'); else bad('SLACK_BOT_TOKEN missing or not xoxb- in .env')
      if (/^SLACK_APP_TOKEN=xapp-/m.test(envContent)) ok('SLACK_APP_TOKEN set (xapp-)'); else bad('SLACK_APP_TOKEN missing or not xapp- in .env')
    } else {
      if (/^DISCORD_BOT_TOKEN=.+/m.test(envContent)) ok('DISCORD_BOT_TOKEN set'); else bad('DISCORD_BOT_TOKEN missing in .env')
    }
  } else {
    bad(`.env missing at ${envFile} (see .env.example)`)
  }

  if (existsSync(join(cfg.stateDir, 'access.json'))) {
    ok('access.json present')
  } else {
    wrn(`access.json missing — no users are allowlisted yet (${join(cfg.stateDir, 'access.json')})`)
  }

  const bridgeDir = join(cfg.configDir, 'plugins', 'cache', 'claude-plugins-official', 'discord')
  try {
    const versions = readdirSync(bridgeDir)
    const hasServer = versions.some(v => existsSync(join(bridgeDir, v, 'server.ts')))
    if (hasServer) ok('bridge plugin present in config dir'); else bad(`bridge plugin NOT in ${cfg.configDir}`)
  } catch {
    bad(`bridge plugin NOT in ${cfg.configDir} — sessions can't reach the daemon. Install: claude plugin install discord@claude-plugins-official`)
  }

  const managedSettings = '/Library/Application Support/ClaudeCode/managed-settings.json'
  if (existsSync(managedSettings)) {
    const content = readFileSync(managedSettings, 'utf-8')
    if (content.includes('"channelsEnabled"') && content.includes('true')) {
      ok('channelsEnabled=true (managed settings)')
    } else {
      wrn(`channelsEnabled not true in managed settings — on Team/Enterprise plans inbound is SILENTLY dropped. Fix: sudo write {"channelsEnabled": true} to ${managedSettings}`)
    }
  }

  // The byte runs `claude` with CLAUDE_CONFIG_DIR=<configDir>, so it reads
  // <configDir>/.claude.json. Un-onboarded flags there hang a detached tmux byte
  // on the theme/trust/bypass first-run screens.
  const byteConfigJson = join(cfg.configDir, '.claude.json')
  try {
    const cj = JSON.parse(readFileSync(byteConfigJson, 'utf-8'))
    if (cj.hasCompletedOnboarding && cj.bypassPermissionsModeAccepted) {
      ok('byte config dir onboarded (no first-run hang)')
    } else {
      wrn(`byte config dir not fully onboarded (${byteConfigJson}) — a detached byte will hang. Set hasCompletedOnboarding + bypassPermissionsModeAccepted, or complete once via tmux attach`)
    }
  } catch {
    wrn(`byte config state missing (${byteConfigJson}) — first byte start will hit interactive onboarding`)
  }

  const credFile = join(cfg.configDir, '.credentials.json')
  let authOk = !!process.env.CLAUDE_CODE_OAUTH_TOKEN || existsSync(credFile)
  if (!authOk && process.platform === 'darwin') {
    try {
      execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'pipe', env: process.env as Record<string, string> })
      authOk = true
    } catch {}
  }
  if (authOk) ok('byte auth resolvable (token / keychain / credentials file)')
  else wrn('no resolvable byte auth — set CLAUDE_CODE_OAUTH_TOKEN, or log in once via tmux attach (persists to keychain)')

  console.log()
  if (fail) {
    console.log('RESULT: NOT READY — fix the ✗ items above.')
    process.exit(1)
  } else if (warn) {
    console.log('RESULT: ready, with warnings (⚠) — review above.')
  } else {
    console.log('RESULT: all checks passed.')
  }
}

// ---------------------------------------------------------------------------
// install (generates + loads launchd plist)
// ---------------------------------------------------------------------------

function plistLabel(platform: string): string {
  return `com.hydra.watchdog.${platform}`
}

function plistPath(platform: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${plistLabel(platform)}.plist`)
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildPlist(platform: string, opts: { stateDir: string; spawnCwd: string; configDir: string }): string {
  const bunPath = execFileSync('which', ['bun'], { encoding: 'utf-8', env: process.env as Record<string, string> }).trim()
  const hydraTs = join(import.meta.dir, 'hydra.ts')
  const logFile = platform === 'slack'
    ? join(homedir(), 'hydra-watchdog-slack.log')
    : join(homedir(), 'hydra-watchdog.log')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXmlText(plistLabel(platform))}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXmlText(bunPath)}</string>
        <string>${escapeXmlText(hydraTs)}</string>
        <string>watchdog</string>
        <string>${escapeXmlText(platform)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${escapeXmlText(homedir())}</string>
        <key>PATH</key>
        <string>${escapeXmlText(process.env.PATH ?? '')}</string>
        <key>CHAT_PLATFORM</key>
        <string>${escapeXmlText(platform)}</string>
        <key>HYDRA_STATE_DIR</key>
        <string>${escapeXmlText(opts.stateDir)}</string>
        <key>SPAWN_CWD</key>
        <string>${escapeXmlText(opts.spawnCwd)}</string>
        <key>CLAUDE_CONFIG_DIR</key>
        <string>${escapeXmlText(opts.configDir)}</string>
    </dict>
    <key>StartInterval</key>
    <integer>120</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXmlText(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXmlText(logFile)}</string>
</dict>
</plist>
`
}

function installCLILink(hydraDir: string): void {
  const binDir = join(homedir(), '.local', 'bin')
  const linkPath = join(binDir, 'hydra')
  const cliEntry = join(hydraDir, 'cli', 'hydra.ts')

  const wrapper = `#!/bin/sh\nexec bun ${shq(cliEntry)} "$@"\n`

  try {
    if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true })

    // Earlier installs made linkPath a symlink to cli/hydra.ts. readFileSync and
    // writeFileSync both follow symlinks, so upgrading to the wrapper without
    // unlinking first overwrites the CLI source with a script that execs itself.
    // lstat, not stat: stat resolves the link and reports the target's type.
    if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) {
      unlinkSync(linkPath)
      console.log(`removed legacy hydra symlink at ${linkPath}`)
    }

    const existing = existsSync(linkPath) ? readFileSync(linkPath, 'utf-8') : ''
    if (existing !== wrapper) {
      writeFileSync(linkPath, wrapper, { mode: 0o755 })
      console.log(`installed hydra CLI → ${linkPath}`)
    } else {
      console.log(`hydra CLI already at ${linkPath}`)
    }
  } catch (err) {
    console.log(`⚠ failed to install hydra CLI: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  // Auto-add ~/.local/bin to PATH via shell profile if needed
  const path = process.env.PATH ?? ''
  if (!path.includes(binDir)) {
    const rcFile = join(homedir(), '.zshrc')
    const exportLine = `export PATH="$HOME/.local/bin:$PATH"`
    try {
      const rc = existsSync(rcFile) ? readFileSync(rcFile, 'utf-8') : ''
      if (!rc.includes('.local/bin')) {
        writeFileSync(rcFile, rc + `\n# Added by hydra install\n${exportLine}\n`)
        console.log(`added ${binDir} to PATH in ~/.zshrc`)
        console.log(`  run: source ~/.zshrc  (or open a new terminal)`)
      }
    } catch {}
  }
}

export type InstallOpts = { cwd?: string; configDir?: string }

export async function lifecycleInstall(platform: string, opts?: InstallOpts): Promise<void> {
  if (opts?.cwd) process.env.SPAWN_CWD = opts.cwd
  if (opts?.configDir) process.env.CLAUDE_CONFIG_DIR = opts.configDir
  const cfg = resolveConfig(platform)
  const dest = plistPath(platform)
  const label = plistLabel(platform)

  // Ensure LaunchAgents dir exists
  const laDir = dirname(dest)
  if (!existsSync(laDir)) mkdirSync(laDir, { recursive: true })

  // Ensure state dir exists
  if (!existsSync(cfg.stateDir)) mkdirSync(cfg.stateDir, { recursive: true })

  // Unload existing if present
  if (existsSync(dest)) {
    try { execSync(`launchctl unload ${shq(dest)} 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    console.log(`unloaded existing ${label}`)
  }

  // Check for .env
  const envFile = join(cfg.stateDir, '.env')
  if (!existsSync(envFile)) {
    console.log()
    console.log(`  ⚠ No .env found at ${envFile}`)
    if (platform === 'slack') {
      console.log(`  Create it with SLACK_BOT_TOKEN and SLACK_APP_TOKEN`)
    } else {
      console.log(`  Create it with DISCORD_BOT_TOKEN`)
    }
    console.log()
  }

  // Generate and write plist
  const content = buildPlist(platform, {
    stateDir: cfg.stateDir,
    spawnCwd: cfg.spawnCwd,
    configDir: cfg.configDir,
  })
  writeFileSync(dest, content)
  console.log(`wrote ${dest}`)

  // Load
  execSync(`launchctl load ${shq(dest)}`, { stdio: 'inherit' })
  console.log(`loaded ${label}`)

  // Install `hydra` CLI to PATH
  installCLILink(cfg.hydraDir)

  // Run preflight
  console.log()
  await lifecyclePreflight(platform)

  console.log()
  console.log(`${platform} watchdog installed. It will run every 120s.`)
  console.log(`Start hydra with: hydra up ${platform}`)
}

export function lifecycleUninstall(platform: string): void {
  const dest = plistPath(platform)
  const label = plistLabel(platform)

  if (!existsSync(dest)) {
    console.log(`${label} not installed`)
    return
  }

  try { execSync(`launchctl unload ${shq(dest)} 2>/dev/null`, { stdio: 'pipe' }) } catch {}
  unlinkSync(dest)
  console.log(`unloaded and removed ${dest}`)
}
