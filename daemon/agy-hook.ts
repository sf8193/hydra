#!/usr/bin/env bun
// agy's hook (registered by engines/agy-config.ts): records what agy says about its own session in the file HYDRA_AGY_STATE names, where the daemon reads it
// (engines/agy-session.ts). The conversation id and transcript path arrive on every event; `live` is 'working' from the session start and each model call
// until a stop, which says 'idle', with backgroundWork when agy stopped while a command it started still runs. Runs for any agy: outside a hydra session
// HYDRA_AGY_STATE is not set and it records nothing. A stop is answered before anything is written, or agy would not know whether to stop.
import { readFileSync, renameSync, writeFileSync } from 'fs'

const event = process.argv[2]
const file = process.env.HYDRA_AGY_STATE
const input = file ? JSON.parse(readFileSync(0, 'utf8')) : null
process.stdout.write(event === 'Stop' ? '{"decision":"stop"}' : '{}')   // first: a failed write below must not leave agy unanswered
if (file) {
  const state = { conversationId: input.conversationId, transcriptPath: input.transcriptPath, live: event === 'Stop' ? 'idle' : 'working', backgroundWork: event === 'Stop' && input.fullyIdle === false }
  const temp = `${file}.${process.pid}.tmp`   // two hooks can run at once
  writeFileSync(temp, JSON.stringify(state))
  renameSync(temp, file)
}
