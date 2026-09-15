// Bun test preload — isolates ALL daemon state (sessions.json, pr-watches.json, access.json,
// inbox, …) to a throwaway temp dir so the suite never reads or clobbers the developer's live
// ~/.claude channel state. This closes a real hazard: tests that import the daemon modules
// (e.g. dedup/pr-watch tests) would otherwise persist to the live pr-watches.json and wipe
// running watches on every `bun test`.
//
// Must run BEFORE any module imports daemon/config.ts, which resolves STATE_DIR from
// HYDRA_STATE_DIR at import time — a bun `[test] preload` guarantees that ordering.
//
// ALWAYS isolate — never respect an inherited HYDRA_STATE_DIR/DISCORD_STATE_DIR, even if one
// is set in the shell. Those are exactly the vars the REAL daemon uses for its own live state,
// and every hydra-spawned Claude Code session has HYDRA_STATE_DIR set in its own environment
// (it's how the session's bridge connects back to the daemon) — so respecting an "explicitly
// set" state dir here meant every `bun test` run FROM one of those sessions silently wrote test
// fixtures into the real, live ~/.claude/channels/discord state instead of a temp dir. Confirmed
// in production: message-queue.json, idempotency.json, threads.json, and factory/history.jsonl
// all had real test-fixture pollution dating back to at least 2026-09-09, cleaned up 2026-09-15.
// A developer who genuinely wants tests to target a specific directory for inspection can set
// HYDRA_TEST_STATE_DIR instead — a name that can never collide with the daemon's own vars.
//
// Naming the var differently isn't itself an enforced invariant — nothing stopped a developer
// (or an agent) from setting HYDRA_TEST_STATE_DIR to the real ~/.claude/channels path while
// debugging something, silently reproducing the exact bug this file exists to prevent. So this
// is a hard guard, not just a convention: refuse to isolate to anything under ~/.claude/channels
// (any platform, not just the current CHAT_PLATFORM), full stop, even if explicitly requested.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, resolve, sep } from 'path'

export const FORBIDDEN_STATE_DIR_PREFIX = resolve(join(homedir(), '.claude', 'channels'))

// Segment-aware, not a raw startsWith — resolve(path).startsWith(prefix) would
// false-positive on a sibling like ~/.claude/channels-backup/foo. Caveat: this
// compares the given path as written, not its realpath — a symlink that
// *resolves* into the forbidden dir isn't caught (resolve() doesn't follow
// symlinks, and realpath-ing here would throw on a not-yet-created target
// dir, which is a normal case for this var). Low severity: it requires
// deliberately constructing that symlink, not an accident.
export function isForbiddenStateDir(candidate: string): boolean {
  const resolved = resolve(candidate)
  return resolved === FORBIDDEN_STATE_DIR_PREFIX || resolved.startsWith(FORBIDDEN_STATE_DIR_PREFIX + sep)
}

const explicit = process.env.HYDRA_TEST_STATE_DIR
if (explicit && isForbiddenStateDir(explicit)) {
  throw new Error(
    `HYDRA_TEST_STATE_DIR (${explicit}) resolves under ${FORBIDDEN_STATE_DIR_PREFIX} — that's the real ` +
    `daemon's live state, not a test target. Point it somewhere else, or unset it to isolate ` +
    `to a throwaway temp dir instead.`,
  )
}

const dir = explicit ?? mkdtempSync(join(tmpdir(), 'hydra-test-'))
process.env.HYDRA_STATE_DIR = dir
delete process.env.DISCORD_STATE_DIR
if (!explicit) {
  // Preload has no afterAll hook; clean the throwaway dir on process exit so runs don't accumulate.
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
}
