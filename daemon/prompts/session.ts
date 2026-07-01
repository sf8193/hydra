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

export function buildSpawnPrompt(p: PromptParams): string {
  return [
    `You are a spawned worker session. Keep the persona and identity defined in your CLAUDE.md — do NOT rename yourself after the session label. Your internal session label (for tmux/ops only) is "${p.tmuxName}". Topic: ${p.topic}`,
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
    `You are a session forked from ${p.originFrom} — keep the persona/identity from your CLAUDE.md; internal session label (tmux/ops only): "${p.tmuxName}".`,
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
    `You are a session created by handoff from ${p.originFrom} — keep the persona/identity from your CLAUDE.md; internal session label (tmux/ops only): "${p.tmuxName}". Topic: ${p.topic}`,
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
    `You are a resurrected session resuming work in an existing thread — keep the persona/identity from your CLAUDE.md; internal session label (tmux/ops only): "${p.tmuxName}".`,
    ``,
    `Your chat thread chat_id is ${p.threadId}. Your session_id is ${p.sessionId}.`,
    `Read your memory files for context.`,
    `Use fetch_messages(channel="${p.threadId}", limit=50) to read the thread history.`,
    `Reconstruct context and continue from where the previous session left off.`,
    `Post a summary of what you found and what you're picking up using reply(chat_id=${p.threadId}).`,
    `Then ${DESCRIPTION_INSTRUCTION(p.sessionId)}`,
  ].join('\n')
}
