/**
 * What specialist delivery needs from app/recovery.ts and app/session-lifecycle.ts, which sit above it.
 * daemon.ts binds it once at boot (bindRecovery); a use before that is a wiring bug and fails loudly.
 */
import type { backoffRefusal, currentRecoveryDeps, reviveDeps, reviveThread, reviveThreadForDelivery, threadStub } from '../app/recovery.js'
import type { endForFreshStart } from '../app/session-lifecycle.js'

export type RecoveryPort = {
  reviveThread: typeof reviveThread
  reviveThreadForDelivery: typeof reviveThreadForDelivery
  backoffRefusal: typeof backoffRefusal
  threadStub: typeof threadStub
  endForFreshStart: typeof endForFreshStart
  threadExists: typeof reviveDeps.threadExists
  doSpawnSession: ReturnType<typeof currentRecoveryDeps>['doSpawnSession']
}

let bound!: RecoveryPort
export function bindRecovery(port: RecoveryPort): void { bound = port }
export const recovery = (): RecoveryPort => bound
