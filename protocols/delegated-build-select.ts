import rigorous from './delegated-build.js'
import quick from './delegated-build-quick.js'

export function selectDelegatedBuildProtocol(isQuick: boolean) {
  return isQuick ? quick : rigorous
}
