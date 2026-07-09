export function reviewSummaryFormat(rounds: number): string[] {
  return [
    `**⚔️ Review Summary** (${rounds} round${rounds > 1 ? 's' : ''})`,
    `- ✅ issue — fixed/will fix`,
    `- ⚠️ issue — acknowledged, deferred`,
    `- ❌ issue — rebutted`,
    ``,
    `**Tensions** — what was actually contested, not just flagged. Name the disagreement and who moved.`,
    ``,
    `**Emergences** — what nobody asked for that showed up anyway. "Nothing" if the review was routine.`,
    ``,
    `**Synthesis** — one sentence. The review in one breath.`,
    ``,
    `**What's next** — what happens now and what needs the human.`,
  ]
}
