/** Asking for and saving secrets: the bot's `request_secret` tool and the user's Save. */
import { newId, sendToBot } from './chat'
import { roomInTurn, addRoomSecretNote } from './rooms'
import { addSecretCard, parseSecretRequest, saveSecret, savedNote, updateSecretCard } from './secrets'
import type { SecretCard } from './types'

type Answer = { ok: boolean; text: string }

/** `request_secret` from a bot: the card always goes to its 1:1 chat; a group only gets a pointer. */
export function botRequestSecret(profile: string, args: Record<string, unknown>): Answer {
  const card = parseSecretRequest(args, newId('k'))

  if (typeof card === 'string') {
    return { ok: false, text: card }
  }

  // Who asked, so the value is saved for and reported to that bot rather than to the visible chat.
  card.owner = profile
  addSecretCard(`bot:${profile}`, card)
  const room = roomInTurn(profile)

  if (room) {
    addRoomSecretNote(room.key, profile, card)
  }

  return {
    ok: true,
    text:
      `The user sees a secure input for ${card.name} in your 1:1 chat with them${room ? ` (the group "${room.name}" only got a note pointing there)` : ''}. ` +
      'End your turn now. Never ask them to paste the value in chat. When they save it you get a message saying it is saved; ' +
      `then it's available to your tools as the environment variable ${card.name} (in a new terminal command). You will never see the value.`
  }
}

/** The user saves: the value goes to Hermes only; the bot hears the name. */
export async function userSaveSecret(bot: string, card: SecretCard, value: string) {
  // The value belongs to the bot that asked. The view names the chat on screen, which is not
  // necessarily that bot's.
  const owner = card.owner || bot
  await saveSecret(owner, card.name, value)
  updateSecretCard(`bot:${owner}`, card.id, 'saved')
  void sendToBot(owner, savedNote(card.name))
}

export function userCancelSecret(bot: string, card: SecretCard) {
  updateSecretCard(`bot:${card.owner || bot}`, card.id, 'cancelled')
}
