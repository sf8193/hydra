// Keeps `<state>/hydra.toml` loaded: re-read on change, and a failed load keeps the last good config and alerts the operator.
// A missing file reads as an empty one, which is valid.

import { readFileSync } from 'fs'
import { EMPTY_CONFIG, formatIssues, loadHydraConfig } from './load.js'
import type { ConfigIssue, HydraConfig, LoadEnv, LoadResult } from './types.js'

const EMPTY_CONFIRM_MS = 250

export type HydraConfigWatch = {
  /** The last config that loaded. Before any has, the empty config. */
  current(): HydraConfig
  /** The result of the first read, so a caller can decide whether to start at all. */
  initial: LoadResult
  /** Reads the file now. The watcher calls this; so may a writer that wants its change live at once. */
  reload(): LoadResult | undefined
  stop(): void
}

export type WatchOpts = {
  path: string
  env: LoadEnv
  /** A new config loaded, with its warnings. */
  onLoad?(config: HydraConfig, warnings: ConfigIssue[]): void
  /** A load failed and the last good config stays. Called once per distinct failure, not on every save of the same bad file. */
  onAlert(text: string): void
  /** How often the file is re-read. Default 1s. */
  intervalMs?: number
}

export function watchHydraConfig(opts: WatchOpts): HydraConfigWatch {
  let config: HydraConfig = EMPTY_CONFIG
  let lastText: string | undefined
  let lastAlert: string | undefined

  const read = (): string => {
    try { return readFileSync(opts.path, 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw e
    }
  }

  let confirmEmpty: ReturnType<typeof setTimeout> | undefined

  /** Undefined when the text hasn't changed since the last read, or an empty read is waiting to be confirmed. */
  const reload = (): LoadResult | undefined => {
    let text: string
    try { text = read() } catch (e) {
      const message = `hydra.toml couldn't be read, so the last good config stays: ${(e as Error).message}`
      alert(message)
      return { ok: false, errors: [{ path: '', message }], warnings: [] }
    }
    if (text === lastText) return undefined
    // A save that truncates and then writes, or replaces by delete-then-create, can be read in between. A file that goes
    // empty or missing is read once more before that empties the config.
    if (text.trim() === '' && lastText?.trim() && !confirmEmpty) {
      confirmEmpty = setTimeout(() => { reload(); confirmEmpty = undefined }, EMPTY_CONFIRM_MS)
      return undefined
    }
    lastText = text
    const result = loadHydraConfig(text, opts.env)
    if (result.ok) {
      config = result.config
      lastAlert = undefined
      opts.onLoad?.(config, result.warnings)
    } else {
      alert(`hydra.toml didn't load, so the last good config stays:\n${formatIssues(result.errors)}`)
    }
    return result
  }

  const alert = (text: string) => {
    if (text === lastAlert) return
    lastAlert = text
    opts.onAlert(text)
  }

  // The first read always has a result: lastText starts undefined, and an empty first read is applied at once.
  const initial = reload()!

  // Re-reads the file on an interval; reload() skips text that hasn't changed. Neither fs.watch nor fs.watchFile is
  // used: under load on macOS, fs.watch missed the first events after subscribing, and watchFile's first stat is
  // taken asynchronously, so a write that lands before it is never seen. One small read a second is cheap, and it
  // follows the path, so a replace by an editor or an atomic write is seen too.
  const timer = setInterval(() => { reload() }, opts.intervalMs ?? 1000)
  ;(timer as { unref?: () => void }).unref?.()

  return {
    current: () => config,
    initial,
    reload,
    stop: () => { clearTimeout(confirmEmpty); clearInterval(timer) },
  }
}
