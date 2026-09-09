import { spawn, execFileSync } from 'child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export function codexHomeDir(homeName: string): string {
  return join(homedir(), '.codex', `hydra-${homeName}`)
}

export function codexPidPath(homeName: string): string {
  return join(codexHomeDir(homeName), 'hydra-app-server.pid')
}

export type StartCodexAppServerOptions = {
  homeName: string
  cwd: string
  logPath: string
  model?: string
}

/** Start an app-server independently of tmux so the presentation surface is disposable. */
export function startCodexAppServer(options: StartCodexAppServerOptions): number {
  const home = codexHomeDir(options.homeName)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(dirname(options.logPath), { recursive: true, mode: 0o700 })

  const args = ['app-server', '--listen', 'unix://']
  if (options.model) args.push('-c', `model=${JSON.stringify(options.model)}`)
  args.push('-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"')

  const logFd = openSync(options.logPath, 'a', 0o600)
  try {
    const child = spawn('codex', args, {
      cwd: options.cwd,
      env: { ...process.env, CODEX_HOME: home },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    if (!child.pid) throw new Error('codex app-server did not return a pid')
    child.unref()
    writeFileSync(codexPidPath(options.homeName), `${child.pid}\n`, { mode: 0o600 })
    return child.pid
  } finally {
    closeSync(logFd)
  }
}

/** Stop only a process that still looks like the app-server Hydra launched. */
export function stopCodexAppServer(homeName: string): boolean {
  const pidPath = codexPidPath(homeName)
  if (!existsSync(pidPath)) return false
  const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
  try { unlinkSync(pidPath) } catch {}
  if (!Number.isSafeInteger(pid) || pid <= 1) return false

  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    if (!command.includes('codex') || !command.includes('app-server')) return false
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}
