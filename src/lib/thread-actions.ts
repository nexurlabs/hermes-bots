/** `reply_in_thread` from a bot, and the 1:1 side of where a reply lands. */
import { $chats, newId } from './chat'
import { normalizeRef } from './reactions'
import { replyInRoomThread } from './rooms'
import { addThreadPost, assignChatThreads, chatRootIds } from './threads'

type Answer = { ok: boolean; text: string }

const MAX_REPLY = 8000
const HINT = " Don't repeat it in your main reply; if that was all, end your turn without more text (in a group, reply exactly (pass))."

export function botReplyInThread(profile: string, args: Record<string, unknown>): Answer {
  const ref = normalizeRef(args.message_id)
  const text = String(args.text ?? '').trim()

  if (!ref) {
    return { ok: false, text: 'message_id is required: the id shown with the message (u… in your 1:1 chat, g… in a group).' }
  }

  if (!text) {
    return { ok: false, text: 'text is empty.' }
  }

  if (text.length > MAX_REPLY) {
    return { ok: false, text: `That reply is too long (${text.length} characters, the limit is ${MAX_REPLY}). Shorten it or send a file.` }
  }

  if (ref.startsWith('g')) {
    const result = replyInRoomThread(profile, ref, text)

    return result.ok ? { ...result, text: result.text + HINT } : result
  }

  if (!/^[ub]/.test(ref)) {
    return { ok: false, text: `${ref} is not a message id (u… or b… in your 1:1 chat, g… in a group).` }
  }

  const messages = assignChatThreads($chats.get()[profile]?.messages || [])
  const ids = chatRootIds(messages)
  const target = messages.find(msg => ids.get(msg.id) === ref)

  if (messages.length && !target) {
    return { ok: false, text: `There is no message ${ref} in your 1:1 chat with the user.` }
  }

  // Replying to a reply attaches to the same root.
  const root = target?.thread || ref
  addThreadPost(`bot:${profile}`, { id: newId('t'), at: Date.now(), root, text })

  return { ok: true, text: `Replied in the thread on ${root}.${HINT}` }
}
