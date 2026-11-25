// A non-operator who writes in a session thread is flagged once. The operator's 👍 on hydra's prompt lets them in for
// that thread; 👎 leaves them ignored. The reaction names the prompt, so no other message can answer it.
const flagged = new Map<string, Set<string>>()
const prompts = new Map<string, { threadId: string; senderId: string }>()

/** True the first time this stranger is seen in this thread. */
export function flagStranger(threadId: string, senderId: string): boolean {
  const set = flagged.get(threadId) ?? new Set<string>()
  flagged.set(threadId, set)
  if (set.has(senderId)) return false
  set.add(senderId)
  return true
}

/** Record the prompt hydra posted about this stranger. */
export function notePrompt(messageId: string, threadId: string, senderId: string): void {
  prompts.set(messageId, { threadId, senderId })
}

/** The stranger a reaction on this message decides, or undefined if it is not a prompt. A 👍 clears the flag so the stranger is flagged again if later removed. */
export function decide(messageId: string, admit: boolean): { threadId: string; senderId: string } | undefined {
  const p = prompts.get(messageId)
  if (!p) return undefined
  prompts.delete(messageId)
  if (admit) flagged.get(p.threadId)?.delete(p.senderId)
  return p
}
