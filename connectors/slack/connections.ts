// The Slack connections of one daemon: a listener per app hydra.toml declares, what they share (each app's bot ids, who is in which
// channel), and the record of each app (declared, tokens, connection). One owner for the whole set, so connecting, reconciling after
// a hydra.toml edit, stopping and `hydra health` all read the same facts. The daemon holds one (runtime.ts); tests build their own.

import type { HydraConfig, SlackApp } from '../../config/types.js'
import type { ConnectedApps } from './apps.js'
import type { ListenerHealth, SlackListener } from './listener.js'
import { appKey, appSuffix } from './app.js'

/** Where an app's connection is: `pending` (not yet up), `up`, `down` (lost, or never possible: no tokens), `gaveUp` (its first connection failed and was let go, or the supervisor ran out of reconnect attempts). */
export type AppConnection = 'pending' | 'up' | 'down' | 'gaveUp'

/**
 * What this set knows of one app. The listener owns the live facts (its connection state, the scopes its token lacks); a record only
 * mirrors them (`connection` is the listener's `state` as the operator reads it) beside what only the set knows: whether
 * hydra.toml declares the app, and whether its tokens are there. `health()` joins the two, so `hydra health` reads one place.
 */
export type AppRecord = {
  /** hydra.toml declares this app. False only for a connection still running for an app an edit just removed. */
  declared: boolean
  /** Whether the variables the app names for its tokens hold them, and when they do not, which key to fix. */
  tokens: { ok: true } | { ok: false; why: string }
  connection: AppConnection
  /** Why the app's last read of whether it is in a channel failed (several apps only). */
  probeError?: string
}

/** One app's health: what its listener reports (an app with no listener reports `off`), and its record. */
export type AppHealth = ListenerHealth & Pick<AppRecord, 'tokens' | 'connection' | 'probeError'>

/** Why an app can't connect for want of tokens, naming the key to fix; undefined when it has both. */
export function missingTokens(app: SlackApp, t: { app?: string; bot?: string }): string | undefined {
  if (!t.bot) return `${appKey(app.id, 'bot_token_env')} names ${app.botTokenEnv}, which has no value in the daemon's environment`
  if (!app.appTokenEnv) return `${appKey(app.id, 'app_token_env')} is not set, and Socket Mode needs it`
  if (!t.app) return `${appKey(app.id, 'app_token_env')} names ${app.appTokenEnv}, which has no value in the daemon's environment`
  return undefined
}

export type ConnectionsDeps = {
  hydra: () => HydraConfig
  /** One app's tokens, read from the variables it names. */
  tokens: (app: SlackApp) => { app?: string; bot?: string; user?: string }
  /** What the listeners share: made anew whenever the set is stopped. */
  newShared: () => ConnectedApps
  /** A listener for one app, over the shared facts. */
  makeListener: (app: SlackApp, shared: ConnectedApps) => SlackListener
  /** A plain message to the specialists `app` reaches (all of them with no app). */
  alert: (text: string, app?: string) => void
  log: (line: string) => void
  /** Runs `fn` on every hydra.toml load. Called once, the first time the set is started. */
  onConfigLoad: (fn: () => void) => void
  /** Whether the file hydra.toml replaced is still in the state dir: Slack stays off until it is migrated, and says so. */
  oldWatchFileLeft: () => boolean
}

export class SlackConnections {
  private readonly byApp = new Map<string, SlackListener>()
  /** What each skipped app was last told, so a config reload does not say it again. */
  private readonly skipped = new Map<string, string>()
  /** Apps whose first connection failed and was let go; cleared when a later pass tries again. */
  private readonly gaveUp = new Set<string>()
  private reconciling: Promise<void> = Promise.resolve()
  private watching = false
  private shared: ConnectedApps

  constructor(private readonly d: ConnectionsDeps) { this.shared = d.newShared() }

  /** What the listeners share. */
  get sharedApps(): ConnectedApps { return this.shared }

  /** The listener of an app, once it has been started. */
  listener(app: string): SlackListener | undefined { return this.byApp.get(app) }
  /** Every listener, by app id. */
  listeners(): ReadonlyMap<string, SlackListener> { return this.byApp }

  /**
   * Connects every app hydra.toml declares that has tokens, side by side, and begins feeding the watcher. An app with no tokens is
   * skipped and said so by name; the others connect. Runs again on every hydra.toml load: an app added connects, one taken out
   * disconnects. One pass at a time: two overlapping would both start the app they find missing.
   */
  start(): Promise<void> {
    if (!this.watching) {
      this.watching = true
      this.d.onConfigLoad(() => { void this.start().catch(err => this.d.log(`daemon: slack listeners: ${err instanceof Error ? err.stack ?? err.message : err}\n`)) })
    }
    const run = this.reconciling.then(() => this.reconcile())
    this.reconciling = run.catch(() => {})
    return run
  }

  private async reconcile(): Promise<void> {
    const h = this.d.hydra()
    const declared = Object.keys(h.slackApps).length
    for (const [id, l] of this.byApp) if (!Object.hasOwn(h.slackApps, id)) { l.stop(); this.byApp.delete(id) }
    for (const id of [...this.skipped.keys(), ...this.gaveUp]) if (!Object.hasOwn(h.slackApps, id)) { this.skipped.delete(id); this.gaveUp.delete(id) }
    // The old config is no longer read: left behind unmigrated, Slack would go quiet without a word.
    if (!Object.keys(h.slackApps).length && this.d.oldWatchFileLeft()) {
      this.d.alert('⚠️ <state>/slack-watch.json is no longer read, and hydra.toml declares no Slack app, so Slack is not connected. Run `hydra migrate` to carry its routes into hydra.toml; Slack connects as soon as hydra.toml loads it.')
    }
    const starting: Promise<void>[] = []
    const fresh = Object.values(h.slackApps).filter(a => !this.byApp.has(a.id) && !missingTokens(a, this.d.tokens(a))).map(a => a.id)
    this.shared.expectJoin(fresh)   // who is in a channel is not settled until each has joined, failed to, or taken too long
    for (const app of Object.values(h.slackApps)) {
      if (this.byApp.has(app.id)) continue
      const why = missingTokens(app, this.d.tokens(app))
      if (why) {
        this.d.log(`daemon: slack listener for the app named ${app.id} off (${why})\n`)
        if (this.skipped.get(app.id) !== why) { this.skipped.set(app.id, why); this.d.alert(`⚠️ ${app.id === 'default' && declared <= 1 ? 'Slack' : `The app named \`${app.id}\``} is not connected: ${why}. Put the token in that variable (in \`.env\`) and restart the daemon.`, app.id) }
        continue
      }
      this.skipped.delete(app.id)
      this.gaveUp.delete(app.id)
      const l = this.d.makeListener(app, this.shared)
      this.byApp.set(app.id, l)
      // Connected side by side: one app's slow or refused connection does not hold another's.
      // A start that resolves after `stop()` (or after the app was replaced) is stale: it must not mark the app given up.
      const drop = () => { if (this.byApp.get(app.id) !== l) return; this.shared.failedToJoin(app.id); this.gaveUp.add(app.id); this.byApp.delete(app.id) }
      starting.push(l.start().then(ok => { if (!ok) drop() }).catch(err => { this.d.log(`daemon: slack listener${appSuffix(app.id, declared)} failed to start: ${err instanceof Error ? err.stack ?? err.message : err}\n`); drop() }))
    }
    await Promise.all(starting)
  }

  /** Disconnects every app and forgets what was shared; the next `start` begins afresh. */
  stop(): void {
    for (const l of this.byApp.values()) l.stop()
    this.byApp.clear()
    this.skipped.clear()
    this.gaveUp.clear()
    this.reconciling = Promise.resolve()
    this.shared = this.d.newShared()
  }

  // -- what is known about each app ---------------------------------------------------------------------------------------

  /** One app's record: declared in hydra.toml or not, whether its tokens are there, and where its connection is. */
  record(app: string): AppRecord {
    const h = this.d.hydra()
    const declared = Object.hasOwn(h.slackApps, app)
    const l = this.byApp.get(app)
    const missing = declared ? missingTokens(h.slackApps[app], this.d.tokens(h.slackApps[app])) : undefined
    const state = l?.health().state
    const connection: AppConnection = missing ? 'down'
      : this.gaveUp.has(app) || state === 'exhausted' ? 'gaveUp'
      : state === 'up' ? 'up'
      : state === 'down' ? 'down'
      : 'pending'
    const probeError = this.shared.probeError(app)
    return { declared, tokens: missing ? { ok: false, why: missing } : { ok: true }, connection, ...(probeError && { probeError }) }
  }

  /** The app ids this set knows of: every declared app, and any connection still running for one an edit removed. */
  ids(): string[] { return [...new Set([...Object.keys(this.d.hydra().slackApps), ...this.byApp.keys()])] }

  /** Every app's health, by id: its listener's (an app with no listener is `off`), with its record. */
  health(): Record<string, AppHealth> {
    return Object.fromEntries(this.ids().map(id => {
      const r = this.record(id)
      const l = this.byApp.get(id)?.health() ?? { state: 'off', downMin: null, lastActivityAgeMin: null, catchUp: null, lastOkCatchUpAgeMin: null, missingScopes: null } satisfies ListenerHealth
      return [id, { ...l, tokens: r.tokens, connection: r.connection, ...(r.probeError && { probeError: r.probeError }) }]
    }))
  }
}
