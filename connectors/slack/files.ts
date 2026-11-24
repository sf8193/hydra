// Files in and out of Slack, through one app's bot: the download of a file a message carries, and the files a specialist's reply attaches,
// uploaded as the gateway uploads its own (shared/slack-client.ts uploadFile).
import { mkdirSync, openSync, writeSync, closeSync, renameSync, rmSync, readFileSync, statSync } from 'fs'
import { basename, dirname, isAbsolute } from 'path'
import { assertSendable } from '../../infra/util.js'
import { uploadFile } from '../../shared/slack-client.js'
import { MAX_ATTACHMENT_BYTES } from '../../shared/constants.js'
import type { WebClient } from '@slack/web-api'

/** At most this many files on one reply (as many as the Slack gateway attaches to a message), each at most the attachment limit every send holds to. */
export const UPLOAD_MAX_FILES = 10
const UPLOAD_MAX_BYTES = MAX_ATTACHMENT_BYTES

/** Only Slack's own hosts ever get the bot token or a file's bytes, including across redirects. */
const slackHost = (u: string) => { try { const h = new URL(u); return h.protocol === 'https:' && (h.hostname === 'slack.com' || h.hostname.endsWith('.slack.com')) } catch { return false } }

/** A file's bytes, from a Slack file URL to `dest` at mode 0600 (its directory 0700). Throws past `maxBytes`. */
export async function downloadSlackFile(botToken: string, url: string, dest: string, maxBytes: number): Promise<void> {
  let res: Response | undefined
  for (let hop = 0; hop < 3; hop++) {
    if (!slackHost(url)) throw new Error('not a Slack file URL')
    res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` }, redirect: 'manual', signal: AbortSignal.timeout(60_000) })
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!next) break
    url = new URL(next, url).toString()
  }
  if (!res?.ok || !res.body) throw new Error(`HTTP ${res?.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new Error(`over ${maxBytes / 1024 / 1024} MB`)
  // Without files:read Slack answers with its login page, not an error. Saving that under the file's name would be a quiet lie.
  if (/^text\/html/i.test(res.headers.get('content-type') ?? '') && !/\.html?$/i.test(dest)) throw new Error('Slack sent a web page instead of the file; does the bot token have files:read?')
  // Streamed to disk, never held whole; a partial file never takes the real name.
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
  const part = `${dest}.part`
  const fd = openSync(part, 'w', 0o600)
  try {
    let size = 0
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length
      if (size > maxBytes) throw new Error(`over ${maxBytes / 1024 / 1024} MB`)
      writeSync(fd, chunk)
    }
    closeSync(fd)
    renameSync(part, dest)
  } catch (err) {
    try { closeSync(fd) } catch {}
    rmSync(part, { force: true })
    throw err
  }
}

/** One file a reply attaches, checked: an absolute path to a plain file, its name as Slack shows it, and its size. */
export type Upload = { path: string; name: string; size: number }

/**
 * The files a reply attaches, checked before anything is posted, or why not. A write-confined session's paths have already been checked against what it may read
 * and swapped for daemon-owned copies (app/bridge-dispatch.ts); a restricted session attaches none. What is left to hold here is what any session may send:
 * a plain file, never hydra's own state (assertSendable), at most UPLOAD_MAX_FILES of them, each at most UPLOAD_MAX_BYTES.
 */
export function checkUploads(files: readonly string[]): Upload[] {
  if (files.length > UPLOAD_MAX_FILES) throw new Error(`nothing was posted: ${files.length} files is over the ${UPLOAD_MAX_FILES} a Slack reply may attach`)
  return files.map(f => {
    if (!isAbsolute(f)) throw new Error(`nothing was posted: ${f} is not an absolute path`)
    assertSendable(f)
    let st
    try { st = statSync(f) } catch { throw new Error(`nothing was posted: ${f} cannot be read`) }
    if (!st.isFile()) throw new Error(`nothing was posted: ${f} is not a file`)
    if (st.size > UPLOAD_MAX_BYTES) throw new Error(`nothing was posted: ${f} is ${(st.size / 1024 / 1024).toFixed(1)} MB, over the ${UPLOAD_MAX_BYTES / 1024 / 1024} MB a Slack reply may attach`)
    return { path: f, name: basename(f), size: st.size }
  })
}

/** How each file of a reply ended: shared into the conversation, or why not, in one line. */
export type UploadResult = { shared: string[]; failed: { name: string; why: string }[] }

const why = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0]!

/**
 * Uploads `files` one by one into `channel` (in `threadTs`'s thread when given). One that fails is listed with why, in one line, and the rest still go.
 * Nothing is retried: a retry after an unknown outcome could share a file twice.
 */
export async function uploadSlackFiles(client: Pick<WebClient, 'files'>, channel: string, threadTs: string | undefined, files: readonly Upload[]): Promise<UploadResult> {
  const out: UploadResult = { shared: [], failed: [] }
  for (const f of files) {
    try {
      const bytes = readFileSync(f.path)
      if (bytes.length > UPLOAD_MAX_BYTES) throw new Error(`it grew past ${UPLOAD_MAX_BYTES / 1024 / 1024} MB after it was checked`)
      await uploadFile(client, channel, threadTs, bytes, f.name)
      out.shared.push(f.name)
    } catch (err) {
      const w = why(err)
      out.failed.push({ name: f.name, why: /missing_scope/.test(w) ? `${w} (the app needs the files:write bot scope)` : w })
    }
  }
  return out
}

/** The result's line for the files: what was shared, and each failure with why. */
export function uploadLine(r: UploadResult): string {
  const parts: string[] = []
  if (r.shared.length) parts.push(`attached ${r.shared.length} file${r.shared.length === 1 ? '' : 's'} (${r.shared.join(', ')})`)
  for (const f of r.failed) parts.push(`${f.name} did not attach: ${f.why}`)
  return parts.join('; ')
}
