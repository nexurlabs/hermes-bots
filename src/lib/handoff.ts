/**
 * Sign-in handoff: a bot hits a login, 2FA, captcha or any step only the user can do on its
 * computer (the Sandbox desktop) and hands the screen over with `request_user_help`
 * (`hermes-bots-groups`). A card in its 1:1 chat opens the large Computer view with the user in
 * control (the same lease as the Open button) and a banner with the instruction and Done /
 * Can't do it. Either one gives the screen back and tells the bot. This PC is not involved: it
 * is the user's own computer.
 *
 * Cards are kept on this device, like the other cards.
 */
import { atom } from 'nanostores'

import type { HelpCard } from './types'

export function parseHelp(args: Record<string, unknown>, id: string): HelpCard | string {
  const instruction = String(args.instruction ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)

  if (!instruction) {
    return 'instruction is required: one sentence telling the user what to do, e.g. "Sign in to GitHub and approve the 2FA prompt".'
  }

  const rawUrl = String(args.url ?? '').trim()
  let url: string | undefined

  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl)
      url = parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString().slice(0, 500) : undefined
    } catch {
      url = undefined
    }
  }

  const doneLabel = String(args.done_label ?? '').trim().slice(0, 24) || 'Done'

  return { id, at: Date.now(), instruction, ...(url ? { url } : {}), doneLabel, status: 'open' }
}

/**
 * A card's text in the chat: one short line, never a raw link. The full instruction is still in the
 * Computer panel's banner, so nothing is lost by keeping the chat short.
 */
export function compactInstruction(text: string, max = 110): string {
  const flat = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()

  if (flat.length <= max) {
    return flat
  }

  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')

  return `${cut.slice(0, space > max / 2 ? space : max).trimEnd()}…`
}

/** A bot's own chat shows only the cards that bot asked for; a teammate's card never lands here. */
export const cardsForBot = (cards: HelpCard[], bot: string) => cards.filter(card => !card.owner || card.owner === bot)

const strip = (text: string) => text.replace(/[.\s]+$/, '')
export const finishedNote = (card: HelpCard) => `[The user finished: ${strip(card.instruction)}. You have the screen back.]`
export const failedNote = (card: HelpCard, reason: string) =>
  `[The user couldn't finish: ${strip(card.instruction)}.${reason.trim() ? ` Reason: ${reason.trim().slice(0, 200)}` : ''}]`

// ── cards (this device) ─────────────────────────────────────────────────────
const key = (chat: string) => `help-cards:${chat}`

export const $helpCards = atom<Record<string, HelpCard[]>>({})

export function chatHelpCards(chat: string): HelpCard[] {
  const cached = $helpCards.get()[chat]

  if (cached) {
    return cached
  }

  let list: HelpCard[] = []

  try {
    list = JSON.parse(localStorage.getItem(key(chat)) || '[]') || []
  } catch {
    list = []
  }

  $helpCards.set({ ...$helpCards.get(), [chat]: list })

  return list
}

function save(chat: string, list: HelpCard[]) {
  const kept = list.slice(-50)
  $helpCards.set({ ...$helpCards.get(), [chat]: kept })

  try {
    localStorage.setItem(key(chat), JSON.stringify(kept))
  } catch {
    /* session only */
  }
}

export function addHelpCard(chat: string, card: HelpCard) {
  // A new request replaces the bot's still-open one.
  save(chat, [...chatHelpCards(chat).map(c => (c.status === 'open' ? { ...c, status: 'failed' as const, reason: 'replaced by a newer request' } : c)), card])
}

export function updateHelpCard(chat: string, id: string, patch: Partial<HelpCard>) {
  save(
    chat,
    chatHelpCards(chat).map(c => (c.id === id ? { ...c, ...patch } : c))
  )
}

// ── the live handoff ────────────────────────────────────────────────────────
/**
 * The handoff in progress: which bot's screen, which card. `pending` means the card asked to open
 * the screen and the Computer panel hasn't done it yet (it may need to start the computer first).
 */
export const $handoff = atom<null | { bot: string; card: HelpCard; pending: boolean }>(null)
