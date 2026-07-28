import { mechanicsBlock } from './mechanics.js'

export function buildCriticPrompt(opts: {
  sessionId: string
  tmuxName: string
  rounds: number
  threadId: string
  task: string
  ownerCwd?: string
  implementationText?: string
}): string {
  const { sessionId, tmuxName, rounds, threadId, task, ownerCwd, implementationText } = opts

  const cwdLine = ownerCwd
    ? `\n**Builder's working directory:** \`${ownerCwd}\` — look for \`.claude/\` relative to this path and any project subdirectories within it.\n`
    : ''

  return [
    mechanicsBlock({
      tmuxName,
      role: 'critic',
      protocol: `${rounds}-round build`,
      sessionId,
      threadId,
      tag: '[critic→builder]',
      cadence: 'per-round',
      waits: true,
    }),
    ``,
    `**Task being implemented:** ${task}`,
    cwdLine,
    ``,
    `The builder has already posted their implementation. Review it now — follow these steps IN ORDER:`,
    ``,
    `**Step A — Gather the diff:**`,
    `Run \`git diff HEAD~1..HEAD\` and \`git diff HEAD~1..HEAD --name-only\` to see the latest commit's changes. If there are uncommitted changes, also run \`git diff\`. Do NOT diff against main — diff against the parent commit so you only see this build's changes, not the entire branch. Read the FULL content of every changed file and every new/changed test file. Also read any files listed in the builder's "Context files" section.`,
    ``,
    `**Step B — Run the project's review agents (MANDATORY if they exist):**`,
    `Look for \`.claude/\` in the builder's working directory AND in the subdirectory where files changed (use \`git diff --name-only\` paths to find the project root).`,
    `If \`.claude/agents/\` exists: read every agent .md file there, read \`.claude/commands/review.md\` for lane assignments, then LAUNCH the agents in parallel using the Agent tool, passing the diff. You MUST do this — do NOT skip it and review ad-hoc instead.`,
    `Also read \`.claude/rules/\` and \`.claude/skills/\` relevant to the changed files.`,
    `Filter agent output: ONLY keep Blockers and Should-fix related to correctness. Drop all Nits and style.`,
    `If no \`.claude/\` directory exists, skip this step.`,
    ``,
    `**Step C — Your own correctness review (on top of agent findings):**`,
    `- Does the code match the design intent from the thread?`,
    `- Will it break existing behavior?`,
    `- Edge cases or failure modes?`,
    `- Test coverage: do tests cover the important behavioral paths?`,
    `- Test quality: tests asserting behavior, or just mirroring implementation?`,
    `DO NOT run tests — the builder already ran them.`,
    ``,
    `**Verdict:**`,
    `- Your second line (after the \`[critic→builder]\` tag) indicates your verdict: \`**LGTM**\` (zero findings) or your findings`,
    `- **LGTM means ZERO findings.** If you have ANY actionable finding — even if the code is correct for the current ticket — do NOT say LGTM. Post the findings instead. The builder can choose to fix them or defer them.`,
    ``,
    `The owner's revision arrives as a notification. Repeat for up to ${rounds} rounds.`,
    ``,
    `**DO NOT** run tests or the test suite. **DO NOT** nitpick style, naming, or organization. Focus exclusively on correctness and test coverage. Be rigorous but fair.`,
    implementationText ? `\n---\n**Builder's implementation summary (Round 1):**\n${implementationText}` : '',
  ].filter(Boolean).join('\n')
}
