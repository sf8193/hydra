import type { ProviderId } from './engines/engine-adapter.js'

export type OwnershipRegistry = {
  reservedNames: Set<string>
  reserveCodexHome(name: string): boolean
  releaseCodexHome(name: string): void
}

/** Synchronous acquisition must precede every async launch/preparation step. */
export class SpawnOwnership {
  private released = false
  private homeReserved = false

  constructor(
    private readonly registry: OwnershipRegistry,
    private readonly name: string,
    provider: ProviderId,
    private readonly homeName: string,
    hasPendingRetirement: (home: string) => boolean,
  ) {
    if (registry.reservedNames.has(name)) throw new Error(`session name ${name} is already starting`)
    registry.reservedNames.add(name)
    try {
      if (provider === 'codex') {
        if (!registry.reserveCodexHome(homeName)) throw new Error(`codex home ${homeName} is already active or starting`)
        this.homeReserved = true
        if (hasPendingRetirement(homeName)) throw new Error(`codex home ${homeName} has unresolved retirement`)
      }
    } catch (err) {
      this.release()
      throw err
    }
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.registry.reservedNames.delete(this.name)
    if (this.homeReserved) this.registry.releaseCodexHome(this.homeName)
  }
}
