export function buildSummaryFormat(rounds: number, prLinks: string[]): string[] {
  const prLine = prLinks.length
    ? `- **PRs / artifacts** — ${prLinks.join(' · ')}`
    : `- **PRs / artifacts** — links, or "none"`
  return [
    `**🔨 Build Summary** (${rounds} round${rounds > 1 ? 's' : ''})`,
    `- **What was built** — one bullet per piece, each with how to think about it`,
    prLine,
    ``,
    `**Tensions** — what the critic pushed, and what changed because of it.`,
    ``,
    `**Emergences** — what nobody asked for that showed up anyway. "Nothing" if the build was routine.`,
    ``,
    `**Synthesis** — one sentence. The build in one breath.`,
    ``,
    `**What's next** — what happens now and what needs the human.`,
  ]
}
