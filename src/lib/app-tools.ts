/**
 * The app's own tools. Electron main runs them as the `hermes-bots-groups` MCP server (one URL
 * and token per bot, so every call says which bot made it) and hands each call to the window,
 * where groups and bot settings live. Imported once for its side effect.
 */
import { cleanError, native } from './native'
import { botAsk } from './ask-actions'
import { botSendFile } from './file-actions'
import { botSendVoiceMemo } from './voice-actions'
import { normalizeRef } from './reactions'
import { botReplyInThread } from './thread-actions'
import { botRequestHelp } from './handoff-actions'
import { botRequestSecret } from './secret-actions'
import { botReact } from './react-actions'
import { listGroupsText, postFromBot, renameGroupFromBot } from './rooms'
import { profileText, updateOwnProfile } from './self-edit'

type Answer = { ok: boolean; text: string }

async function answer(profile: string, name: string, args: Record<string, unknown>): Promise<Answer> {
  switch (name) {
    case 'post_to_group':
      return postFromBot(profile, String(args.group ?? ''), String(args.text ?? ''), normalizeRef(args.reply_to))
    case 'list_groups':
      return { ok: true, text: listGroupsText(profile) }
    case 'rename_group':
      return renameGroupFromBot(profile, String(args.group ?? ''), String(args.name ?? ''))
    case 'get_profile':
      return profileText(profile)
    case 'update_profile':
      return updateOwnProfile(profile, args)
    case 'send_voice_memo':
      return botSendVoiceMemo(profile, args)
    case 'reply_in_thread':
      return botReplyInThread(profile, args)
    case 'send_file':
      return botSendFile(profile, args)
    case 'request_user_help':
      return botRequestHelp(profile, args)
    case 'request_secret':
      return botRequestSecret(profile, args)
    case 'ask_user':
      return botAsk(profile, args)
    case 'react_to_message':
      return botReact(profile, args)
    default:
      return { ok: false, text: `Unknown tool ${name}` }
  }
}

native.onAppToolCall(call => {
  answer(call.profile, call.name, call.args || {})
    .catch((error): Answer => ({ ok: false, text: cleanError(error) }))
    .then(result => native.appToolResult(call.id, result.ok, result.text))
})
