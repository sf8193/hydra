// `restart` typed in chat must not promise "back in a moment" when the build on disk would refuse to start: the background
// `hydra restart` prints its refusal to /dev/null. The check runs that build's own `restart --dry-run`, off the gateway's event loop,
// and the operator is told in chat.
import { afterEach, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'child_process'
import { gateway } from '../../infra/config.js'
import { handleRestartIntercept } from '../../app/commands/global.js'

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore() })

const refuse = (stderr: string, message = 'exit 1') => {
  const sent: string[] = []
  const commands: string[][] = []
  spies.push(spyOn(gateway, 'send').mockImplementation((async (_c: string, text: string) => { sent.push(text); return { id: 'x' } }) as any))
  spies.push(spyOn(gateway, 'react').mockImplementation((async () => {}) as any))
  spies.push(spyOn(childProcess, 'execFile').mockImplementation(((_file: string, args: string[], _opts: unknown, cb: Function) => {
    commands.push(args)
    cb(new Error(message), '', Buffer.from(stderr))
  }) as any))
  return { sent, commands }
}
const restart = () => handleRestartIntercept({ id: 'm1', channelId: 'c1', content: 'restart', isDM: true } as any)

test('when the dry run refuses, restart says why in chat and starts nothing', async () => {
  const { sent, commands } = refuse("error: the daemon would be refusing to start: access.json still holds channels. Run 'hydra migrate'.\n")
  await restart()
  expect(commands).toHaveLength(1)
  expect(commands[0]).toContain('--dry-run')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Not restarting')
  expect(sent[0]).toContain("Run 'hydra migrate'")
})

test('a dry run that timed out (no stderr) still gives a reason, and a long crash is cut to fit a chat message', async () => {
  const a = refuse('', 'Command timed out')
  await restart()
  expect(a.sent[0]).toContain('Command timed out')
  for (const s of spies.splice(0)) s.mockRestore()
  const b = refuse('x'.repeat(5000))
  await restart()
  expect(b.sent[0].length).toBeLessThan(1700)
})
