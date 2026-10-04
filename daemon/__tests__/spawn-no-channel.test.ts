import { test, expect } from 'bun:test'
import { doSpawnSession } from '../session-lifecycle.js'
import { DEFAULT_SESSION_CHANNEL } from '../config.js'

// No chat_id and no DEFAULT_SESSION_CHANNEL used to reach Discord as `GET /channels/` → "404: Not Found".
test('spawn with no chat_id and no default channel fails with a clear message', async () => {
  expect(DEFAULT_SESSION_CHANNEL).toBe('')
  await expect(doSpawnSession('t', undefined, undefined, {})).rejects.toThrow('no channel to spawn in')
})
