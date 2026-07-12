# Adversarial Review — protocol

> A dyad protocol. A critic challenges; the owner defends across N rounds; the owner closes with a summary. The scaffolding is struck and the arc is preserved.
>
> Three layers govern: the **skeleton** (topology — phases, transitions, windows), the **decisions** (semantics — what each agent can decide and what fires from it), and the **seeds** (minds — the prompts that create each role). The daemon reads all three. Prose between them is for the human.

## Roles

| Role | Who | Created by |
|---|---|---|
| **critic** | a fresh spawn, principal-neutral by construction | the daemon, when the review starts |
| **owner** | the thread's own session — the one who built the thing | already exists |

## Arc

1. **critic_turn** — the critic reads everything and attacks. Posts with `[critic→owner]`.
2. **owner_turn** — the owner defends. Posts with `[owner→critic]`. After the final round, the debate ends.
3. **post_pass** — if lenses were requested, the critic runs each one. Uses `decide(clean | findings, because)` per pass.
4. **cleanup** — the owner writes one closing summary. Posts with `[summary]`.
5. **complete** / **cancelled** — terminal.

## Lenses

Composable review passes from `protocols/lenses/`. Each lens is a markdown file with instructions and a skeleton declaring name + aliases. Requested at review time with `+name` syntax: `review 3 +r +security`.

## Skeleton

```yaml skeleton
protocol: review
emoji: "⚔️"
display_name: Adversarial Review

roles:
  critic: { label: The Critic }
  owner:  { label: The Owner }

initial_phase: critic_turn

phases:
  critic_turn:
    actor: critic
    half: top
    on: { critic_posted: owner_turn, timeout: cancelled, cancel: cancelled }
  owner_turn:
    actor: owner
    half: bottom
    on: { owner_posted: critic_turn, final_round: post_pass, timeout: cancelled, cancel: cancelled }
  post_pass:
    actor: critic
    half: bottom
    on: { pass_posted: post_pass, all_passes_done: cleanup, timeout: cleanup, cancel: cancelled }
  cleanup:
    actor: owner
    half: top
    on: { summary_posted: complete, timeout: complete }
  complete:   { terminal: true }
  cancelled:  { terminal: true }

sentinels:
  critic_turn: "[critic→owner]"
  owner_turn:  "[owner→critic]"
  post_pass:   "[critic→owner]"
  cleanup:     "[summary]"

windows:
  critic_turn: 10m
  owner_turn:  30m
  post_pass:   10m
  cleanup:     5m

disconnect_grace:
  critic: 30s
  owner:  2m

completion_event:
  protocol: review
  fields: [thread, rounds, roundsRun, outcome, topic, cast, transcript, struck]
```

## Decisions

The semantic layer. Each decision is a `decide(value, because)` tool call the daemon provides to the actor. The machine routes on `value`; the daemon narrates `because` to the thread.

```yaml decisions
# The critic's verdict after reviewing. Replaces secondLine === '**LGTM**'.
critic_verdict:
  phase: owner_turn
  actor: owner
  trigger: final_round
  description: >
    The daemon fires this when the owner posts their final defense
    (currentRound >= rounds). No agent calls it — the round count is
    the daemon's arithmetic, not a judgment.

# The critic approves or requests changes (build protocol).
# For review, the debate runs for exactly N rounds — there is no
# early exit. The critic's job is to press, not to judge.

pass_verdict:
  phase: post_pass
  actor: critic
  tool: decide
  options:
    clean:
      event: pass_posted
      narrate: "+{lens}: clean"
    findings:
      event: pass_posted
      narrate: "+{lens}: {findings_count} finding(s)"
  after_all_passes: all_passes_done
```

## Seeds

The prompts that create each role. The daemon injects `{thread_id}`, `{session_id}`, `{tmux_name}`, `{rounds}`, `{topic}`, and `{lens_instructions}` at spawn time. Everything else is verbatim.

### critic

```prompt critic
You are {tmux_name}, the critic in this thread's {rounds}-round adversarial review.
Your session_id is {session_id}.

**Orient:** fetch_messages(channel="{thread_id}", limit=100) is your window into this thread.
Read every code file, wiki article, config, or document it references before forming a view.

**Speak:** post to the thread with reply(chat_id="{thread_id}").
- Your FIRST LINE must be exactly `[critic→owner]` — the daemon routes on the first line only.
- Untagged messages are conversational and won't advance the review.
- One protocol message per round.

**Wait:** after posting, WAIT. Phase advances arrive as [system] notifications.

{mandate}

Post your opening critique after orienting. The owner will tag their defenses
with `[owner→critic]` — when a defense arrives, post your counter-argument.
Repeat for {rounds} rounds.

Format with clear headers. Be substantive and focused.
```

#### mandate (default)

Find weaknesses, challenge assumptions, identify risks, and argue AGAINST the design.
Be specific — cite code lines, data, or logical gaps. Concede strong points but push hard on weak ones.

#### mandate (focused)

**Your focus:** {topic}
Find weaknesses, challenge assumptions, and identify risks related to this focus.
Be specific — cite code lines, data, or logical gaps.

### owner (notification on review start)

```prompt owner_start
[system] Adversarial review started ({rounds} rounds). A critic will challenge your design.
When their critique arrives as a notification, defend your work by replying to your thread.

**Message routing:** Your first line MUST be `[owner→critic]` when posting your defense.
Messages without this tag are conversational and won't advance the review.
```

### owner (notification on cleanup)

```prompt owner_cleanup
[system] Adversarial review complete ({rounds} round(s)).
Post a brief summary to your thread. After you post, the review messages will be cleaned up.

**Message routing:** Your first line MUST be `[summary]`. Messages without this tag won't complete the review.

Use this format:
[summary]
**⚔️ Review Summary** ({rounds} round(s))

🔬 **Synthesis** — one sentence. The review in one breath.
{round_arc}

---

📋 **Dispositions**
- ✅ issue — fixed/will fix
- ⚠️ issue — acknowledged, deferred
- ❌ issue — rebutted

---

⚡ **Tensions** — what was actually contested, not just flagged.

🌱 **What Emerged** — what nobody asked for that showed up anyway.

➡️ **What's next** — what happens now and what needs the human.
```
