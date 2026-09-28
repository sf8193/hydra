/**
 * Voice dictation — transcribe inbound audio attachments to text.
 *
 * Hydra ingests audio (Discord voice notes, Slack audio files) the same way it
 * ingests any attachment: the gateway downloads it to the inbox. This module
 * turns those downloaded audio files into text so Claude reads the dictation as
 * a normal prompt, alongside any typed text or images.
 *
 * Transcription itself runs in a self-hosted sidecar (see transcribe-server/).
 * By default it serves NVIDIA Canary-Qwen 2.5B via NeMo — top of the Open ASR
 * leaderboard for English accuracy — but the sidecar is just an HTTP endpoint,
 * so any STT backend that speaks the same contract works.
 *
 * Contract: POST multipart/form-data with an `audio` file field to
 * HYDRA_TRANSCRIBE_URL; expect `{ "text": "..." }` back.
 *
 * Env is read lazily (not at import) so this module stays free of config.ts's
 * token-required side effects and can be unit-tested in isolation.
 */

import { stat, readFile } from 'fs/promises'
import { basename } from 'path'

import type { DownloadedFile } from '../gateway.js'

export type Transcript = { name: string; text: string }

// Extensions Discord/Slack use for voice notes and audio uploads. Discord voice
// messages arrive as audio/ogg; Slack audio clips as m4a/mp3/wav.
const AUDIO_EXTENSIONS = new Set([
  'ogg', 'oga', 'opus', 'mp3', 'm4a', 'wav', 'webm', 'flac', 'aac', 'mp4', 'mpeg', 'mpga', 'amr', 'wma',
])

// ---------------------------------------------------------------------------
// Config (lazy — env may be populated by config.ts's .env loader at runtime)
// ---------------------------------------------------------------------------

// On by default ("auto"): transcription is attempted whenever an audio
// attachment arrives. If no sidecar is running, transcribeFile's fetch fails
// fast (connection refused) and is skipped — so auto-on is safe even when
// dictation isn't set up. Set HYDRA_TRANSCRIBE_ENABLED=0 (or false/no/off) to
// opt out entirely and skip the probe.
export function transcriptionEnabled(): boolean {
  const v = process.env.HYDRA_TRANSCRIBE_ENABLED
  if (v === undefined || v.trim() === '') return true
  return !/^(0|false|no|off)$/i.test(v.trim())
}

function transcribeUrl(): string {
  return process.env.HYDRA_TRANSCRIBE_URL ?? 'http://127.0.0.1:8123/transcribe'
}

function transcribeTimeoutMs(): number {
  const n = Number(process.env.HYDRA_TRANSCRIBE_TIMEOUT_MS ?? '60000')
  return Number.isFinite(n) && n > 0 ? n : 60000
}

// Skip files above this size — long recordings blow up latency and the sidecar
// container's memory. Defaults to 25MB, matching the gateway attachment cap.
function transcribeMaxBytes(): number {
  const n = Number(process.env.HYDRA_TRANSCRIBE_MAX_BYTES ?? String(25 * 1024 * 1024))
  return Number.isFinite(n) && n > 0 ? n : 25 * 1024 * 1024
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

// Content types that don't identify the payload — only these fall through to
// the extension check. A definitive non-audio type (video/mp4, image/png) must
// NOT be re-classified by extension: mp4/webm are also video containers, and a
// screen recording is not dictation.
const GENERIC_CONTENT_TYPES = new Set(['', 'unknown', 'application/octet-stream', 'binary/octet-stream', 'application/ogg'])

/** True if a downloaded file looks like audio, by MIME type or extension. */
export function isAudioFile(file: { contentType?: string | null; name?: string | null }): boolean {
  const ct = (file.contentType ?? '').toLowerCase().split(';')[0].trim()
  if (ct.startsWith('audio/')) return true
  // Discord occasionally reports voice notes as application/ogg or octet-stream;
  // only such generic types fall back to the extension.
  if (!GENERIC_CONTENT_TYPES.has(ct)) return false
  const name = (file.name ?? '').toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return AUDIO_EXTENSIONS.has(name.slice(dot + 1))
}

/**
 * Merge voice transcripts into the message content Claude receives.
 *
 * When the user only sent audio, the transcript *becomes* the prompt. When they
 * also typed something, the transcript is appended under a clear label so Claude
 * can tell dictated speech from typed text.
 */
export function mergeTranscripts(originalContent: string, transcripts: Transcript[]): string {
  const parts = transcripts.map(t => t.text.trim()).filter(Boolean)
  if (parts.length === 0) return originalContent

  const block =
    parts.length === 1
      ? `[voice transcript] ${parts[0]}`
      : `[voice transcript]\n${parts.map(p => `- ${p}`).join('\n')}`

  const typed = originalContent.trim()
  return typed ? `${typed}\n\n${block}` : block
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** Transcribe a single audio file via the sidecar. Returns null on any failure. */
export async function transcribeFile(path: string, contentType?: string | null): Promise<string | null> {
  // Size check BEFORE reading: the cap must protect daemon memory too, and
  // gateway-reported attachment sizes aren't always present or truthful.
  let bytes: Buffer<ArrayBuffer>
  try {
    const size = (await stat(path)).size
    if (size > transcribeMaxBytes()) {
      process.stderr.write(
        `transcription: skipping ${basename(path)} — ${(size / 1024 / 1024).toFixed(1)}MB exceeds HYDRA_TRANSCRIBE_MAX_BYTES\n`,
      )
      return null
    }
    bytes = await readFile(path)
  } catch (err) {
    process.stderr.write(`transcription: cannot read ${path}: ${err}\n`)
    return null
  }

  const form = new FormData()
  form.append('audio', new Blob([bytes], { type: contentType ?? 'application/octet-stream' }), basename(path))

  try {
    const res = await fetch(transcribeUrl(), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(transcribeTimeoutMs()),
    })
    if (!res.ok) {
      process.stderr.write(`transcription: sidecar ${res.status} for ${basename(path)}\n`)
      return null
    }
    const data = (await res.json()) as { text?: unknown }
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    return text || null
  } catch (err) {
    process.stderr.write(`transcription: request failed for ${basename(path)}: ${err}\n`)
    return null
  }
}

/**
 * Transcribe every audio file among the downloaded attachments. Non-audio files
 * are ignored. Failures are skipped (logged), never thrown — a flaky sidecar
 * must not block message delivery. Audio files run concurrently.
 */
export async function transcribeDownloads(files: DownloadedFile[]): Promise<Transcript[]> {
  if (!transcriptionEnabled()) return []
  const audio = files.filter(isAudioFile)
  if (audio.length === 0) return []

  const results = await Promise.all(
    audio.map(async (f): Promise<Transcript | null> => {
      const text = await transcribeFile(f.path, f.contentType)
      return text ? { name: f.name, text } : null
    }),
  )
  return results.filter((t): t is Transcript => t !== null)
}
