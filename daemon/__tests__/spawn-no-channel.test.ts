import { test, expect } from 'bun:test'
import { resolveSpawnChannel } from '../session-lifecycle.js'

const probe = async () => ({ isThread: false, isDM: false, parentId: null })

// No chat_id and no DEFAULT_SESSION_CHANNEL used to reach Discord as `GET /channels/` → "404: Not Found".
test('no chat_id and no default channel fails with a clear message', async () => {
  await expect(resolveSpawnChannel(undefined, '', probe, false)).rejects.toThrow('no channel to spawn in')
})

test('a chat_id still resolves when there is no default channel', async () => {
  expect((await resolveSpawnChannel('c1', '', probe, false)).targetChannelId).toBe('c1')
})
