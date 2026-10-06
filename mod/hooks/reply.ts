// The chats a prompt's Discord messages from people came from. The bridge wraps each message as
// <channel source="plugin:discord:discord" chat_id="..." message_id="..." user="..." user_id="..." ...>
// (daemon/router.ts). Daemon notices (pr-watch, nudges: user_id "system") and other sessions'
// messages (user_id "session") have no numeric message_id and user_id, and need no reply.
export function channelChats(text: string): string[] {
  return [...text.matchAll(/<channel source="plugin:discord:discord" chat_id="(\d+)" message_id="\d+" user="[^"]*" user_id="\d+"/g)].map(m => m[1])
}
