import { expect, test } from 'claude-code/testing'

const msg = (chat: string, { userId = '1', messageId = '9' } = {}) =>
  `<channel source="plugin:discord:discord" chat_id="${chat}" message_id="${messageId}" user="sf8193" user_id="${userId}" ts="t">\nhi\n</channel>`
const CH = { kind: 'channel', server: 'plugin:discord:discord' }

// Stubs Claude Code beneath the mod and records what reached it and every bridge call the mod made.
function stubs(on: any, tool: object = { result: 'ok', text: 'ok' }) {
  const seen = { sent: [] as string[], submits: 0, stops: 0 }
  on('prompt.submit', ($: any, e: any) => { seen.submits++; return { text: e.text } })
  on('tool.call', () => tool)
  on('classic.Stop', () => { seen.stops++; return {} })
  on('mcp.call', ($: any, e: any) => {
    seen.sent.push(`${e.server} ${e.tool} ${e.args.chat_id} ${e.args.text}`)
    return { value: e.args.text === 'FAILS' ? { content: [], isError: true } : { content: [] } }
  })
  return seen
}
const stop = (last: string, extra: object = {}) =>
  ({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: last, background_tasks: [], session_crons: [], ...extra })
const R = (chat: string, text: string) => `plugin:discord:discord reply ${chat} ${text}`

test('a Discord turn that ends without reply sends its answer to that chat; the events still reach Claude Code', async ($, on) => {
  const seen = stubs(on)
  await $.prompt.submit({ text: msg('111'), wait: false, origin: CH })
  await $.classic.Stop(stop('the answer'))
  expect(seen.sent).toEqual([R('111', 'the answer')])
  expect([seen.submits, seen.stops]).toEqual([1, 1])
})

test('a turn that called reply sends nothing more', async ($, on) => {
  const seen = stubs(on)
  await $.prompt.submit({ text: msg('111'), wait: false, origin: CH })
  await $.tool.call({ tool: 'mcp__plugin_discord_discord__reply', chat_id: '111', text: 'x' })
  await $.classic.Stop(stop('the answer'))
  expect(seen.sent).toEqual([])
})

test('a react to the message counts as answered', async ($, on) => {
  const seen = stubs(on)
  await $.prompt.submit({ text: msg('111'), wait: false, origin: CH })
  await $.tool.call({ tool: 'mcp__plugin_discord_discord__react', chat_id: '111', message_id: '9', emoji: '👍' })
  await $.classic.Stop(stop('done'))
  expect(seen.sent).toEqual([])
})

test('editing a message or replying to another chat does not answer this one', async ($, on) => {
  const seen = stubs(on)
  await $.prompt.submit({ text: msg('111'), wait: false, origin: CH })
  await $.tool.call({ tool: 'mcp__plugin_discord_discord__edit_message', chat_id: '111', message_id: '5', text: 'x' })
  await $.tool.call({ tool: 'mcp__plugin_discord_discord__reply', chat_id: '222', text: 'x' })
  await $.classic.Stop(stop('the answer'))
  expect(seen.sent).toEqual([R('111', 'the answer')])
})

test('a failed reply call leaves the chat unanswered', async ($, on) => {
  const seen = stubs(on, { result: 'Error: 404', text: 'Error: 404', isError: true })
  await $.prompt.submit({ text: msg('111'), wait: false, origin: CH })
  await $.tool.call({ tool: 'mcp__plugin_discord_discord__reply', chat_id: '111', text: 'x' })
  await $.classic.Stop(stop('the answer'))
  expect(seen.sent).toEqual([R('111', 'the answer')])
})

test('a refused reply call leaves the chat unanswered', async ($, on) => {
  const seen = stubs(on, { deny: 'refused' })
  await $.prompt.submit({ text: msg('111'), wait: false, origin: CH })
  await $.tool.call({ tool: 'mcp__plugin_discord_discord__reply', chat_id: '111', text: 'x' })
  await $.classic.Stop(stop('the answer'))
  expect(seen.sent).toEqual([R('111', 'the answer')])
})

test('two chats waiting: the target is unknown, so nothing is sent, even after one is answered', async ($, on) => {
  const seen = stubs(on)
  await $.prompt.submit({ text: msg('111') + '\n' + msg('222'), wait: false, origin: CH })
  await $.tool.call({ tool: 'mcp__plugin_discord_discord__reply', chat_id: '111', text: 'x' })
  await $.classic.Stop(stop('Replied to 111.'))
  await $.prompt.submit({ text: 'typed', wait: false, origin: { kind: 'composer' } })
  await $.classic.Stop(stop('later'))
  expect(seen.sent).toEqual([])
})

test('after an ambiguous turn, the next single-chat message is guarded again', async ($, on) => {
  const seen = stubs(on)
  await $.prompt.submit({ text: msg('111') + '\n' + msg('222'), wait: false, origin: CH })
  await $.classic.Stop(stop('first'))
  await $.prompt.submit({ text: msg('333'), wait: false, origin: CH })
  await $.classic.Stop(stop('second'))
  expect(seen.sent).toEqual([R('333', 'second')])
})

test('an interrupted turn leaves its message to the daemon: a later answer is not sent for it', async ($, on) => {
  const seen = stubs(on)
  on('turn.complete', () => ({ text: '' }))
  await $.prompt.submit({ text: msg('111'), wait: false, origin: CH })
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: true, reason: 'aborted', usage: null })
  await $.prompt.submit({ text: 'typed', wait: false, origin: { kind: 'composer' } })
  await $.classic.Stop(stop('PINEAPPLE'))
  expect(seen.sent).toEqual([])
})

test('still waiting on background work or a scheduled wakeup: nothing is sent yet', async ($, on) => {
  const seen = stubs(on)
  await $.prompt.submit({ text: msg('111'), wait: false, origin: CH })
  await $.classic.Stop(stop('Agent launched. Waiting...', { background_tasks: [{ id: 'a', type: 'subagent', status: 'running', description: 'x' }] }))
  await $.classic.Stop(stop('Will check back.', { session_crons: [{ id: 'c' }] }))
  await $.classic.Stop(stop('SUBDONE'))
  expect(seen.sent).toEqual([R('111', 'SUBDONE')])
})

test('daemon notices, other sessions, other channels and typed prompts need no reply', async ($, on) => {
  const seen = stubs(on)
  await $.prompt.submit({ text: msg('111', { userId: 'system', messageId: '' }), wait: false, origin: CH })
  await $.prompt.submit({ text: msg('111', { userId: 'session', messageId: '' }), wait: false, origin: CH })
  await $.prompt.submit({ text: msg('111').replace('plugin:discord:discord', 'plugin:telegram:telegram'), wait: false, origin: CH })
  await $.prompt.submit({ text: 'typed at the terminal', wait: false, origin: { kind: 'composer' } })
  await $.classic.Stop(stop('Noted, waiting for review.'))
  expect(seen.sent).toEqual([])
})

test('an empty answer sends nothing', async ($, on) => {
  const seen = stubs(on)
  await $.prompt.submit({ text: msg('111'), wait: false, origin: CH })
  await $.classic.Stop(stop(''))
  expect(seen.sent).toEqual([])
})

test('a failed send is retried at the next stop; a sent one is not repeated', async ($, on) => {
  const seen = stubs(on)
  await $.prompt.submit({ text: msg('111'), wait: false, origin: CH })
  await $.classic.Stop(stop('FAILS'))
  await $.classic.Stop(stop('second'))
  await $.classic.Stop(stop('third'))
  expect(seen.sent).toEqual([R('111', 'FAILS'), R('111', 'second')])
})
