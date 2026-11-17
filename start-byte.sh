#!/bin/bash
echo "DEPRECATED: use 'hydra up <platform>' instead (bun cli/hydra.ts up discord)" >&2
set -euo pipefail
# Start the byte (main) for a running daemon. A thin wrapper over the CLI's startByte (cli/lifecycle.ts), so main starts
# the same way whichever door opens it: the model from hydra.toml's [main] model (else HYDRA_MODEL), the main record written.
# This script used to pin claude-opus-5-5[1m]; without [main] model it now starts main on HYDRA_MODEL, else hydra's default.
#
# Required env:
#   CHAT_PLATFORM — discord or slack
#
# Optional env, as `hydra up` reads it: BYTE_SESSION_NAME, BYTE_CHANNEL, BYTE_CWD, CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN.
# The state dir is the platform's (~/.claude/channels/<platform>), as `hydra up <platform>` uses.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env-setup.sh"

cd "$SCRIPT_DIR"
CHAT_PLATFORM="$CHAT_PLATFORM" exec bun -e 'import { resolveConfig } from "./cli/helpers.ts"; import { startByte } from "./cli/lifecycle.ts"; await startByte(resolveConfig(process.env.CHAT_PLATFORM))'
