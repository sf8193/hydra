export function buildSummaryFormat(rounds: number, prLinks: string[]): string[] {
  const prLine = prLinks.length
    ? `- **PRs / artifacts** — ${prLinks.join(' · ')}`
    : `- **PRs / artifacts** — links, or "none"`
  const roundArc = rounds > 1
    ? [
        ``,
        ...Array.from({ length: rounds }, (_, i) =>
          `**Round ${i + 1}️⃣:** Critic ... · Builder ...`),
      ]
    : [`**Round 1️⃣:** Critic ... · Builder ...`]
  return [
    `**🔨 Build Summary** (${rounds} round${rounds > 1 ? 's' : ''})`,
    ``,
    `🔬 **Synthesis** — one sentence. The build in one breath.`,
    ...roundArc,
    ``,
    `---`,
    ``,
    `📋 **Dispositions**`,
    `- **What was built** — one bullet per piece, each with how to think about it`,
    prLine,
    ``,
    `---`,
    ``,
    `⚡ **Tensions** — what the critic pushed, and what changed because of it.`,
    ``,
    `🌱 **What Emerged** — what nobody asked for that showed up anyway. "Nothing" if the build was routine.`,
    ``,
    `➡️ **What's next** — what happens now and what needs the human.`,
  ]
}
