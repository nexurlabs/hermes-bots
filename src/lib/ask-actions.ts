/** Asking and answering question cards: the bot's `ask_user` tool and the user's click. */
import { addChatCard, answerText, askSummary, chatCards, parseAsk, updateChatCard } from './ask'
import { newId, sendToBot } from './chat'
import { addRoomAsk, postToRoom, roomInTurn, updateRoomAsk, $rooms } from './rooms'
import type { AskCard } from './types'

type Answer = { ok: boolean; text: string }

/** `ask_user` from a bot: a card in the group it's answering in right now, else in its 1:1 chat. */
export function botAsk(profile: string, args: Record<string, unknown>): Answer {
  const card = parseAsk(args, newId('q'))

  if (typeof card === 'string') {
    return { ok: false, text: card }
  }

  // Who asked, recorded on the card itself. The chat it is filed under already says this, but the
  // answer path is handed a card from whatever chat the user is looking at, so the owner has to
  // travel with the card rather than be re-derived from the view.
  card.owner = profile
  const room = roomInTurn(profile)

  if (room) {
    addRoomAsk(room.key, profile, card, askSummary(card))
  } else {
    addChatCard(`bot:${profile}`, card)
  }

  return {
    ok: true,
    text:
      `Asked the user${room ? ` in "${room.name}"` : ''}; they see "${card.prompt}" with ${card.options.length} button${card.options.length === 1 ? '' : 's'}. ` +
      'End your turn now without repeating the question or the options. Their answer arrives as their next message (the chosen option\'s value or label' +
      `${card.multi ? ', one per line' : ''}${card.allowCustom ? ', or their own text' : ''}). If they type something else instead, the question was skipped.`
  }
}

export type AskWhere = { kind: 'bot'; name: string } | { kind: 'room'; key: string; asker: string }

/** The user answers: lock the card with what they chose, then send it as their reply. */
export function userAnswer(where: AskWhere, card: AskCard, picked: string[], custom: string) {
  const text = answerText(card, picked, custom)

  if (!text) {
    return
  }

  if (where.kind === 'bot') {
    // The answer belongs to the bot that asked. The view says which chat the user is looking at, which
    // is not the same thing: a card is rendered from the chat it was filed under, and an answer to
    // somebody else's card must not be redirected to whoever happens to be on screen.
    const owner = card.owner
    const chat = `bot:${owner || where.name}`
    // Read the stored card rather than trusting the one handed in, so answering the same card twice
    // cannot send the answer twice — the rendered copy is stale by the time the second click lands.
    const stored = chatCards(chat).find(item => item.id === card.id)

    if (!stored || stored.status !== 'open') {
      return
    }

    const target = owner || where.name

    updateChatCard(chat, card.id, { status: 'answered', picked, ...(custom.trim() ? { custom: custom.trim() } : {}) })
    void sendToBot(target, text)

    return
  }

  const stored = ($rooms.get()[where.key]?.log || []).find(entry => entry.id === card.id)?.ask

  if (!stored || stored.status !== 'open') {
    return
  }

  updateRoomAsk(where.key, card.id, { status: 'answered', picked, ...(custom.trim() ? { custom: custom.trim() } : {}) })
  postToRoom(where.key, text, [], { answerTo: where.asker })
}
