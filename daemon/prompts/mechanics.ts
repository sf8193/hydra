// Shared mechanics block — the single source for protocol-seed machinery:
// identity, orientation tooling, sentinel routing, cadence, wait discipline.
//
// Boundary rule: mechanics may name tools, tags, and timing — never content,
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
                                       // deliverable sentinel, e.g. '[subtractor→thread]'; roles
                                       // routed on different tags per phase pass the full grammar —
                                       // a seed must never carry two contradictory first-line rules.
                                       // Omit for decide-only roles with no sentinel routing.
  cadence: 'one-message' | 'per-round' | 'per-phase'
  waits?: boolean                      // roles that wait for [system] notifications between posts
  cutoffTs?: string                    // pool roles reading a shared thread independently
  orient?: string                      // pool roles supply their region's reading order; omit for
                                       // singleton roles to get uniform complete illumination
}

export function mechanicsBlock(opts: MechanicsOpts): string {
  const { tmuxName, role, protocol, sessionId, threadId, tag, cadence, waits, cutoffTs, orient } = opts

  const cadenceLine = cadence === 'one-message'
    ? 'Post exactly ONE protocol message.'
    : cadence === 'per-round'
      ? 'One protocol message per round.'
      : 'Exactly ONE protocol message per phase.'

  // Pool roles (per-phase cadence) must position themselves — uniform illumination
  // is the amplification precondition; the default is singleton-only by contract.
  if (cadence === 'per-phase' && !orient) {
    throw new Error(`mechanicsBlock: pool role '${role}' requires an orient (illumination order is position)`)
  }
  const orientTail = orient
    ?? 'Read every code file, wiki article, config, or document it references before forming a view.'

  const sentinelLines = !tag ? []
    : typeof tag === 'string'
      ? [`- A protocol message's FIRST LINE must be exactly \`${tag}\` — the daemon routes on the first line only. A tag anywhere else is invisible to it.`]
      : [
          `- The daemon routes on the FIRST LINE only — a tag anywhere else is invisible to it. Your first line must be exactly the tag for the phase you are in:`,
          ...tag.map(t => `  - ${t.phase}: \`${t.tag}\``),
        ]

  return [
    `You are ${tmuxName}, the ${role} in this thread's ${protocol} run.`,
    `Your session_id is ${sessionId}.`,
    ``,
    `**Orient:** fetch_messages(channel="${threadId}", limit=100) is your window into this thread. ${orientTail}`,
    // The cutoff's grammar is per-phase: binding while forming your independent view
    // (questions/proposal), void in refinement — the composite you are asked to
    // critique is posted AFTER it. An unscoped cutoff forbids the refinement task.
    ...(cutoffTs ? [`While forming your own questions and proposal: only read messages posted BEFORE ${cutoffTs} — later messages are other roles' work, and reading them contaminates your independence. This cutoff ends if you are later asked to critique a synthesized composite: that composite is posted after the cutoff and is your assigned reading.`] : []),
    ``,
    `**Speak:** post to the thread with reply(chat_id="${threadId}").`,
    ...sentinelLines,
    `- Untagged messages are conversational: humans see them; the protocol does not advance. Use them for questions and status, never for your deliverable.`,
    `- ${cadenceLine}`,
    ...(waits ? [``, `**Between rounds:** after posting, stay idle and wait for the next [system] notification — it will deliver the other party's response. Do not poll the thread or exit; the protocol needs you alive for subsequent rounds.`] : []),
  ].join('\n')
}
