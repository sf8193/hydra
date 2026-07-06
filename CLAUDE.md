# Hydra

Multi-platform chat bridge connecting Claude Code to Discord/Slack via MCP.

## Architecture

```
Discord/Slack Gateway → Daemon → Bridge → Claude Code
```

Import topology: `docs/topology.html` (interactive analysis dashboard) + `docs/topology.mmd` (Mermaid). Regenerate after any import change: `bun scripts/gen-topology.ts`. The generator traces actual `import` statements and produces both files — layer assignments are the editorial config in the script; edges are discovered mechanically.

## Build & Test

```sh
bun build daemon.ts --target bun --outdir /tmp/hb    # daemon
bun build cli/hydra.ts --target bun --outdir /tmp/hb  # CLI
bun build bridge.ts --target bun --outdir /tmp/hb     # bridge
bun test                                              # all tests
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
