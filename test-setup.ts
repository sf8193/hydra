// Bun test preload — isolates ALL daemon state (sessions.json, pr-watches.json, access.json,
// inbox, …) to a throwaway temp dir so the suite never reads or clobbers the developer's live
// ~/.claude channel state. This closes a real hazard: tests that import the daemon modules
// (e.g. dedup/pr-watch tests) would otherwise persist to the live pr-watches.json and wipe
// running watches on every `bun test`.
//
// Must run BEFORE any module imports daemon/config.ts, which resolves STATE_DIR from
// HYDRA_STATE_DIR at import time — a bun `[test] preload` guarantees that ordering. Respect an
// explicitly-provided state dir (HYDRA_STATE_DIR / DISCORD_STATE_DIR) if a test or the shell set one.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

if (!process.env.HYDRA_STATE_DIR && !process.env.DISCORD_STATE_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-test-'))
  process.env.HYDRA_STATE_DIR = dir
  // Preload has no afterAll hook; clean the throwaway dir on process exit so runs don't accumulate.
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
}
