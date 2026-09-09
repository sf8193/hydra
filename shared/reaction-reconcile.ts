export type ExistingReaction = { emoji: string; mine: boolean }

export function planReactionReconciliation(existing: ExistingReaction[], desired: string[]): {
  remove: string[]; add: string[]
} {
  const desiredSet = new Set(desired)
  const mine = new Set(existing.filter(r => r.mine).map(r => r.emoji))
  return {
    remove: [...mine].filter(emoji => !desiredSet.has(emoji)),
    add: desired.filter(emoji => !mine.has(emoji)),
  }
}
