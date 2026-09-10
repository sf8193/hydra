import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { join } from 'path'
import { execFileSync, spawnSync } from 'child_process'
import assert from 'assert/strict'
// Opt-in acceptance test: real app-server processes and two short model turns.
// All registry state, homes, and tmux surfaces are isolated. Credentials are
// read through a symlink to the existing shared login; no login is performed.
if (!process.argv.includes('--live')) {
 console.error('Usage: bun scripts/check-codex-recovery.ts --live')
 process.exit(1)
}
const originalHome = process.env.PARITY_ORIGINAL_HOME ?? process.env.HOME!
const root = process.env.PARITY_ROOT ?? mkdtempSync('/tmp/hp-')
if (!process.env.PARITY_ROOT) {
 const r = spawnSync(process.execPath, [process.argv[1], '--live'], { stdio: 'inherit', env: { ...process.env, HOME: root, PARITY_ROOT: root, PARITY_ORIGINAL_HOME: originalHome } })
 process.exit(r.status ?? 1)
}
const tmuxBin = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
mkdirSync(join(root, 'state')); mkdirSync(join(root, 'bin')); mkdirSync(join(root, '.codex'))
symlinkSync(join(originalHome, '.codex/auth.json'), join(root, '.codex/auth.json'))
const socket = join(root, 'tmux.sock')
writeFileSync(join(root, 'bin/tmux'), `#!/bin/sh\nexec '${tmuxBin}' -S '${socket}' "$@"\n`, { mode: 0o755 })
process.env.HOME = root
process.env.HYDRA_STATE_DIR = join(root, 'state')
process.env.DISCORD_STATE_DIR = join(root, 'state')
process.env.CLAUDE_CONFIG_DIR = join(root, '.claude')
process.env.SPAWN_CWD = root
process.env.PATH = join(root, 'bin') + ':' + process.env.PATH
const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const { gateway } = await import(repo + '/daemon/config.ts')
const sent: string[] = []
Object.assign(gateway, {
 send: async (_id: string, text: string) => { sent.push(text); return { id: 'test-message' } },
 edit: async () => {}, react: async () => {}, getThreadUrl: async () => '',
 fetchChannel: async () => ({ isThread: true, parentId: 'parent', type: 'thread' }),
 getThreadStarterInfo: async () => null, updateSessionVisual: async () => {}, renameThread: async () => {},
})
const { registry, threadRegistry } = await import(repo + '/daemon/sessions.ts')
const { doSpawnSession, killSession } = await import(repo + '/daemon/session-lifecycle.ts')
const { codexEngine, reconnectCodexAfterDisconnect } = await import(repo + '/daemon/codex-bootstrap.ts')
const { handleResumeIntercept, handleRespawnIntercept } = await import(repo + '/daemon/commands/thread.ts')
const { codexHomeDir, stopCodexAppServer } = await import(repo + '/daemon/codex-process.ts')
const starts: {id: string, text: string}[] = []
// Real app-server lifecycle/RPC, but no model turns for command checks.
const startTurn = codexEngine.startTurn.bind(codexEngine)
codexEngine.startTurn = async (id: string, text: string) => { starts.push({id,text}) }
const msg = (threadId: string) => ({ channelId: threadId, effectiveThreadId: threadId, isThread: true, id: 'test', content: '', parentChannelId: 'parent' } as any)
console.log('Isolated live state:', root)
try {
 const parent = await doSpawnSession('parity test', undefined, undefined, { headless: true, engine: 'codex', promptBuilder: () => 'Reply only OK.' })
 const info = registry.get(parent.sessionId)!
 const identity = { homeName: info.codexHomeName!, threadId: info.codexThreadId! }
 assert(info.sessionMetadata!.model !== 'codex-default')
 console.log('PASS spawn:', info.sessionMetadata!.model)
 execFileSync('tmux', ['kill-session', '-t', parent.name])
 await handleResumeIntercept(msg(parent.threadId))
 assert.equal(registry.getByThread(parent.threadId), parent.sessionId)
 assert.equal(starts.length, 1)
 execFileSync('tmux', ['has-session', '-t', parent.name])
 console.log('PASS missing UI resume repairs same runtime without another turn')
 execFileSync('tmux', ['kill-session', '-t', parent.name])
 await handleRespawnIntercept(msg(parent.threadId))
 assert.equal(starts.length, 1)
 assert(sent.some(s => s.includes('live session')))
 console.log('PASS respawn refuses healthy engine with missing UI')
 // Seed a real, tiny conversation so native fork/resume must preserve history.
 const done = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('model turn timeout')), 45000)
  codexEngine.once('turnCompleted', () => { clearTimeout(timer); resolve() })
 })
 await startTurn(parent.sessionId, 'Remember the marker PARITY_CEDAR_482. Reply only OK. Do not use tools.')
 await done
 const conn = (codexEngine as any).connections.get(parent.sessionId)
 const before = await (codexEngine as any).request(conn, 'thread/read', { threadId: identity.threadId, includeTurns: true })
 assert(JSON.stringify(before).includes('PARITY_CEDAR_482'))
 // Simulate a lost completion during socket replacement with a queued handoff.
 conn.deferredTurnQueue.push('ROUND_2: acknowledge the saved marker.')
 codexEngine.disconnect(parent.sessionId)
 assert(await reconnectCodexAfterDisconnect(parent.sessionId))
 assert.equal(starts.filter(s => s.text.startsWith('ROUND_2')).length, 1)
 const restored = (codexEngine as any).connections.get(parent.sessionId)
 assert.equal(restored.threadId, identity.threadId)
 console.log('PASS reconnect resumes same thread and drains a missed-completion handoff once')
 // A queued third round must be removed by retirement, never executed afterward.
 await startTurn(parent.sessionId, 'Write a long explanation of prime numbers. Do not use tools.')
 await Bun.sleep(500)
 restored.deferredTurnQueue.push('ROUND_3: must be cancelled')
 const retiring = (codexEngine as any).connections.get(parent.sessionId)
 console.log('Cancellation probe:', retiring?.currentTurnId, 'connected:', !!retiring)
 const request = (codexEngine as any).request.bind(codexEngine)
 ;(codexEngine as any).request = async (...args: any[]) => {
   try { return await request(...args) }
   catch (err) { console.error('RPC failed:', args[1], String(err)); throw err }
 }
 const { providerFor } = await import(repo + '/daemon/session-provider.ts')
 assert.equal((await providerFor('codex').retireExecution(providerFor('codex').executionRef(info))).status, 'terminal')
 assert(!starts.some(s => s.text.startsWith('ROUND_3')))
 console.log('PASS retirement fences and discards queued handoff')
 // Resume under a fresh Hydra identity below; keep the old server alive for fork.

 const child = await doSpawnSession('fork test', undefined, undefined, { headless: true, engine: 'codex', forkFrom: { codexThreadId: identity.threadId, codexHomeName: identity.homeName, parentName: parent.name }, promptBuilder: () => 'Reply only OK.' })
 const ci = registry.get(child.sessionId)!
 assert.notEqual(ci.codexThreadId, identity.threadId)
 assert.notEqual(ci.codexHomeName, identity.homeName)
 const cc = (codexEngine as any).connections.get(child.sessionId)
 const inherited = await (codexEngine as any).request(cc, 'thread/read', { threadId: ci.codexThreadId, includeTurns: true })
 assert(JSON.stringify(inherited).includes('PARITY_CEDAR_482'))
 await killSession(ci, 'isolated parity cleanup')
 assert(await codexEngine.isSocketLive(join(codexHomeDir(identity.homeName), 'app-server-control/app-server-control.sock')))
 console.log('PASS real native fork inherits conversation; child kill leaves parent connected')
 await killSession(info, 'isolated parity kill-resume')
 const count = starts.length
 await handleResumeIntercept(msg(parent.threadId))
 const resumed = registry.get(registry.getByThread(parent.threadId)!)!
 assert.equal(resumed.engine, 'codex'); assert.equal(resumed.codexThreadId, identity.threadId)
 assert.equal(starts.length, count + 1)
 console.log('PASS kill→resume same persistent thread, one recovery turn')
 await killSession(resumed, 'isolated parity kill-respawn')
 await handleRespawnIntercept(msg(parent.threadId))
 const respawned = registry.get(registry.getByThread(parent.threadId)!)!
 assert.equal(respawned.engine, 'codex'); assert.notEqual(respawned.codexThreadId, identity.threadId)
 assert.equal(respawned.sessionMetadata!.model, info.sessionMetadata!.model)
 console.log('PASS kill→respawn new Codex thread preserving resolved model')
} catch (err) {
 console.error('FAIL', err)
 process.exitCode = 1
} finally {
 for (const info of [...registry.values()]) { await killSession(info, 'isolated parity cleanup').catch(() => {}); stopCodexAppServer(info.codexHomeName ?? info.tmuxName) }
 try { execFileSync(tmuxBin, ['-S', socket, 'kill-server']) } catch {}
 console.log('Cleanup complete; state retained:', root)
 setTimeout(() => process.exit(process.exitCode ?? 0), 3500)
}
