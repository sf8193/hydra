#!/usr/bin/env bash
# Shared compile check — sourced by start-daemon.sh and preflight.sh.
# Caller must pass the source directory as $1.

_compile_check() {
  # Boot gate: confirm entrypoints BUILD (fast, ~1-2s). bun's bundler catches
  # the boot-crash class — syntax + missing imports/exports. Type-correctness is
  # a SEPARATE concern, checked once per change at commit/merge (tsc --noEmit in
  # pre-commit + post-merge hooks), NOT on the restart hot-path where speed
  # matters most (watchdog revives, incident recovery).
  local rc=0 out=""
  for entry in daemon.ts bridge.ts; do
    err=$(cd "$1" && bun build "$entry" --target=bun 2>&1 >/dev/null) || rc=1
    [ -n "$err" ] && out="${out}[$entry] ${err}"$'\n'
  done
  echo "$out"; return $rc
}
