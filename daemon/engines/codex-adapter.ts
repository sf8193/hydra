import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, unlinkSync, cpSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { SOCK_PATH, STATE_DIR } from '../config.js'
import { codexSocketPath, type CodexEngine } from '../codex-engine.js'
import { codexHomeDir, startCodexAppServer, stopCodexAppServer } from '../codex-process.js'
import type { EngineAdapter, EngineSpawnInput, EngineSpawnResult } from './engine-adapter.js'

const SPAWN_LOGS_DIR = join(STATE_DIR, 'spawn-logs')

export type CodexLaunchIo = {
  execFileSync: typeof execFileSync
  existsSync: typeof existsSync
  mkdirSync: typeof mkdirSync
  unlinkSync: typeof unlinkSync
  cpSync: typeof cpSync
  rmSync: typeof rmSync
  symlinkSync: typeof symlinkSync
  start: typeof startCodexAppServer
  stop: typeof stopCodexAppServer
  now: () => number
  wait: (ms: number) => Promise<void>
}

const nativeIo: CodexLaunchIo = {
  execFileSync, existsSync, mkdirSync, unlinkSync, cpSync, rmSync, symlinkSync,
  start: startCodexAppServer, stop: stopCodexAppServer,
  now: Date.now, wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

export class CodexAdapter implements EngineAdapter<'codex'> {
  readonly id = 'codex' as const
  constructor(
    private readonly engine: Pick<CodexEngine, 'isSocketLive' | 'connect' | 'connectAndResume' | 'connectAndFork' | 'disconnect'>,
    private readonly io: CodexLaunchIo = nativeIo,
  ) {}

  async spawn(input: EngineSpawnInput<'codex'>): Promise<EngineSpawnResult<'codex'>> {
    const source = input.mode.kind === 'fresh' ? undefined : input.mode.source
    const homeName = input.mode.kind === 'resume' ? source!.homeName : input.tmuxName
    const launched = await this.launch({
      sessionId: input.sessionId, tmuxName: input.tmuxName, effectiveCwd: input.cwd, model: input.model,
      codexHomeName: homeName,
      resumeThread: input.mode.kind === 'resume' ? source!.threadId : undefined,
      forkFromThread: input.mode.kind === 'fork' ? source!.threadId : undefined,
      forkSourceHomeName: input.mode.kind === 'fork' ? source!.homeName : undefined,
    })
    return {
      provider: 'codex', model: launched.model, spawnLogPath: launched.spawnLogPath,
      nativeIdentity: { provider: 'codex', threadId: launched.codexThreadId, homeName },
    }
  }

  private async launch(p: {
    tmuxName: string; sessionId: string; effectiveCwd: string;
    model?: string; forkFromThread?: string; forkSourceHomeName?: string; resumeThread?: string; codexHomeName?: string;
  }): Promise<{ sockPath: string; spawnLogPath?: string; codexThreadId: string; model?: string }> {
    const codexHomeName = p.codexHomeName ?? p.tmuxName
    const sockPath = codexSocketPath(codexHomeName)
    const codexHome = codexHomeDir(codexHomeName)
    const mcpServerPath = join(new URL('..', import.meta.url).pathname, 'codex-mcp-server.ts')
    // A native fork needs the parent's persisted rollout, but each Hydra session
    // must keep its own app-server socket/home. Seed only the rollout store into
    // the fresh destination home rather than sharing a live CODEX_HOME.
    // Verify external ownership before touching a recyclable destination home.
    if (await this.engine.isSocketLive(sockPath)) {
      throw new Error(`refusing to replace live codex app-server at ${sockPath}`)
    }

    if (p.forkFromThread && p.forkSourceHomeName && p.forkSourceHomeName !== codexHomeName) {
      const sourceSessions = join(process.env.HOME!, '.codex', `hydra-${p.forkSourceHomeName}`, 'sessions')
      const destinationSessions = join(codexHome, 'sessions')
      if (!this.io.existsSync(sourceSessions)) throw new Error(`codex fork source rollouts not found in ${sourceSessions}`)
      this.io.mkdirSync(codexHome, { recursive: true })
      // The human-readable tmux name is recyclable. Refresh only its rollout
      // store so a reused destination cannot fork from an obsolete snapshot.
      this.io.rmSync(destinationSessions, { recursive: true, force: true })
      this.io.cpSync(sourceSessions, destinationSessions, { recursive: true })
    }

    // Every Hydra agent owns exactly one app-server. A live socket means another
    // owner still exists; a dead socket/pid are residue from a prior process.
    this.io.stop(codexHomeName)
    try { this.io.unlinkSync(sockPath) } catch {}

    this.io.mkdirSync(codexHome, { recursive: true, mode: 0o700 })
    const authPath = join(codexHome, 'auth.json')
    try { this.io.unlinkSync(authPath) } catch {}
    this.io.symlinkSync(join(homedir(), '.codex', 'auth.json'), authPath)
    const codexEnv = { ...process.env, CODEX_HOME: codexHome }
    try {
      try { this.io.execFileSync('codex', ['mcp', 'remove', 'hydra'], { env: codexEnv, stdio: 'ignore' }) } catch {}
      this.io.execFileSync('codex', ['mcp', 'add', 'hydra', '--env', `DAEMON_SOCK=${SOCK_PATH}`, '--env', `HYDRA_SESSION_ID=${p.sessionId}`, '--', 'bun', mcpServerPath], { env: codexEnv, stdio: 'pipe' })
    } catch (err) {
      throw new Error(`failed to configure codex app-server: ${err instanceof Error ? err.message : err}`)
    }

    this.io.mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    const spawnLogPath = join(SPAWN_LOGS_DIR, `${p.tmuxName}-${p.sessionId}.log`)
    process.stderr.write(`daemon: codex spawning durable app-server for ${p.tmuxName}\n`)
    this.io.start({ homeName: codexHomeName, cwd: p.effectiveCwd, logPath: spawnLogPath, model: p.model })

    // Connect to the app-server socket with retry
    const start = this.io.now()
    let codexThreadId: string | null = null
    let resolvedModel = p.model
    let lastErr = ''
    while (this.io.now() - start < 15_000) {
      try {
        if (p.resumeThread) {
          const r = await this.engine.connectAndResume(p.sessionId, sockPath, p.resumeThread)
          resolvedModel = r.model ?? resolvedModel
          codexThreadId = p.resumeThread
        } else if (p.forkFromThread) {
          const r = await this.engine.connectAndFork(p.sessionId, sockPath, p.forkFromThread, p.model)
          codexThreadId = r.threadId
          resolvedModel = r.model ?? resolvedModel
        } else {
          const r = await this.engine.connect(p.sessionId, sockPath, p.model)
          codexThreadId = r.threadId
          resolvedModel = r.model
        }
        break
      } catch (err: any) {
        lastErr = err?.message || String(err)
        try { this.engine.disconnect(p.sessionId) } catch {}
        await this.io.wait(500)
      }
    }
    if (!codexThreadId) {
      process.stderr.write(`daemon: stopping codex app-server ${p.tmuxName} (startup timeout: ${lastErr})\n`)
      this.io.stop(codexHomeName)
      throw new Error(`codex socket not ready after 15s (last: ${lastErr})`)
    }
    process.stderr.write(`daemon: codex connected for ${p.tmuxName}, thread=${codexThreadId}\n`)

    return { sockPath, spawnLogPath, codexThreadId, model: resolvedModel }
  }

}
