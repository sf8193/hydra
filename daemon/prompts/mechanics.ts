// Shared mechanics block — the single source for protocol-seed machinery:
// identity, orientation tooling, routing, cadence, wait discipline.
//
// Boundary rule: mechanics may name tools and timing — never content,
// and never illumination order for pool roles. A line that says what to THINK
// about is mandate and belongs in the role seed where it can be counter-steered;
// illumination order is position, and position belongs to the spec. The uniform
// read-everything-first default is correct only for singleton roles, where
// there is no pool to diversify.

export type MechanicsOpts = {
  tmuxName: string
  role: string
  protocol: string
  sessionId: string
  threadId: string
  tag?: string | ReadonlyArray<{ phase: string; tag: string }>
  cadence: 'one-message' | 'per-round' | 'per-phase'
  waits?: boolean
  cutoffTs?: string
  orient?: string
}

export function mechanicsBlock(opts: MechanicsOpts): string {
  const { tmuxName, role, protocol, sessionId, threadId, tag, cadence, waits, cutoffTs, orient } = opts

  const cadenceLine = cadence === 'one-message'
    ? 'Post exactly ONE protocol message.'
    : cadence === 'per-round'
      ? 'One protocol message per round.'
      : 'Exactly ONE protocol message per phase.'

  if (cadence === 'per-phase' && !orient) {
    throw new Error(`mechanicsBlock: pool role '${role}' requires an orient (illumination order is position)`)
  }
  const orientTail = orient
    ?? 'Read every code file, wiki article, config, or document it references before forming a view.'

  // v1 callers pass tag for sentinel-based routing; v2 uses advance()
  const speakLines = tag
    ? buildSentinelSpeakLines(threadId, tag, cadenceLine)
    : buildAdvanceSpeakLines(threadId, cadenceLine)

  return [
    `You are ${tmuxName}, the ${role} in this thread's ${protocol} run.`,
    `Your session_id is ${sessionId}.`,
    ``,
    `**Orient:** fetch_messages(channel="${threadId}", limit=100) is your window into this thread. ${orientTail}`,
    ...(cutoffTs ? [`While forming your own questions and proposal: only read messages posted BEFORE ${cutoffTs} — later messages are other roles' work, and reading them contaminates your independence. This cutoff ends if you are later asked to critique a synthesized composite: that composite is posted after the cutoff and is your assigned reading.`] : []),
    ``,
    `**If a tool call returns InputValidationError, that tool is *deferred* — its name is known but its schema is not loaded. Call ToolSearch(query="select:<tool_name>") to load it, then retry. Never abandon your protocol action because its tool errored — recover the tool and complete the action.**`,
    ``,
    ...speakLines,
    ...(waits ? [``, `**Between rounds:** after posting, stay idle and wait for the next [system] notification — it will deliver the other party's response. Do not poll the thread or exit; the protocol needs you alive for subsequent rounds.`] : []),
  ].join('\n')
}

function buildSentinelSpeakLines(threadId: string, tag: string | ReadonlyArray<{ phase: string; tag: string }>, cadenceLine: string): string[] {
  const sentinelLines = typeof tag === 'string'
    ? [`- A protocol message's FIRST LINE must be exactly \`${tag}\` — the daemon routes on the first line only. A tag anywhere else is invisible to it.`]
    : [
        `- The daemon routes on the FIRST LINE only — a tag anywhere else is invisible to it. Your first line must be exactly the tag for the phase you are in:`,
        ...tag.map(t => `  - ${t.phase}: \`${t.tag}\``),
      ]

  return [
    `**Speak:** post to the thread with reply(chat_id="${threadId}").`,
    ...sentinelLines,
    `- Untagged messages are conversational: humans see them; the protocol does not advance. Use them for questions and status, never for your deliverable.`,
    `- ${cadenceLine}`,
  ]
}

function buildAdvanceSpeakLines(threadId: string, cadenceLine: string): string[] {
  return [
    `**Speak:** Use \`reply(chat_id="${threadId}", text="...")\` for conversational messages (questions, status). Use \`advance({ content: "..." })\` for protocol deliverables — it posts to the thread AND fires the transition.`,
    `- \`reply()\` is conversational only — it never advances the protocol.`,
    `- \`advance()\` is your protocol action — content is posted and the phase advances.`,
    `- ${cadenceLine}`,
  ]
}
