// `restart` typed in chat must not promise "back in a moment" when the new build would refuse to start: the background `hydra restart`
// prints its refusal to /dev/null. The operator is told in chat, and nothing is restarted.
import { afterEach, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'child_process'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { gateway, STATE_DIR } from '../config.js'
import { handleRestartIntercept } from '../commands/global.js'

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); rmSync(join(STATE_DIR, 'access.json'), { force: true }) })

test('with an access.json that still holds channels and no hydra.toml, restart says why in chat and starts nothing', async () => {
  writeFileSync(join(STATE_DIR, 'access.json'), JSON.stringify({ groups: { '300000000000000001': {} } }))
  const sent: string[] = []
  spies.push(spyOn(gateway, 'send').mockImplementation((async (_c: string, text: string) => { sent.push(text); return { id: 'x' } }) as any))
  spies.push(spyOn(gateway, 'react').mockImplementation((async () => {}) as any))
  const exec = spyOn(childProcess, 'execSync').mockImplementation((() => { throw new Error('must not restart') }) as any)
  spies.push(exec)
  await handleRestartIntercept({ id: 'm1', channelId: 'c1', content: 'restart', isDM: true } as any)
  expect(exec).not.toHaveBeenCalled()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Not restarting')
  expect(sent[0]).toContain("Run 'hydra migrate'")
})
