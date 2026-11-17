// Where the files people send a session are saved, and under what limits: the one answer, for a message arriving (router.ts) and for the `download_attachment` tool.
import { INBOX_LIMITS, type InboxLimits } from '../config/write-confinement.js'
import { prepareConfinedInbox } from '../shared/confined-inbox.js'
import { INBOX_DIR } from './config.js'
import { registry } from './sessions.js'
import { isWriteConfinedSession } from './tool-surface.js'

/**
 * A write-confined session (its record says so, or its bridge declared it) reads only its own folder, and the shared inbox is under the state folder, which it is denied: its files go to
 * `<workdir>/.inbox`, which the daemon makes and checks itself (shared/confined-inbox.ts; a link or file in its place throws, and the caller says why instead of saving). A confined session
 * with no record has no folder to name, so nothing is saved for it (throws). Every other session, and none named, gets the shared inbox.
 */
export function attachmentTarget(sessionId: string | undefined): { dir: string; limits?: InboxLimits } {
  if (!sessionId || !isWriteConfinedSession(sessionId)) return { dir: INBOX_DIR }
  const w = registry.get(sessionId)?.policy?.canOnlyWriteTo
  if (!w) throw new Error('this session is write-confined but has no record to say where its files go, so nothing is saved')
  return { dir: prepareConfinedInbox(w.workdir), limits: INBOX_LIMITS }
}

/** Whether a failure to save is told to the session: a confined session is told why (a full or replaced inbox is its own folder's to fix); the shared inbox's failures stay in the log. */
export const tellsSaveFailure = (sessionId: string | undefined): boolean => !!sessionId && isWriteConfinedSession(sessionId)
