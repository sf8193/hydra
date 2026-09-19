#!/bin/bash
# Ensure the voice-dictation transcription sidecar is running in a tmux session.
#
# Idempotent: a no-op if the session is already up, so it's safe for the
# watchdog to call every cycle (it will NOT restart a running model server).
#
# ONE shared session ('hydra-transcribe') serves every platform daemon:
# transcription is platform-agnostic and the sidecars all bind the same
# default port, so per-platform sessions would just race for the bind.
#
# Backend selection (positional arg or HYDRA_TRANSCRIBE_BACKEND):
#   parakeet — Parakeet-MLX on Apple Silicon (server_mlx.py). Default on macOS.
#   canary   — NVIDIA Canary-Qwen 2.5B via NeMo (server.py). Default elsewhere; needs a CUDA GPU.
#   mock     — GPU-free stub for testing the wiring (mock_server.py).
# Both real backends need a one-time ./transcribe-server/setup.sh (creates .venv).
#
# The daemon picks the sidecar up automatically — no daemon restart needed.
#
# --auto (used by hydra up / watchdog / start-daemon.sh): start only when the
# sidecar can actually run — quiet no-op otherwise. See the gate below.
export PATH="$HOME/.npm-global/bin:$HOME/.asdf/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

AUTO=0
if [ "${1:-}" = "--auto" ]; then AUTO=1; shift; fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${HYDRA_STATE_DIR:-${DISCORD_STATE_DIR:-$HOME/.claude/channels/${CHAT_PLATFORM:-discord}}}"

# Pull ONLY dictation-related keys from the state-dir .env (real env wins).
# Sourcing the whole file (set -a) would export the bot tokens into this
# process — and, when this script is what creates the tmux server, into the
# sidecar's environment. The model server has no business holding chat tokens.
# Parsing matches shell sourcing: optional `export`, quoted values kept
# verbatim, unquoted values lose trailing inline comments and whitespace.
if [ -f "$STATE_DIR/.env" ]; then
  for _key in HYDRA_TRANSCRIBE_ENABLED HYDRA_TRANSCRIBE_AUTOSTART HYDRA_TRANSCRIBE_BACKEND \
              HYDRA_TRANSCRIBE_URL HYDRA_TRANSCRIBE_LOG PARAKEET_MODEL CANARY_MODEL \
              CANARY_MAX_NEW_TOKENS HYDRA_MOCK_TRANSCRIPT; do
    if [ -z "${!_key}" ]; then
      _val=$(sed -nE "s/^(export[[:space:]]+)?${_key}=//p" "$STATE_DIR/.env" 2>/dev/null | tail -1)
      case "$_val" in
        \"*) _val="${_val#\"}"; _val="${_val%%\"*}" ;;
        \'*) _val="${_val#\'}"; _val="${_val%%\'*}" ;;
        *) _val=$(printf '%s' "$_val" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//') ;;
      esac
      [ -n "$_val" ] && export "$_key=$_val"
    fi
  done
fi

# POSIX-safe single-quoting for values interpolated into the tmux command
# string — an embedded quote must not break out of the command.
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Default backend: parakeet (MLX) on macOS, canary (NeMo/CUDA) elsewhere.
if [ "$(uname -s)" = "Darwin" ]; then
  DEFAULT_BACKEND=parakeet
else
  DEFAULT_BACKEND=canary
fi

# Backend: positional arg wins (e.g. `./start-transcribe.sh mock`), else env, else default.
# Only known backends are accepted as the arg; anything else (e.g. a comment
# pasted from docs — zsh doesn't strip `#` in interactive mode) is ignored so a
# stray token can't silently pick a bogus backend.
BACKEND="${HYDRA_TRANSCRIBE_BACKEND:-$DEFAULT_BACKEND}"
case "${1:-}" in
  mock|canary|parakeet) BACKEND="$1" ;;
  '') ;;
  *) echo "start-transcribe: ignoring unrecognized arg '$1' (use: parakeet|canary|mock); using '$BACKEND'" >&2 ;;
esac
SESSION="hydra-transcribe"
LOG="${HYDRA_TRANSCRIBE_LOG:-$HOME/hydra-transcribe.log}"
SRV_DIR="$SCRIPT_DIR/transcribe-server"

# Derive the bind port from HYDRA_TRANSCRIBE_URL if set, else default 8123.
# A URL without an explicit port gets the scheme default so a mismatch fails
# visibly (bind error) instead of the sidecar silently serving a port the
# daemon never queries.
PORT=$(printf '%s' "${HYDRA_TRANSCRIBE_URL:-}" | sed -nE 's#.*://[^:/]+:([0-9]+).*#\1#p')
if [ -z "$PORT" ] && [ -n "${HYDRA_TRANSCRIBE_URL:-}" ]; then
  case "$HYDRA_TRANSCRIBE_URL" in https://*) PORT=443 ;; *) PORT=80 ;; esac
fi
: "${PORT:=8123}"

# --auto gate: explicit HYDRA_TRANSCRIBE_AUTOSTART wins in both directions;
# when unset, start only if a REAL backend is ready (venv built). The mock is
# deliberately excluded from auto-supervision — a leftover BACKEND=mock in
# .env must not keep canned transcripts flowing into real messages; run it by
# hand or set AUTOSTART=1 if you truly want it supervised. Quiet exits keep
# daemon-start output and watchdog logs clean where dictation isn't set up.
if [ "$AUTO" = 1 ]; then
  ENABLED=$(printf '%s' "${HYDRA_TRANSCRIBE_ENABLED:-}" | tr '[:upper:]' '[:lower:]')
  AUTOSTART=$(printf '%s' "${HYDRA_TRANSCRIBE_AUTOSTART:-}" | tr '[:upper:]' '[:lower:]')
  case "$ENABLED" in 0|false|no|off) exit 0 ;; esac
  # Remote sidecar configured — nothing to supervise on this machine.
  case "${HYDRA_TRANSCRIBE_URL:-}" in
    ''|*://127.0.0.1:*|*://127.0.0.1/*|*://localhost:*|*://localhost/*) ;;
    *) exit 0 ;;
  esac
  case "$AUTOSTART" in
    0|false|no|off) exit 0 ;;
    1|true|yes|on) ;;
    *) { [ "$BACKEND" != mock ] && [ -x "$SRV_DIR/.venv/bin/uvicorn" ]; } || exit 0 ;;
  esac
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "$(date): ERROR: tmux not found in PATH" | tee -a "$LOG"
  exit 1
fi

# Already running — leave it alone. (Quiet under --auto: supervisors call this
# every cycle.) NOTE: a crashed server PARKS in its session (see below), which
# also lands here — kill the session to allow a restart.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  [ "$AUTO" = 1 ] || echo "Transcribe sidecar already running (tmux '$SESSION')."
  exit 0
fi

case "$BACKEND" in
  mock)
    # Resolve the interpreter now (tmux runs the command in a fresh shell) and
    # fall back to the system python: asdf's python3 shim fails when no version
    # is pinned for this dir, and mock_server.py is pure stdlib anyway.
    PY=python3
    if ! "$PY" -c '' 2>/dev/null && [ -x /usr/bin/python3 ]; then PY=/usr/bin/python3; fi
    CMD="$(shq "$PY") mock_server.py"
    ;;
  parakeet|canary)
    [ "$BACKEND" = parakeet ] && APP=server_mlx:app || APP=server:app
    VENV="$SRV_DIR/.venv"
    if [ ! -x "$VENV/bin/uvicorn" ]; then
      echo "$(date): $BACKEND backend not set up — run ./transcribe-server/setup.sh first. Skipping." | tee -a "$LOG"
      exit 1
    fi
    CMD="$(shq "$VENV/bin/uvicorn") $APP --host 127.0.0.1 --port $PORT"
    ;;
  *)
    echo "$(date): unknown HYDRA_TRANSCRIBE_BACKEND='$BACKEND' (expected parakeet|canary|mock)" | tee -a "$LOG"
    exit 1
    ;;
esac

# Forward runtime env into the tmux process explicitly (the tmux server's env
# is frozen at first launch — under launchd it lacks /opt/homebrew/bin, which
# breaks the servers' ffmpeg lookup). Model vars only when set, so an empty
# value can't override a server default. PARAKEET_MODEL lets you pin a smaller
# model (e.g. the 110M variant) when the 0.6B download is impractical.
ENVP="PATH=$(shq "$PATH") HYDRA_MOCK_PORT=$PORT"
[ -n "$PARAKEET_MODEL" ] && ENVP="$ENVP PARAKEET_MODEL=$(shq "$PARAKEET_MODEL")"
[ -n "$CANARY_MODEL" ] && ENVP="$ENVP CANARY_MODEL=$(shq "$CANARY_MODEL")"
[ -n "$CANARY_MAX_NEW_TOKENS" ] && ENVP="$ENVP CANARY_MAX_NEW_TOKENS=$(shq "$CANARY_MAX_NEW_TOKENS")"
[ -n "$HYDRA_MOCK_TRANSCRIPT" ] && ENVP="$ENVP HYDRA_MOCK_TRANSCRIPT=$(shq "$HYDRA_MOCK_TRANSCRIPT")"

# If the server exits (bad port, missing ffmpeg, failed model download), PARK
# the session instead of dying: the supervisors' has-session check then holds,
# so a broken sidecar fails ONCE with its error on screen and in the log —
# not a model-load crash-loop every watchdog tick.
PARK_MSG="transcribe sidecar exited — parked to avoid a supervised crash-loop; inspect the error above (or $LOG), fix it, then: tmux kill-session -t $SESSION"
if [ -f "$SCRIPT_DIR/scrub-raindrop.sh" ]; then
  . "$SCRIPT_DIR/scrub-raindrop.sh"
elif env | grep -q '^RAINDROP_'; then
  echo "hydra: scrub-raindrop.sh missing and RAINDROP_ vars are set — refusing to spawn" >&2
  exit 1
else
  echo "hydra: scrub-raindrop.sh missing (no RAINDROP_ vars set; continuing)" >&2
fi
tmux new-session -d -s "$SESSION" \
  "cd $(shq "$SRV_DIR") && $ENVP $CMD 2>&1 | tee -a $(shq "$LOG"); echo $(shq "$PARK_MSG") | tee -a $(shq "$LOG"); sleep 864000000"

echo "$(date): Transcribe sidecar started (backend=$BACKEND, port=$PORT, tmux '$SESSION')" >> "$LOG"
echo "Transcribe sidecar started (backend=$BACKEND, port=$PORT). Attach: tmux attach -t $SESSION"
