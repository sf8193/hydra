import { transport } from './bridge-transport.js'
import { loadAccess } from './access.js'
import type { ChatGateway, ButtonDef } from '../gateway.js'

// ---------------------------------------------------------------------------
// Pending permissions store
// ---------------------------------------------------------------------------

export const pendingPermissions = new Map<
  string,
  { tool_name: string; description: string; input_preview: string; sessionId: string }
>()

// ---------------------------------------------------------------------------
// Button click handler for permission approval flow
// ---------------------------------------------------------------------------

const PERM_BUTTON_RE = /^perm:(allow|deny|more):([a-km-z]{5})$/

export function setupPermissionHandler(gateway: ChatGateway): void {
  gateway.onButtonClick(click => {
    const m = PERM_BUTTON_RE.exec(click.customId)
    if (!m) return

    const access = loadAccess()
    if (!access.allowFrom.includes(click.userId)) {
      void click.respond('Not authorized.')
      return
    }

    const [, behavior, request_id] = m

    if (behavior === 'more') {
      const details = pendingPermissions.get(request_id)
      if (!details) {
        void click.respond('Details no longer available.')
        return
      }
      const { tool_name, description, input_preview } = details
      let prettyInput: string
      try {
        prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
      } catch {
        prettyInput = input_preview
      }
      const expanded =
        `Permission: ${tool_name}\n\n` +
        `tool_name: ${tool_name}\n` +
        `description: ${description}\n` +
        `input_preview:\n${prettyInput}`
      const buttons: ButtonDef[] = [
        { id: `perm:allow:${request_id}`, label: 'Allow', style: 'success', emoji: '✅' },
        { id: `perm:deny:${request_id}`, label: 'Deny', style: 'danger', emoji: '❌' },
      ]
      void click.respond(expanded, buttons)
      return
    }

    // Forward allow/deny to the session that requested it
    const pending = pendingPermissions.get(request_id)
    const targetSessionId = pending?.sessionId ?? 'main'
    const targetBridge = transport.get(targetSessionId)
    if (targetBridge) {
      transport.sendToBridge(targetBridge, {
        type: 'permission_response',
        request_id,
        behavior,
      })
    }
    pendingPermissions.delete(request_id)
    const label = behavior === 'allow' ? 'Allowed' : 'Denied'
    void click.clearButtons(`${click.messageContent}\n\n${label}`)
  })
}
