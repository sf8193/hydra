import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MessagePayload } from 'discord.js'
import { fenceArt, formatDiscordText, shapeDiscordOutbound } from '../discord-format.js'
import { DiscordGateway } from '../discord.js'
import type { Outbound } from '../gateway.js'

const TABLE = '| Name | PR |\n|---|---|\n| fix | [#12](https://example.com/12) |'
const BLOCK = '```\nName  PR\n' + '─'.repeat(35) + '\nfix   [#12](https://example.com/12)\n```'

// A renderer that writes a stand-in file where sips would put the PNG, and one that fails as sips can.
const fakeDraw = { available: () => true, draw: async (_t: unknown, png: string) => { writeFileSync(png, 'png') } }
const failing = { available: () => true, draw: async () => { throw new Error('sips exited 13: Error: Cannot extract image from file.') } }

describe('fenceArt', () => {
  test('a run of two or more box-art lines is fenced', () => {
    expect(fenceArt('hi\n┌─┐\n└─┘\nbye')).toBe('hi\n```\n┌─┐\n└─┘\n```\nbye')
    expect(fenceArt('+--+\n| a |\n+--+')).toBe('```\n+--+\n| a |\n+--+\n```')
  })

  test('one art line alone keeps reading as text: a status tree line with its link', () => {
    const status = 'parent\n\n├─ [child](https://e.com/1)\n\n└─ [other](https://e.com/2)'
    expect(fenceArt(status)).toBe(status)
  })

  test('code is left alone, whichever fence', () => {
    for (const t of ['```\n┌─┐\n└─┘\n```', '~~~\n| a |\n| b |\n~~~', '````md\n```\n| a |\n| b |\n```\n````']) expect(fenceArt(t)).toBe(t)
  })
})

describe('formatDiscordText (what an edit shows)', () => {
  test('a table becomes an aligned code block in its own place; the text around it stays', () => {
    expect(formatDiscordText(`Status:\n${TABLE}\nDone.`)).toBe(`Status:\n${BLOCK}\nDone.`)
  })
})

describe('shapeDiscordOutbound', () => {
  test('a table is drawn and attached, its links left where it stood; the folder lasts as long as the send', async () => {
    let seen: Outbound | undefined
    let existedDuringPost = false
    await shapeDiscordOutbound(`Status:\n${TABLE}\nDone.`, 10, async out => {
      seen = out
      existedDuringPost = out.files.every(f => existsSync(f))
    }, fakeDraw)
    expect(seen!.text).toBe('Status:\n[#12](https://example.com/12)\nDone.')
    expect(seen!.files).toHaveLength(1)
    expect(seen!.files[0]).toMatch(/hydra-tables-.*\/table-1\.png$/)
    expect(existedDuringPost).toBe(true)
    expect(existsSync(seen!.files[0])).toBe(false)
  })

  test('the files are removed when the send fails too', async () => {
    let files: string[] = []
    await expect(shapeDiscordOutbound(TABLE, 10, async out => { files = out.files; throw new Error('send failed') }, fakeDraw)).rejects.toThrow('send failed')
    expect(files).toHaveLength(1)
    expect(existsSync(files[0])).toBe(false)
  })

  test('a reply that was only a table is a picture with empty text', async () => {
    let seen: Outbound | undefined
    await shapeDiscordOutbound('| a | b |\n|---|---|\n| 1 | 2 |', 10, async out => { seen = out }, fakeDraw)
    expect(seen!.text).toBe('')
    expect(seen!.files).toHaveLength(1)
  })

  test('a failed drawing leaves that table a code block and says why on stderr', async () => {
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true)
    let seen: Outbound | undefined
    await shapeDiscordOutbound(TABLE, 10, async out => { seen = out }, failing)
    expect(seen).toEqual({ text: BLOCK, files: [] })
    expect(err.mock.calls.map(c => String(c[0]))).toContain('discord: table 1 sent as a code block: sips exited 13: Error: Cannot extract image from file.\n')
    err.mockRestore()
  })

  test('no room (an edit, or a message already carrying ten files): code blocks, nothing drawn', async () => {
    let drew = 0
    let seen: Outbound | undefined
    await shapeDiscordOutbound(TABLE, 0, async out => { seen = out }, { available: () => true, draw: async () => { drew++ } })
    expect(seen).toEqual({ text: BLOCK, files: [] })
    expect(drew).toBe(0)
  })

  test('tables past the room left stay code blocks, in their own places', async () => {
    let seen: Outbound | undefined
    await shapeDiscordOutbound(`${TABLE}\n\n${TABLE}`, 1, async out => { seen = out }, fakeDraw)
    expect(seen!.files).toHaveLength(1)
    expect(seen!.text).toBe(`[#12](https://example.com/12)\n\n${BLOCK}`)
  })

  test('box art beside a table is still fenced', async () => {
    let seen: Outbound | undefined
    await shapeDiscordOutbound(`┌─┐\n└─┘\n${TABLE}`, 10, async out => { seen = out }, fakeDraw)
    expect(seen!.text).toBe('```\n┌─┐\n└─┘\n```\n[#12](https://example.com/12)')
  })
})

test('without sips, tables go as code blocks', async () => {
  const err = spyOn(process.stderr, 'write').mockImplementation(() => true)
  let seen: Outbound | undefined
  await shapeDiscordOutbound(TABLE, 10, async out => { seen = out }, { available: () => false, draw: fakeDraw.draw })
  expect(seen).toEqual({ text: BLOCK, files: [] })
  err.mockRestore()
})

describe('DiscordGateway.shapeOutbound', () => {
  test('is the Discord shaper: with no room, a table comes back a code block', async () => {
    const gw = new DiscordGateway({ heartbeatPath: null })
    let seen: Outbound | undefined
    await gw.shapeOutbound(TABLE, 0, async out => { seen = out })
    expect(seen).toEqual({ text: BLOCK, files: [] })
    expect(gw.maxAttachments).toBe(10)
  })
})

describe('DiscordGateway.send', () => {
  test('a message that is only attachments sends no content: a body Discord takes (files alone are a valid message)', async () => {
    const gw = new DiscordGateway({ heartbeatPath: null }) as any
    const client = gw.client
    let payload: any
    gw.fetchTextChannel = async () => ({ id: 'c', send: async (p: any) => { payload = p; return { id: 'm1' } } })
    const file = join(mkdtempSync(join(tmpdir(), 'discord-format-test-')), 't.png')
    writeFileSync(file, 'png')
    await gw.send('c', '', { files: [file] })
    expect('content' in payload).toBe(false)
    const { body, files } = await MessagePayload.create({ client } as any, payload).resolveBody().resolveFiles()
    expect((body as any).content).toBeUndefined()
    expect(files).toHaveLength(1)
    expect((body as any).attachments).toHaveLength(1)
  })
})
