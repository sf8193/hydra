// Hydra's Claude Code mod. The daemon copies mod/ to <state dir>/mods/hydra at boot and
// every session it spawns loads it via CLAUDE_CODE_PLUGIN_DIRS (shared/mods.ts).
// Needs Claude Code >= 2.1.287.
import type { On } from 'claude-code'

export function register(on: On) {}
