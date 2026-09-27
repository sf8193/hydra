import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const source = readFileSync(join(import.meta.dir, '..', 'router.ts'), 'utf8')

describe('Codex user-message routing ratchet', () => {
  test('user messages are delivered only through the ingress-reserved next-turn path', () => {
    expect(source.match(/deferUntilTurnComplete:\s*true/g) ?? []).toHaveLength(1)
    // One call site of buildNotificationPayload, inside enqueueUserMessage.
    expect(source.match(/await buildNotificationPayload\(/g) ?? []).toHaveLength(1)
    const helper = source.slice(source.indexOf('function enqueueUserMessage'))
    expect(helper.indexOf('reserveUserIngress(')).toBeGreaterThan(-1)
    expect(helper.indexOf('reserveUserIngress(')).toBeLessThan(helper.indexOf('buildNotificationPayload('))
    expect(helper).toMatch(/\}, \{ before \}\)/)
  })

  test('deliverToSession reserves synchronously (no await before the slot)', () => {
    expect(source).toMatch(/\nfunction deliverToSession\(/)
    expect(source).not.toMatch(/async function deliverToSession\(/)
  })

  test('both router paths use the shared helper', () => {
    expect(source).toMatch(/return enqueueUserMessage\(msg, targetSessionId, chatId, before\)/)
    expect(source).toMatch(/await enqueueUserMessage\(msg, targetSessionId, effectiveChatId\)/)
  })

  test('! captures the interrupt promise and hands it to the reserved slot', () => {
    expect(source).toMatch(/interrupted = interruptAdapter\.interrupt\(info\)/)
    expect(source).toMatch(/deliverToSession\(msg, mappedSession, access, interrupted\)/)
    expect(source).not.toMatch(/void interruptAdapter\.interrupt\(info\)/)
  })
})
