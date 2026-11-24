import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SlackGateway } from '../slack.js'

process.stderr.write = (() => true) as any

// The gateway's two upload sites (a send's files, a new thread's files) both go through shared/slack-client.ts uploadFile:
// files.uploadV2 with the bytes and the file's name, into the thread the message goes to.
test("a send's files and a new thread's files go through files.uploadV2 into their thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-gw-files-'))
  try {
    const pdf = join(dir, 'report.pdf')
    writeFileSync(pdf, '%PDF')
    const uploads: Record<string, unknown>[] = []
    const gw = Object.create(SlackGateway.prototype) as SlackGateway
    Object.assign(gw as any, {
      app: { client: { files: { uploadV2: async (a: Record<string, unknown>) => { uploads.push(a); return { ok: true } } } } },
      throttledSend: (fn: () => unknown) => fn(),
      postMessage: async () => ({ ts: '200.000001' }),
      noteSent: () => {},
      buildMessageUrl: () => 'https://x',
    })
    await gw.send('C1:100.000001', 'see file', { files: [pdf] })
    await gw.send('C1', 'answer', { files: [pdf], replyTo: '150.000001' })
    await gw.createThread('C1', 'name', { messageId: '300.000001', files: [pdf] })
    expect(uploads.map(u => [u.channel_id, u.thread_ts, u.filename, String(u.file)])).toEqual([
      ['C1', '100.000001', 'report.pdf', '%PDF'],
      ['C1', '150.000001', 'report.pdf', '%PDF'],
      ['C1', '300.000001', 'report.pdf', '%PDF'],
    ])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
