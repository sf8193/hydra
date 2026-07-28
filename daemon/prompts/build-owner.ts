export function buildOwnerPrompt(opts: {
  rounds: number
  task?: string
  buildId: string
  worktreePath?: string
}): string {
  const { rounds, task, buildId, worktreePath } = opts

  const commitInstructions = worktreePath
    ? [
        `2. All work MUST be done in the worktree at \`${worktreePath}\`. Use absolute paths to this directory for all file operations.`,
        `3. Commit your changes in the worktree. Follow the project's CLAUDE.md/CLAUDE.local.md for git workflow conventions (e.g. graphite vs raw git).`,
      ]
    : [
        `2. Run the tests for your changed files. Do NOT post your summary until tests pass.`,
        `3. Commit your changes to a branch. Follow the project's CLAUDE.md/CLAUDE.local.md for git workflow conventions (e.g. graphite vs raw git). If no convention exists, use \`git checkout -b build/${buildId} && git add -A && git commit -m "build: <summary>"\`.`,
      ]

  return [
    `[system] Build mode activated (${rounds} rounds).`,
    `Implement your design now. Focus on working, correct code with behavioral tests.`,
    task ? `Task: ${task}` : '',
    worktreePath ? `**Worktree:** \`${worktreePath}\` — all code changes go here, NOT the main working tree.` : '',
    ``,
    `**Workflow:**`,
    `1. Implement the code and write behavioral tests.`,
    ...commitInstructions,
    `4. Post your implementation summary to the thread.`,
    ``,
    `**Message routing — READ CAREFULLY:**`,
    `- To send your implementation summary to the critic, your first line MUST be exactly: \`[builder→critic]\``,
    `- To talk to the human (questions, status updates), just post normally WITHOUT the tag`,
    `- Only tagged messages trigger the review cycle. Untagged messages are conversational.`,
    ``,
    `**Your summary (after the [builder→critic] tag) MUST include:**`,
    `1. What you implemented and why`,
    `2. \`git diff --stat\` output showing the scope of changes`,
    `3. **Context files** — every file, wiki article, or document you referenced during design that informed your implementation. The critic reads these to get the same context you had.`,
    `4. Test results (which tests you ran and that they pass)`,
    ``,
    `Address the critic's feedback in subsequent rounds. Commit and re-run tests before each summary.`,
  ].filter(Boolean).join('\n')
}
