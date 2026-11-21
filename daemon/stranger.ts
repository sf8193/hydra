// A non-operator who writes in a session thread is flagged once, and the operator's next "yes" there lets them in for that thread.
const ACK_RE = /^\s*(yes|yea|yeah|yep|ok|okay|sure|ack|acknowledged)\b/i
const awaiting = new Map<string, Set<string>>()

/** True the first time this stranger is seen in this thread since the operator last answered. */
export function flagStranger(threadId: string, senderId: string): boolean {
  const set = awaiting.get(threadId) ?? new Set<string>()
  awaiting.set(threadId, set)
  if (set.has(senderId)) return false
  set.add(senderId)
  return true
}

/** The strangers the operator's message acknowledges: all those awaiting in this thread, when it reads as a yes. */
export function acknowledged(threadId: string, operatorText: string): string[] {
  const set = awaiting.get(threadId)
  if (!set || !ACK_RE.test(operatorText)) return []
  awaiting.delete(threadId)
  return [...set]
}
