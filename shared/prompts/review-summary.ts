export function reviewSummaryFormat(rounds: number): string[] {
  const roundArc = rounds > 1
    ? [
        ``,
        ...Array.from({ length: rounds }, (_, i) =>
          `**Round ${i + 1}️⃣:** Critic ... · Owner ...`),
      ]
    : [`**Round 1️⃣:** Critic ... · Owner ...`]
  return [
    `**⚔️ Review Summary** (${rounds} round${rounds > 1 ? 's' : ''})`,
    ``,
    `🔬 **Synthesis** — one sentence. The review in one breath.`,
    ...roundArc,
    ``,
    `---`,
    ``,
    `📋 **Dispositions**`,
    `- ✅ issue — fixed/will fix`,
    `- ⚠️ issue — acknowledged, deferred`,
    `- ❌ issue — rebutted`,
    ``,
    `---`,
    ``,
    `⚡ **Tensions** — what was actually contested, not just flagged. Name the disagreement and who moved.`,
    ``,
    `🌱 **What Emerged** — what nobody asked for that showed up anyway. "Nothing" if the review was routine.`,
    ``,
    `➡️ **What's next** — what happens now and what needs the human.`,
  ]
}
