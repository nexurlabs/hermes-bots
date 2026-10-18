/**
 * Doing a reaction: the user from the hover picker, or a bot through the app's
 * `react_to_message` tool. The data side is in reactions.ts (1:1) and rooms.ts (groups).
 */
import { $chats } from './chat'
import { cleanEmoji, normalizeRef, queueNote, reactByKey, reactInChat, roomRef, USER, userReactionNote } from './reactions'
import { $rooms, reactInRoom, roomEntryByRef } from './rooms'
import type { ChatMsg } from './types'

export type ReactWhere = { kind: 'bot'; name: string } | { kind: 'room'; key: string }

/** The user toggles `emoji` on a message; the bot that wrote it hears about it on its next turn. */
export function userReact(where: ReactWhere, msg: ChatMsg, emoji: string) {
  if (where.kind === 'bot') {
    const messages = $chats.get()[where.name]?.messages || []
    const after = reactInChat(`bot:${where.name}`, messages, msg.id, USER, emoji)

    if (after !== null && msg.role === 'assistant') {
      queueNote(`bot:${where.name}`, userReactionNote(after, msg.text))
    }

    return
  }

  const entry = reactInRoom(where.key, msg.id, USER, emoji)
  const room = $rooms.get()[where.key]

  if (entry && room && entry.from.kind === 'member') {
    queueNote(`room:${room.roomId}:${entry.from.name}`, userReactionNote(entry.reactions?.[USER] || '', entry.text, roomRef(entry.id)))
  }
}

type Answer = { ok: boolean; text: string }

const DONE_HINT =
  'If the reaction is your whole reply (a "thanks", "ok", "got it"), end your turn now without writing anything else; in a group chat reply exactly (pass).'

/** `react_to_message` from a bot: {message_id, emoji, end_turn?}. Only its own 1:1 chat and its groups. */
export function botReact(profile: string, args: Record<string, unknown>): Answer {
  const emoji = cleanEmoji(args.emoji)
  const ref = normalizeRef(args.message_id)

  if (!emoji) {
    return { ok: false, text: 'emoji must be a single emoji, like 👍 or ❤️.' }
  }

  if (!ref) {
    return { ok: false, text: 'message_id is required: the id shown with the message (u… in your 1:1 chat, g… in a group).' }
  }

  const hint = args.end_turn === false ? '' : ` ${DONE_HINT}`

  if (ref.startsWith('u')) {
    const messages = $chats.get()[profile]?.messages

    if (messages?.length && !messages.some(msg => msg.role === 'user' && msg.ref === ref)) {
      return { ok: false, text: `There is no message ${ref} in your 1:1 chat with the user.` }
    }

    const after = reactByKey(`bot:${profile}`, `ref:${ref}`, profile, emoji)

    return { ok: true, text: (after ? `Reacted ${after} to message ${ref}.` : `Removed your reaction from message ${ref}.`) + hint }
  }

  if (ref.startsWith('g')) {
    const found = roomEntryByRef(profile, ref)

    if (!found) {
      return { ok: false, text: `There is no message ${ref} in your groups.` }
    }

    if (found.entry.from.kind === 'member' && found.entry.from.name === profile) {
      return { ok: false, text: 'You cannot react to your own message.' }
    }

    const entry = reactInRoom(found.room.key, found.entry.id, profile, emoji)
    const after = entry?.reactions?.[profile] || ''

    return { ok: true, text: (after ? `Reacted ${after} to message ${ref} in "${found.room.name}".` : `Removed your reaction from message ${ref}.`) + hint }
  }

  return { ok: false, text: `Unknown message id ${ref}. Use the id shown with the message (u… or g…).` }
}
