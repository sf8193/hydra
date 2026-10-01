#!/bin/sh
# Runs the suite against a private tmux server. Bun's child processes inherit the
# environment bun started with, not the preload's later edits to process.env, so
# the isolation has to be in place before bun starts. test-setup.ts refuses to run
# without it. Arguments pass through: scripts/test.sh --isolate daemon/__tests__/x.test.ts
dir=$(mktemp -d "${TMPDIR:-/tmp}/hydra-tmux-XXXXXX") || exit 1
unset TMUX
TMUX_TMPDIR=$dir bun test "$@"
status=$?
tmux -S "$dir/tmux-$(id -u)/default" kill-server 2>/dev/null
rm -rf "$dir"
exit $status
