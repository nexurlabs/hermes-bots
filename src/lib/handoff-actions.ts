/** The bot's `request_user_help` and the user's Open / Done / Can't do it. */
import { newId, sendToBot } from './chat'
import { $handoff, addHelpCard, failedNote, finishedNote, parseHelp, updateHelpCard } from './handoff'
import { addRoomHelpNote, roomInTurn } from './rooms'
import { $panelOpen, $selection } from './store'
import type { HelpCard } from './types'

type Answer = { ok: boolean; text: string }

export function botRequestHelp(profile: string, args: Record<string, unknown>): Answer {
  const card = parseHelp(args, newId('h'))

  if (typeof card === 'string') {
    return { ok: false, text: card }
  }

  // Who asked, so the handoff opens for that bot and not for whichever chat is on screen.
  card.owner = profile
  addHelpCard(`bot:${profile}`, card)
  const room = roomInTurn(profile)

  if (room) {
    addRoomHelpNote(room.key, profile, card)
  }

  return {
    ok: true,
    text:
      `The user got a card in your 1:1 chat${room ? ` (the group "${room.name}" only got a note pointing there)` : ''} to take over your computer and: ${card.instruction}. ` +
      'END YOUR TURN NOW and wait; do not use the screen meanwhile. When they are done you get "[The user finished: …. You have the screen back.]" ' +
      '(or "[The user couldn\'t finish: …]") as their next message; then look at the screen again before continuing.'
  }
}

/** The card's Open screen: go to the bot's Computer panel, which opens the large view in control. */
export function openHandoff(bot: string, card: HelpCard) {
  // The handoff belongs to the bot that asked, so the user is taken to its chat rather than the one
  // the answer happened to be given from.
  const owner = card.owner || bot
  $handoff.set({ bot: owner, card, pending: true })
  $selection.set({ kind: 'bot', id: owner })
  $panelOpen.set(true)
}

export function finishHandoff(bot: string, card: HelpCard, ok: boolean, reason = '') {
  const owner = card.owner || bot
  updateHelpCard(`bot:${owner}`, card.id, ok ? { status: 'done' } : { status: 'failed', ...(reason.trim() ? { reason: reason.trim().slice(0, 200) } : {}) })

  if ($handoff.get()?.card.id === card.id) {
    $handoff.set(null)
  }

  void sendToBot(owner, ok ? finishedNote(card) : failedNote(card, reason))
}
