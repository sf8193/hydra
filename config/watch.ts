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
  /** The file's text, on each read that goes on to load it, before the load: for what must be done even when the load fails. */
  onText?(text: string): void
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
  /** Whether lastText loaded. A failed load is retried on every read, even with the same text: a missing workdir or
   * guard is fixed on the machine, not in the file. */
  let lastOk = false

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
      lastOk = false // the next good read loads, even unchanged, and clears this
      alert(message)
      return { ok: false, errors: [{ path: '', message }], warnings: [] }
    }
    if (text === lastText && lastOk) return undefined
    // A save that truncates and then writes, or replaces by delete-then-create, can be read in between. A file that goes
    // empty or missing is read once more before that empties the config.
    if (text.trim() === '' && lastText?.trim() && !confirmEmpty) {
      confirmEmpty = setTimeout(() => { try { reload() } finally { confirmEmpty = undefined } }, EMPTY_CONFIRM_MS)
      return undefined
    }
    const emptied = text.trim() === '' && !!lastText?.trim()
    lastText = text
    opts.onText?.(text)
    const result = loadHydraConfig(text, opts.env)
    lastOk = result.ok
    if (result.ok) {
      config = result.config
      lastAlert = undefined
      opts.onLoad?.(config, result.warnings)
      if (emptied) alert('hydra.toml is empty or missing now, so the empty config is live: no people, specialists or connectors until it is restored.')
    } else {
      alert(`hydra.toml didn't load, so the last good config stays. It is retried every read, so fixing the file or the machine is enough:\n${formatIssues(result.errors)}`)
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
