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

// A headless fork has no thread: it answers the session that spawned it, then ends.
export function buildHeadlessForkPrompt(p: PromptParams & { originFrom: string; readOnly: boolean; answerOnce?: boolean }): string {
  return [
    `You are ${p.tmuxName}, a headless${p.readOnly ? ' read-only' : ''} fork of ${p.originFrom}. You have its conversation up to here, but you are not ${p.originFrom} and you have no thread of your own.`,
    `Your session_id is ${p.sessionId}.`,
    ``,
    `Question: ${p.topic}`,
    ``,
    `Answer it from that conversation and anything you can look up${p.readOnly ? ' (Edit, Write and NotebookEdit are blocked)' : ''}.`,
    `Reply once with send_to_thread(target="parent", type="result", text="<your answer>")${p.answerOnce ? ' — you are ended once it is delivered' : ', then stop'}.`,
  ].join('\n')
}

// A deployment's arriving.md replaces the built-in arrival *behavior* — the Reception note,
// the greeting's content, and starting the Next action at once — so a local arrival
// procedure has one owner. Identity, thread ids, the handoff file, the greeting itself,
// set_description and the fork recipe are plumbing and always stay.
export function buildHandoffPrompt(p: PromptParams & { originFrom: string; artifact?: string; arrival?: string; hasPredecessor?: boolean }): string {
  const contextLine = p.artifact
    ? `Read your handoff context from \`${p.artifact}\`, then read your memory files.`
    : `Read your memory files and workstream canon for context.`
  const greet = `Send a greeting to your thread using reply(chat_id=${p.threadId}).`
  return [
    `You are ${p.tmuxName}, a session created by handoff from ${p.originFrom}. Topic: ${p.topic}`,
    ``,
    `Your chat thread chat_id is ${p.threadId}. Your session_id is ${p.sessionId}.`,
    contextLine,
    ...(p.arrival ? [p.arrival] : []),
    ...(p.hasPredecessor ? [`If a question comes up that only ${p.originFrom} can answer, ask a fork of it: spawn_session(fork_from="predecessor", headless=true, read_only=true, phase_budget="5m", topic="<question>"). Its answer arrives as a result message.`] : []),
    ...(p.arrival ? [greet] : [
      `After reading the artifact, append a "### Reception (by ${p.tmuxName})" section to the artifact file noting what oriented you immediately, what needed code verification, and what was missing.`,
      `${greet} In your greeting, include one sentence on what the previous session was working on and one sentence on where this session is heading.`,
    ]),
    `Then ${DESCRIPTION_INSTRUCTION(p.sessionId)}`,
    ...(p.arrival ? [] : [`After greeting, begin executing the Next action from the artifact immediately. Do not wait for user input unless there are critical questions that need the user's answer.`]),
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
