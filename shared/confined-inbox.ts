// The inbox of a write-confined specialist: `<workdir>/.inbox`, in its own readable folder (the shared inbox under the state folder is denied to it).
// The daemon writes here with the operator's authority, and the specialist can write here too, so everything found here is untrusted: a link or a plain
// file where the folder should be is refused, the sender's file name is never used as a path (and an extension that something might act on is neutralised),
// an existing name is never overwritten or followed, and a folder swapped for a link is noticed. The order matters: the file is created empty, then checked
// (the folder resolves to itself, the path still leads to the open file, the file has one name), and only then are the bytes written, into the inode that was
// checked (a later swap of the folder moves nothing). What is not closed: a swap that happens, and is undone, between the create and the check leaves one EMPTY
// file, random name, neutral extension, in the place swapped to; and a specialist that swaps the folder out, finds the new file there and hard-links it into the
// real folder in the microseconds between the last check and the first write would receive the sender's bytes in that place (each needs a specialist that swaps
// its own folder, with the right timing; never an overwrite). Closing both needs openat, which Node and Bun do not expose. Making the daemon the folder's only
// writer with Claude Code's `sandbox.filesystem.denyWrite` works against the shell but also stops the specialist clearing a full folder
// (write-confinement-inbox.live.test.ts), so it is not used.
import { randomBytes } from 'crypto'
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'fs'
import { join } from 'path'
import { INBOX_DIR_NAME, INBOX_LIMITS, type InboxLimits } from '../config/write-confinement.js'

/** Test seams: the random part and stamp of a name, the write of the bytes, and the points where a session's background shell would swap the folder: before the folder is opened, before the file is created, after it is created, after the check. */
export const inboxHooks = { rand: (): string => randomBytes(4).toString('hex'), stamp: (): string => String(Date.now()), beforeOpenDir: (): void => {}, beforeCreate: (): void => {}, afterCreate: (): void => {}, afterCheck: (): void => {}, write: (fd: number, data: Uint8Array, at: number): number => writeSync(fd, data, at, data.length - at) }

/** The inbox folder of a workdir, made (0700) if absent, or brought to 0700 if it is the daemon's to: refused (thrown) when it is a link or anything but a folder. Returns its resolved path. */
export function prepareConfinedInbox(workdir: string): string {
  const root = realpathSync(workdir)
  const dir = join(root, INBOX_DIR_NAME)
  let st
  try { st = lstatSync(dir) } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    try { mkdirSync(dir, { mode: 0o700 }) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
    st = lstatSync(dir)
  }
  if (!st.isDirectory()) throw new Error(`${dir} is not a plain folder (a link or a file is there): the daemon will not save attachments through it; remove it`)
  // Opened without following, then changed by descriptor: the mode lands on the folder that was checked, never on a link's target.
  inboxHooks.beforeOpenDir()
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const open = fstatSync(fd)
    if (open.ino !== st.ino || open.dev !== st.dev) throw new Error(`${dir} changed while it was checked`)
    fchmodSync(fd, 0o700)
  } finally { closeSync(fd) }
  return dir
}

/**
 * For a write-confined specialist's inbox, extensions kept as the sender wrote them: documents, images, audio, video, text, source, data and archives, which a session reads by
 * extension and nothing auto-loads (the audio ones are the transcription sidecar's, pinned by a test). Any other final extension (`.plist`, `.workflow`, `.app`, `.desktop`, a
 * script that something runs...) is not kept: it is joined on with `_` and a `.dat` ends the name, so a file that lands in a folder some program acts on by extension
 * (LaunchAgents, Services, autostart) is not acted on. The shared inbox keeps the sender's extension: nothing there is in the specialist's reach.
 */
export const KEPT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'log', 'sql', 'py', 'js', 'ts', 'pdf', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'tif', 'tiff', 'bmp', 'svg', 'ogg', 'oga', 'opus', 'mp3', 'm4a', 'wav', 'webm', 'flac', 'aac', 'mp4', 'mpeg', 'mpga', 'amr', 'wma', 'mov', 'eml', 'ics', 'vcf', 'zip', 'gz', 'tar', 'tgz'])

/**
 * A sender's file name made safe to be one piece of a path (a `/` becomes `_`): no leading dots, nothing but letters, digits, dot, dash and underscore, at most 100 characters.
 * With `neutralise` (a specialist's inbox) also no extension but a kept one: any other, or none, ends in `.dat` (see above).
 */
export function inboxSafeName(raw: string, neutralise = false): string {
  let base = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'file'
  if (neutralise) {
    const dot = base.lastIndexOf('.')
    if (dot < 0) base = `${base}.dat`
    else if (!KEPT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())) base = `${base.slice(0, dot)}_${base.slice(dot + 1)}.dat`
  }
  if (base.length <= 100) return base
  const d = base.lastIndexOf('.')
  const ext = d > 0 && base.length - d <= 12 ? base.slice(d) : ''
  return base.slice(0, 100 - ext.length) + ext
}

const refuseFull = (dir: string, why: string): Error => new Error(`${dir} is full (${why}): delete files you no longer need from it, then ask for the file again`)

/** Throws when `dir` already holds the most it may (counting plain files and their sizes, one level), or `incoming` more bytes would pass it. */
function checkRoom(dir: string, incoming: number, limits: InboxLimits): void {
  const names = readdirSync(dir)
  if (names.length >= limits.maxFiles) throw refuseFull(dir, `${names.length} files`)
  let total = incoming
  for (const n of names) { try { const s = lstatSync(join(dir, n)); if (s.isFile()) total += s.size } catch { /* gone: not counted */ } }
  if (total > limits.maxTotalBytes) throw refuseFull(dir, `${Math.round(total / 1024 / 1024)} MB`)
}

/**
 * Saves `data` in `dir` as a new 0600 file and returns its path. The name is `<stamp>-<random>-<safe name>`; the open is exclusive and does not follow a link, and a name
 * already there (planted, or by chance) is skipped for the next. With `limits` (a specialist's inbox: `dir` is what `prepareConfinedInbox` returned) a file over the
 * size limit or a full folder is refused, and the folder is checked to still be that folder before and after the open. Without them (the shared inbox) the folder is made if absent.
 */
export function writeInboxFile(dir: string, name: string, data: Uint8Array, limits?: InboxLimits): string {
  if (limits) {
    if (data.length > limits.maxFileBytes) throw new Error(`attachment too large: ${(data.length / 1024 / 1024).toFixed(1)}MB, max ${limits.maxFileBytes / 1024 / 1024}MB`)
    if (realpathSync(dir) !== dir) throw new Error(`${dir} no longer leads to itself (a link was put in its place): nothing was saved`)
    checkRoom(dir, data.length, limits)
  } else mkdirSync(dir, { recursive: true })
  const safe = inboxSafeName(name, !!limits)
  for (let attempt = 0; attempt < 8; attempt++) {
    const path = join(dir, `${inboxHooks.stamp()}-${inboxHooks.rand()}-${safe}`)
    let fd: number
    inboxHooks.beforeCreate()
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw err
    }
    // Our own file is removed again only if the path still leads to it (never a file someone put there since).
    const removeOurs = (): void => { try { if (lstatSync(path).ino === fstatSync(fd).ino) unlinkSync(path) } catch { /* already gone with the folder */ } }
    try {
      inboxHooks.afterCreate()
      // The check comes before any byte: the file is empty and checked against the folder it is in, and must have one name (a second one, made in a swapped folder, would lead the bytes there); the bytes then go into that inode.
      if (limits) {
        const same = (() => { try { return realpathSync(dir) === dir && lstatSync(path).ino === fstatSync(fd).ino && fstatSync(fd).nlink === 1 } catch { return false } })()
        if (!same) throw new Error(`${dir} was replaced while the file was saved: the file was removed`)
      }
      inboxHooks.afterCheck()
      for (let at = 0; at < data.length;) at += inboxHooks.write(fd, data, at)
    } catch (err) {
      // Whatever went wrong (a swapped folder, a full disk, an I/O error), an empty or partial file is not left to count toward the folder's cap.
      removeOurs()
      throw err
    } finally { closeSync(fd) }
    return path
  }
  throw new Error(`could not find a free name in ${dir}`)
}

/** Removes files this daemon just saved in an inbox (one message's attachments, when a later one is refused), each by the exact path it returned; one already gone is not an error. */
export function discardInboxFiles(paths: readonly string[]): void {
  for (const p of paths) { try { unlinkSync(p) } catch { /* gone */ } }
}

/** The bytes of a plain file (not a link at its end, one name only, at most `max`), or throws. For a file the daemon wrote into a folder the specialist can also write to. */
export function readPlainFile(path: string, max: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink > 1) throw new Error(`${path} is not a plain file with one name`)
    if (st.size > max) throw new Error(`${path} is over ${max} bytes`)
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

/** Copies a file the daemon already holds (its own download) into a specialist's inbox, and returns the new path. */
export function placeInInbox(workdir: string, src: string, name: string, limits: InboxLimits = INBOX_LIMITS): string {
  return writeInboxFile(prepareConfinedInbox(workdir), name, readPlainFile(src, limits.maxFileBytes), limits)
}
