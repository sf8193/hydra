// `restart` typed in chat must not promise "back in a moment" when the build on disk would refuse to start: the background
// `hydra restart` prints its refusal to /dev/null. The check runs that build's own `restart --dry-run`, and the operator is told in chat.
import { afterEach, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'child_process'
import { gateway } from '../../infra/config.js'
import { handleRestartIntercept } from '../commands/global.js'

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore() })

test('when the dry run refuses, restart says why in chat and starts nothing', async () => {
  const sent: string[] = []
  spies.push(spyOn(gateway, 'send').mockImplementation((async (_c: string, text: string) => { sent.push(text); return { id: 'x' } }) as any))
  spies.push(spyOn(gateway, 'react').mockImplementation((async () => {}) as any))
  const commands: string[] = []
  spies.push(spyOn(childProcess, 'execSync').mockImplementation(((cmd: string) => {
    commands.push(cmd)
    throw Object.assign(new Error('exit 1'), { stderr: Buffer.from("error: the daemon would be refusing to start: access.json still holds channels. Run 'hydra migrate'.\n") })
  }) as any))
  await handleRestartIntercept({ id: 'm1', channelId: 'c1', content: 'restart', isDM: true } as any)
  expect(commands).toHaveLength(1)
  expect(commands[0]).toContain('--dry-run')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Not restarting')
  expect(sent[0]).toContain("Run 'hydra migrate'")
})
