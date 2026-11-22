# Hydra

Multi-platform chat bridge connecting Claude Code to Discord/Slack via MCP.

## Architecture

```
Discord/Slack Gateway → Daemon → Bridge → Claude Code
```

Import topology: `docs/topology.html` (interactive analysis dashboard) + `docs/topology.mmd` (Mermaid). Regenerate after any import change: `bun scripts/gen-topology.ts`. The generator draws a chosen set of files (the one editorial part: which files, and a line on each), places each by `tierOf` from `scripts/check-layers.ts` and takes the edges from that script's `edges`, so the picture shows the CI gate's tiers and imports.

Flow diagrams: `diagrams/` — Mermaid `.mmd` sources with rendered `.png` for key command flows (spawn, fork, recovery, protocols) and structural topologies (command routing, health checks). See `diagrams/README.md` for conventions. When adding a new command or protocol that routes through multiple daemon layers, add a corresponding flow diagram.

## Build & Test

```sh
bun build daemon.ts --target bun --outdir /tmp/hb    # daemon
bun build cli/hydra.ts --target bun --outdir /tmp/hb  # CLI
bun build bridge.ts --target bun --outdir /tmp/hb     # bridge
bun scripts/check-owners.ts                           # destructive tmux/git + raw liveness only in owner files (CI gate)
bun scripts/check-rules.ts                            # the rule table: no new branch on a platform or engine name, no I/O in tier 0 (CI gate)
bun run test                                          # all tests as CI runs them: the pinned bun (.tool-versions), which the daemon runs too, each file isolated, a private tmux server (plain `bun test` refuses: it would reach live sessions)
claude plugin validate mod && claude plugin test mod   # the Claude Code mod (needs claude >= 2.1.287; bun test skips mod/)
```

Compile-check all three entry points before committing — they are independent module graphs.

## Key Conventions

- One concern per PR. Split correctness from capability.
- Squash review-fix commits before merge.
- `||` at system boundaries (env reads, user input), `??` internally.
- Outbound messages go through `safeSend` (chunked, error-logged).
- Cross-compilation-unit constants go in `shared/constants.ts`.
- Late-bind runtime reads (functions, not module-scope constants) — see `spawnModel()`, `maxChunkLimit()`.
- No daemon-internal imports in `bridge-tools.ts` (cycle guard).
- Creating a tmux session goes through `tmuxNewSession()` in `infra/tmux-session.ts`; spawning `codex` goes through `codexSpawnEnv()`; shell entrypoints source `scrub-secrets.sh`. Nothing else may — a test pins the exact set of files that do. A tmux server freezes its environment at first launch and hands it to every session for that server's life.
- Claude Code mods: hydra-coupled ones live in `mod/` (tracked); personal ones in `mods.local/<name>/` (gitignored, each a full plugin dir). The daemon copies both to `<state dir>/mods/` at boot and every Claude session loads them via `CLAUDE_CODE_PLUGIN_DIRS` (`infra/mods.ts`). A daemon restart hot-reloads running sessions' mods.
- Capabilities, not names: behaviour that differs by platform or engine is a capability on the gateway (`ChatGateway`) or engine (`EngineAdapter`), never a branch on its name. Outside the folders that own the name (`gateways/`, `engines/`, and those listed in the rule), `scripts/check-rules.ts` (`platform-name-branch`, `engine-name-branch`) refuses new ones; today's are listed there and the list only shrinks.
- Never special-case a specific caller/script by name or initiator string inside shared daemon code. Add a generic parameter (CLI flag, `SpawnOpts` field) the caller opts into instead.

## Invariants

What the code must stay true to that no check catches: it holds only if you hold it. (The ones CI does catch, the tiers, cycles, tier-0 I/O, capability names and dangerous primitives, are in `scripts/check-*.ts` and are not restated here.)

- **One owner per fact.** Before you define a constant, a text, an id or a check, search for it and import it. Two definitions drift. A limit, a tool name or a refusal text lives in one file. Only dangerous primitives have a check (`check-owners`).
- **Split deciding from acting.** What to do (who may start, what is allowed, what a refusal says, whether to resume) is a value one function returns; another carries it out. In functions: `decideResume` in `app/auto-resume.ts` returns the choice and its caller acts. In layers: the app decides and an engine or gateway turns the decision into its own format and runs it. If an engine file names a policy, a role or a refusal of its own, or a function both chooses and does, split it.
- **Fail closed.** A missing gate, token or config refuses; it never allows.
- **No work at import.** A module defines; the daemon's boot starts. Safety must not depend on a side-effect import loading.
- **An exception list only shrinks.** Do not add an entry to a check's list to make it pass without saying why in the PR.
