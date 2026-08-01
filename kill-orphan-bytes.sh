#!/bin/bash
# macOS-specific: ps eww shows process environment
# Shared orphan-byte reaper — sourced by start-byte.sh and stop-byte.sh.
# Kills claude processes connected to this daemon that are not spawned sessions.
# Catches: old byte processes (HYDRA_ROLE=main) and unconfigured bridges.
# Does NOT catch: terminal sessions that resolved the socket via fallback (no
# DAEMON_SOCK env). Those are inert by design — they register with a stray
# id (stray-<uuid8>) and receive no main tools.
#
# Requires: $SOCK (daemon socket path), $LOG (log file path)

_kill_orphan_bytes() {
  pgrep -f "claude.*--channels" 2>/dev/null | while read pid; do
    pinfo=$(ps eww -p "$pid" 2>/dev/null || true)
    if echo "$pinfo" | grep -q "DAEMON_SOCK=$SOCK" && \
       ! echo "$pinfo" | grep -q "HYDRA_SESSION_ID="; then
      echo "$(date): ${1} orphaned byte process $pid" >> "$LOG"
      kill ${2} "$pid" 2>/dev/null
    fi
  done
}
