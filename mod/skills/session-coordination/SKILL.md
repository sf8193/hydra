---
name: session-coordination
description: Use when you are a session that works with other hydra sessions (a PM coordinating specialists, or a specialist reporting to one). How to message peers, when to involve the human, and what the human sees of it.
---

# Session coordination

## Two ways to talk

- **`send_to_thread`** is session to session. The recipient gets your full text. Their thread shows one line of it, never the text.
- **`reply`** is you to the human, in your own thread. It is the only way to reach them. You never reach the human through another session's thread.

## Writing the one line

The first line of your message, or the `summary` argument, becomes the line in the recipient's thread, so it must stand alone: what happened, and what you need. A line like `API pages scored 7, stopped, need a call on limits` works. A line like `Report 4 (final)` does not.

Put the detail in the message, and anything longer than a few paragraphs in a file, with the path in the message. Long text is saved to a file for the recipient anyway (past 4000 characters it gets the first lines and the path).

## When a human answer is needed

A specialist asks its coordinator, with `type: "question"`. The coordinator decides whether the human needs to be asked, and asks them in its own thread. Don't try to reach the human through the coordinator's thread yourself.

## Including the human

The human is a participant, not an audience for logs. Bring them into the conversation when it helps them decide, follow a thread of reasoning, or catch a mistake early. Then:

- Say what you need from them first, then the context they need to answer it.
- Quote a peer's words, briefly and with attribution, when the exact words matter.
- Prefer a short digest to a relay: what the sessions found, what is decided, what is open.
- Don't repeat what they already saw in that line unless it is the point.

A coordinator's own thread holds decisions, blockers and results. It does not hold the specialists' working notes.

## As a coordinator

- Read specialists' reports in full; the human sees only the headline lines.
- When specialists disagree or stall, say so to the human with your recommendation, not just the disagreement.
- Send specialists direction as short messages with a clear ask, and keep reasoning in the body.
