import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runKillHook } from '../session-lifecycle.js'

test('on-kill hook runs with the dead session identity in env; missing hook is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kill-hook-'))
  try {
    const out = join(dir, 'out')
    const hook = join(dir, 'on-kill')
    writeFileSync(hook, `#!/bin/sh\necho "$HYDRA_SESSION_NAME|$HYDRA_KILL_REASON|$HYDRA_ENGINE|$HYDRA_CODEX_HOME_NAME" > ${out}\n`)
    chmodSync(hook, 0o755)
    const info = { tmuxName: 'glyph', sessionId: 's1', threadId: 't1', engine: 'codex', codexHomeName: 'glyph' } as any

    runKillHook(info, 'missing', join(dir, 'nope'))  // must not throw
    runKillHook(info, 'session ended', hook)
    for (let i = 0; i < 50 && !existsSync(out); i++) await Bun.sleep(20)
    expect(readFileSync(out, 'utf8').trim()).toBe('glyph|session ended|codex|glyph')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The hook's job is to retro only human kills, so an agent's kill_session must carry a
// different reason than a human Kill ('session ended'), all the way through to the hook.
test('kill_session: agent kill reaches the hook as "session ended by <caller>", main as "session ended"', async () => {
  const { executeTool } = await import('../bridge-dispatch.js')
  const { registry, threadRegistry } = await import('../sessions.js')
  const { gateway, STATE_DIR } = await import('../config.js')
  const { KILL_HOOK_PATH } = await import('../session-lifecycle.js')
  const { mkdirSync } = await import("fs")
  const { dirname } = await import('path')

  expect(KILL_HOOK_PATH.startsWith(STATE_DIR)).toBe(true)  // test preload isolates it; never the real hook
  const out = join(STATE_DIR, 'hook-reasons')
  mkdirSync(dirname(KILL_HOOK_PATH), { recursive: true })
  writeFileSync(KILL_HOOK_PATH, `#!/bin/sh\necho "$HYDRA_SESSION_NAME|$HYDRA_KILL_REASON" >> ${out}\n`)
  chmodSync(KILL_HOOK_PATH, 0o755)

  const orig = { send: gateway.send, rp: registry.persist, tp: threadRegistry.persist }
  const sent: string[] = []
  ;(gateway as any).send = async (_c: string, text: string) => { sent.push(text); return { id: 'm' } }
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
  const mk = (id: string, name: string, extra = {}) => registry.set(id, {
    sessionId: id, tmuxName: name, topic: '', threadId: `t-${id}`, createdAt: Date.now(), lastActive: Date.now(),
    listening: false, engine: 'claude', adapter: { stop: async () => {} }, sessionType: 'thread_owner', ...extra,
  } as any)
  try {
    mk('kh-caller', 'kh-owner')
    mk('kh-helper', 'kh-helper', { initiator: 'kh-owner' })
    mk('kh-other', 'kh-other')
    expect((await executeTool('kill_session', { session_id: 'kh-helper' }, 'kh-caller')).isError).toBeFalsy()
    expect((await executeTool('kill_session', { session_id: 'kh-other' }, 'main')).isError).toBeFalsy()

    expect(sent).toContain('_session ended by kh-owner_')
    expect(sent).toContain('_session ended_')
    for (let i = 0; i < 50 && (!existsSync(out) || readFileSync(out, 'utf8').trim().split('\n').length < 2); i++) await Bun.sleep(20)
    expect(readFileSync(out, 'utf8').trim().split('\n').sort()).toEqual(['kh-helper|session ended by kh-owner', 'kh-other|session ended'])
  } finally {
    ;(gateway as any).send = orig.send
    ;(registry as any).persist = orig.rp
    ;(threadRegistry as any).persist = orig.tp
    for (const id of ['kh-caller', 'kh-helper', 'kh-other']) registry.delete(id)
    rmSync(KILL_HOOK_PATH, { force: true }); rmSync(out, { force: true })
  }
})
