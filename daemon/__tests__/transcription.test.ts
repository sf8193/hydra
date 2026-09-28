import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { isAudioFile, mergeTranscripts, transcriptionEnabled, transcribeDownloads } from '../transcription.js'

describe('isAudioFile', () => {
  test('detects audio by MIME type', () => {
    expect(isAudioFile({ contentType: 'audio/ogg', name: 'voice-message.ogg' })).toBe(true)
    expect(isAudioFile({ contentType: 'audio/mpeg', name: 'clip' })).toBe(true)
    expect(isAudioFile({ contentType: 'AUDIO/WAV', name: 'x' })).toBe(true)
  })

  test('detects Slack audio shapes', () => {
    // Slack voice clips (mic button) arrive as files with mimetype audio/mp4
    expect(isAudioFile({ contentType: 'audio/mp4', name: 'audio_message.m4a' })).toBe(true)
    // browser-recorded clips carry a codec suffix
    expect(isAudioFile({ contentType: 'audio/webm;codecs=opus', name: 'audio_message.webm' })).toBe(true)
    // uploaded files can come through with a generic mimetype — extension wins
    expect(isAudioFile({ contentType: 'application/octet-stream', name: 'standup.mp3' })).toBe(true)
  })

  test('detects audio by extension when MIME is generic', () => {
    expect(isAudioFile({ contentType: 'application/octet-stream', name: 'note.opus' })).toBe(true)
    expect(isAudioFile({ contentType: null, name: 'recording.m4a' })).toBe(true)
    expect(isAudioFile({ contentType: 'application/ogg', name: 'voice.ogg' })).toBe(true)
    expect(isAudioFile({ contentType: 'unknown', name: 'note.wav' })).toBe(true)
  })

  test('a definitive non-audio MIME is not re-classified by extension', () => {
    // mp4/webm are video containers too — a screen recording is not dictation
    expect(isAudioFile({ contentType: 'video/mp4', name: 'screen-recording.mp4' })).toBe(false)
    expect(isAudioFile({ contentType: 'video/webm', name: 'demo.webm' })).toBe(false)
    expect(isAudioFile({ contentType: 'image/png', name: 'weird-name.mp3.png' })).toBe(false)
  })

  test('rejects non-audio files', () => {
    expect(isAudioFile({ contentType: 'image/png', name: 'screenshot.png' })).toBe(false)
    expect(isAudioFile({ contentType: 'text/plain', name: 'notes.txt' })).toBe(false)
    expect(isAudioFile({ contentType: null, name: 'noext' })).toBe(false)
    expect(isAudioFile({ contentType: null, name: '' })).toBe(false)
  })
})

describe('mergeTranscripts', () => {
  test('transcript becomes the prompt when no typed content', () => {
    const out = mergeTranscripts('', [{ name: 'a.ogg', text: 'hello world' }])
    expect(out).toBe('[voice transcript] hello world')
  })

  test('appends transcript under a label when there is typed content', () => {
    const out = mergeTranscripts('see this', [{ name: 'a.ogg', text: 'and listen' }])
    expect(out).toBe('see this\n\n[voice transcript] and listen')
  })

  test('lists multiple transcripts as bullets', () => {
    const out = mergeTranscripts('', [
      { name: 'a.ogg', text: 'first' },
      { name: 'b.ogg', text: 'second' },
    ])
    expect(out).toBe('[voice transcript]\n- first\n- second')
  })

  test('ignores empty/whitespace transcripts', () => {
    expect(mergeTranscripts('typed', [{ name: 'a.ogg', text: '   ' }])).toBe('typed')
    expect(mergeTranscripts('', [])).toBe('')
  })

  test('trims surrounding whitespace on transcript text', () => {
    const out = mergeTranscripts('', [{ name: 'a.ogg', text: '  spoken  ' }])
    expect(out).toBe('[voice transcript] spoken')
  })
})

// Save/restore env around every test in the env-sensitive suites — a describe
// body runs at collection time, so restore logic there never guards anything.
let prevEnabled: string | undefined
let prevMaxBytes: string | undefined
const saveEnv = () => {
  prevEnabled = process.env.HYDRA_TRANSCRIBE_ENABLED
  prevMaxBytes = process.env.HYDRA_TRANSCRIBE_MAX_BYTES
}
const restoreEnv = () => {
  if (prevEnabled === undefined) delete process.env.HYDRA_TRANSCRIBE_ENABLED
  else process.env.HYDRA_TRANSCRIBE_ENABLED = prevEnabled
  if (prevMaxBytes === undefined) delete process.env.HYDRA_TRANSCRIBE_MAX_BYTES
  else process.env.HYDRA_TRANSCRIBE_MAX_BYTES = prevMaxBytes
}

describe('transcriptionEnabled', () => {
  beforeEach(saveEnv)
  afterEach(restoreEnv)

  test('on by default (unset or blank)', () => {
    delete process.env.HYDRA_TRANSCRIBE_ENABLED
    expect(transcriptionEnabled()).toBe(true)
    process.env.HYDRA_TRANSCRIBE_ENABLED = ''
    expect(transcriptionEnabled()).toBe(true)
    process.env.HYDRA_TRANSCRIBE_ENABLED = '  '
    expect(transcriptionEnabled()).toBe(true)
  })

  test('explicit opt-out values turn it off', () => {
    for (const v of ['0', 'false', 'no', 'off', 'OFF']) {
      process.env.HYDRA_TRANSCRIBE_ENABLED = v
      expect(transcriptionEnabled()).toBe(false)
    }
  })

  test('any other value keeps it on', () => {
    for (const v of ['1', 'true', 'yes', 'on']) {
      process.env.HYDRA_TRANSCRIBE_ENABLED = v
      expect(transcriptionEnabled()).toBe(true)
    }
  })
})

describe('transcribeDownloads', () => {
  // DownloadedFile as slack-gateway.ts downloadAttachments() produces it
  const dir = mkdtempSync(join(tmpdir(), 'hydra-transcribe-test-'))
  const audioPath = join(dir, 'audio_message.m4a')
  const imagePath = join(dir, 'screenshot.png')
  writeFileSync(audioPath, 'fake-audio')
  writeFileSync(imagePath, 'fake-image')
  const voiceClip = { path: audioPath, name: 'audio_message.m4a', contentType: 'audio/mp4', sizeKB: '1' }
  const image = { path: imagePath, name: 'screenshot.png', contentType: 'image/png', sizeKB: '1' }

  const realFetch = globalThis.fetch
  beforeEach(saveEnv)
  afterEach(() => {
    restoreEnv()
    globalThis.fetch = realFetch
  })

  test('posts only audio files to the sidecar and returns transcripts', async () => {
    process.env.HYDRA_TRANSCRIBE_ENABLED = '1'
    const posted: string[] = []
    globalThis.fetch = (async (_url: any, init: any) => {
      const audio = (init.body as FormData).get('audio') as File
      posted.push(audio.name)
      return new Response(JSON.stringify({ text: 'dictated words' }), { status: 200 })
    }) as any
    const out = await transcribeDownloads([voiceClip, image] as any)
    expect(posted).toEqual(['audio_message.m4a'])
    expect(out).toEqual([{ name: 'audio_message.m4a', text: 'dictated words' }])
  })

  test('sidecar failure skips the file instead of throwing', async () => {
    process.env.HYDRA_TRANSCRIBE_ENABLED = '1'
    globalThis.fetch = (async () => { throw new Error('connection refused') }) as any
    expect(await transcribeDownloads([voiceClip] as any)).toEqual([])
  })

  test('files above HYDRA_TRANSCRIBE_MAX_BYTES are skipped before the network', async () => {
    process.env.HYDRA_TRANSCRIBE_ENABLED = '1'
    process.env.HYDRA_TRANSCRIBE_MAX_BYTES = '4' // audio file is 10 bytes
    let calls = 0
    globalThis.fetch = (async () => { calls++; throw new Error('should not be called') }) as any
    expect(await transcribeDownloads([voiceClip] as any)).toEqual([])
    expect(calls).toBe(0)
  })

  test('disabled flag short-circuits without touching the network', async () => {
    process.env.HYDRA_TRANSCRIBE_ENABLED = '0'
    let calls = 0
    globalThis.fetch = (async () => { calls++; throw new Error('should not be called') }) as any
    expect(await transcribeDownloads([voiceClip] as any)).toEqual([])
    expect(calls).toBe(0)
  })
})
