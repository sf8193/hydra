import { HYDRA_DEV_PREFIX } from '../../shared/constants.js'

// ---------------------------------------------------------------------------
// Session prompt builders — behavioral contracts for each spawn type.
//
// Each function returns the initial prompt string injected into the Claude
// session. Edit these to change how sessions orient, greet, and describe
// themselves. No side effects — pure string construction.
// ---------------------------------------------------------------------------

type PromptParams = {
  sessionId: string
  tmuxName: string
  threadId: string
  topic: string
}

export const DESCRIPTION_INSTRUCTION = (sessionId: string) =>
  `call set_description(session_id="${sessionId}", description="...") to name this thread. ` +
  `Lead with the domain if one is clear. 5 words max. ` +
  `Rewrite it whenever your focus shifts — the thread name updates live.`

export const LOCAL_STACK_INSTRUCTION = (tmuxName: string, worktreePath: string) =>
  [
    `RUNNING A LOCAL STACK: if your task needs a dev server, watcher, or build daemon running — typically full-stack work with a frontend — never start it in the foreground. Its output streams into your context and across the bridge for as long as the process lives.`,
    `Start each one detached in its own tmux session, named for the process, logging to a file:`,
    `  tmux new-session -d -s ${HYDRA_DEV_PREFIX}${tmuxName}-<label> "cd ${worktreePath} && <command> 2>&1 | tee /tmp/${HYDRA_DEV_PREFIX}${tmuxName}-<label>.log"`,
    `One tmux session per process — reusing a name fails with "duplicate session" and truncates the log. Pick a distinct <label> per process (app, graph, watch).`,
    `Check it came up by polling its port. For a watcher or anything else with no port, take a single bounded read of the last 40 lines instead — never tail or follow. Either way, 40 lines is the ceiling, and you only re-read when something looks wrong. Prefer quiet flags when output must come back in-band (turbo --output-logs=errors-only, vitest --reporter=dot).`,
    `Detached tmux is preferred over Bash(run_in_background) here because it survives your own restart and hydra reaps it when your session ends. If you do use run_in_background, do not poll its output on a loop.`,
    `Run \`tmux kill-session -t ${HYDRA_DEV_PREFIX}${tmuxName}-<label>\` when you no longer need it.`,
  ].join('\n')

export function buildWorktreePromptAppend(isFork: boolean, worktreePath: string | undefined, tmuxName: string): string {
  if (!worktreePath) return ''
  const parts: string[] = []
  if (isFork) parts.push(`WORKTREE: Your isolated worktree is at ${worktreePath}. cd there before making any code changes.`)
  parts.push(LOCAL_STACK_INSTRUCTION(tmuxName, worktreePath))
  return `\n\n${parts.join('\n\n')}`
}

export function buildSpawnPrompt(p: PromptParams): string {
  return [
    `You are ${p.tmuxName}, a spawned session. Topic: ${p.topic}`,
    ``,
    `Your chat thread chat_id is ${p.threadId}. Your session_id is ${p.sessionId}.`,
    `Read your memory files for context.`,
    `To read prior conversation in your thread, use fetch_messages(channel="${p.threadId}") — this is your thread's history. Do NOT fetch from the parent channel ID alone, only from your full thread chat_id.`,
    `Send a greeting to your thread using reply(chat_id=${p.threadId}).`,
    `After orienting, ${DESCRIPTION_INSTRUCTION(p.sessionId)}`,
  ].join('\n')
}

export function buildForkPrompt(p: PromptParams & { originFrom: string }): string {
  return [
    `You are ${p.tmuxName}, forked from ${p.originFrom}.`,
    `Topic: ${p.topic}`,
    ``,
    `Your new thread chat_id is ${p.threadId}. Your session_id is ${p.sessionId}.`,
    `Greet your new thread using reply(chat_id=${p.threadId}).`,
    `Mention you were forked from **${p.originFrom}** and describe your focus.`,
    `Then ${DESCRIPTION_INSTRUCTION(p.sessionId)}`,
  ].join('\n')
}

export function buildHandoffPrompt(p: PromptParams & { originFrom: string; artifact?: string }): string {
  const contextLine = p.artifact
    ? `Read your handoff context from \`${p.artifact}\`, then read your memory files.`
    : `Read your memory files and workstream canon for context.`
  return [
    `You are ${p.tmuxName}, a session created by handoff from ${p.originFrom}. Topic: ${p.topic}`,
    ``,
    `Your chat thread chat_id is ${p.threadId}. Your session_id is ${p.sessionId}.`,
    contextLine,
    `After reading the artifact, append a "### Reception (by ${p.tmuxName})" section to the artifact file noting what oriented you immediately, what needed code verification, and what was missing.`,
    `Send a greeting to your thread using reply(chat_id=${p.threadId}). In your greeting, include one sentence on what the previous session was working on and one sentence on where this session is heading.`,
    `Then ${DESCRIPTION_INSTRUCTION(p.sessionId)}`,
    `After greeting, begin executing the Next action from the artifact immediately. Do not wait for user input unless there are critical questions that need the user's answer.`,
  ].join('\n')
}

export function buildResurrectPrompt(p: PromptParams): string {
  return [
    `You are ${p.tmuxName}, a resurrected session resuming work in an existing thread.`,
    ``,
    `Your chat thread chat_id is ${p.threadId}. Your session_id is ${p.sessionId}.`,
    `Read your memory files for context.`,
    `Use fetch_messages(channel="${p.threadId}", limit=50) to read the thread history.`,
    `Reconstruct context and continue from where the previous session left off.`,
    `Post a summary of what you found and what you're picking up using reply(chat_id=${p.threadId}).`,
    `Then ${DESCRIPTION_INSTRUCTION(p.sessionId)}`,
  ].join('\n')
}
