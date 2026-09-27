import { describe, expect, test } from 'bun:test'
import { execFile } from 'child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { sendTmuxKeys } from '../codex-key-queue.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'

// Fake executable, not a global child_process mock. Run this file separately
// from suites that replace child_process (as with codex-launch-surface.tmux).
const mocked = 'mock' in execFile
async function withTmux(fn: (calls: (all?: boolean) => Array<{ args: string[]; at: number }>, pane: (text: string) => void) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-keys-'))
  const savedPath = process.env.PATH
  const log = join(dir, 'calls')
  const pane = join(dir, 'pane')
  writeFileSync(log, '')
  writeFileSync(pane, '1 2 0\n› Ask Codex to do anything\n')
  writeFileSync(join(dir, 'tmux'), `#!${process.execPath}\nimport { appendFileSync, readFileSync } from 'fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)},JSON.stringify({args,at:Date.now()})+'\\n');
if(args[0]==='display-message') {
 if(args.includes('#{pane_id} #{pane_pid} #{pane_dead}')) process.stdout.write('%1 100 0\\n');
 else process.stdout.write(readFileSync(${JSON.stringify(pane)},'utf8'));
}
if(args.includes('FAIL')) process.exit(1);
`)
  chmodSync(join(dir, 'tmux'), 0o755)
  process.env.PATH = `${dir}:${savedPath}`
  try {
    await fn((all = false) => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => all || call.args[0] === 'send-keys'),
      text => writeFileSync(pane, text))
  } finally {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(mocked)('Codex key submission', () => {
  test('settles literal text before the single default Enter', async () => {
    await withTmux(async calls => {
      await sendTmuxKeys({ target: 'a', mode: 'literal', text: '/status' })
      const sent = calls()
      expect(sent.map(call => call.args.slice(3))).toEqual([['-l', '/status'], ['Enter']])
      expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(250)
    })
  })

  test('keeps literal text and one trailing key atomic with raw controls in FIFO order', async () => {
    await withTmux(async calls => {
      await Promise.all([
        sendTmuxKeys({ target: 'a', mode: 'literal', text: '/status' }),
        sendTmuxKeys({ target: 'a', mode: 'raw', keys: ['Down', 'Enter'] }),
        sendTmuxKeys({ target: 'a', mode: 'literal', text: '/model', trailingKey: 'Escape' }),
      ])
      const sent = calls()
      expect(sent.map(call => call.args.slice(3))).toEqual([
        ['-l', '/status'], ['Enter'], ['Down', 'Enter'], ['-l', '/model'], ['Escape'],
      ])
      expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(250)
      expect(sent[4].at - sent[3].at).toBeGreaterThanOrEqual(250)
    })
  })

  test('another target proceeds while one target waits for readiness', async () => {
    await withTmux(async calls => {
      let release!: () => void
      const waiting = new Promise<void>(resolve => { release = resolve })
      const first = sendTmuxKeys({ target: 'a', mode: 'literal', text: '/status' }, () => waiting)
      await sendTmuxKeys({ target: 'b', mode: 'raw', keys: ['Escape'] })
      expect(calls().map(call => call.args[2])).toEqual(['b'])
      release()
      await first
    })
  })

  test('failed text sends no trailing key and subsequent same-target action succeeds', async () => {
    await withTmux(async calls => {
      const first = sendTmuxKeys({ target: 'a', mode: 'literal', text: 'FAIL' })
      const second = sendTmuxKeys({ target: 'a', mode: 'raw', keys: ['Escape'] })
      await expect(first).rejects.toThrow()
      await second
      expect(calls().map(call => call.args.slice(3))).toEqual([['-l', 'FAIL'], ['Escape']])
    })
  })

  test('readiness failure sends nothing and does not poison the next action', async () => {
    await withTmux(async calls => {
      await expect(sendTmuxKeys({ target: 'a', mode: 'literal', text: '/status' }, async () => {
        throw new Error('cold')
      })).rejects.toThrow('cold')
      await sendTmuxKeys({ target: 'a', mode: 'raw', keys: ['Enter'] })
      expect(calls().map(call => call.args.slice(3))).toEqual([['Enter']])
    })
  })

  test('adapter waits for cold composer; active turn does not gate keys', async () => {
    await withTmux(async (calls, pane) => {
      pane('Loading…\n')
      const adapter = new CodexEngineAdapter({} as any)
      const sent = adapter.sendKeys({ tmuxName: 'a', turnState: 'working' } as any, '/status')
      await Bun.sleep(150)
      expect(calls()).toEqual([])
      pane('1 2 0\n› Ask Codex to do anything\n')
      await expect(sent).resolves.toEqual({ queued: false })
      expect(calls().filter(call => call.args[0] === 'send-keys').map(call => call.args.slice(3)))
        .toEqual([['-l', '/status'], ['Enter']])
    })
  })

  test('adapter checks readiness again for each serialized literal action', async () => {
    await withTmux(async calls => {
      const adapter = new CodexEngineAdapter({} as any)
      await Promise.all([
        adapter.sendKeys({ tmuxName: 'a' } as any, '/status'),
        adapter.sendKeys({ tmuxName: 'a' } as any, '/model'),
      ])
      expect(calls(true).filter(call => call.args.includes('#{cursor_flag} #{cursor_x} #{cursor_y}') || call.args[0] === 'send-keys').map(call => call.args[0])).toEqual([
        'display-message', 'send-keys', 'send-keys', 'display-message', 'send-keys', 'send-keys',
      ])
    })
  })

  test('raw dialog controls bypass composer readiness and add no Enter', async () => {
    await withTmux(async (calls, pane) => {
      pane('Unrecognized dialog\n')
      const adapter = new CodexEngineAdapter({} as any)
      await adapter.sendKeys({ tmuxName: 'a' } as any, 'Down Enter', { raw: true })
      expect(calls().map(call => call.args)).toEqual([['send-keys', '-t', 'a:hydra-chat', 'Down', 'Enter']])
    })
  })

  test('menu selection markers and stale prompts are not ready composers', async () => {
    await withTmux(async (calls, pane) => {
      const adapter = new CodexEngineAdapter({} as any)
      for (const dialog of [
        '0 120 3\nSelect Model and Effort\n› 1. GPT-6-Astra (current)\n\n  enter select · esc back\n',
        '0 120 3\nUpdate Model Permissions\n› 3. Full Access (current)\n\n  enter select · esc back\n',
        '1 2 2\n› historical prompt\n\nSome other focused input\n',
      ]) {
        const before = calls().length
        pane(dialog)
        const sending = adapter.sendKeys({ tmuxName: 'a' } as any, '/status')
        await Bun.sleep(400)
        expect(calls()).toHaveLength(before)
        pane('1 2 0\n› Ask Codex to do anything\n')
        await sending
        expect(calls()).toHaveLength(before + 2)
      }
    })
  })

  test('unready composer times out without typing', async () => {
    await withTmux(async (calls, pane) => {
      pane('Loading…\n')
      const adapter = new CodexEngineAdapter({} as any)
      const start = Date.now()
      await expect(adapter.sendKeys({ tmuxName: 'a' } as any, '/status')).rejects.toThrow('no text was sent')
      expect(Date.now() - start).toBeLessThan(6000)
      expect(calls()).toEqual([])
    })
  }, 8000)
})
