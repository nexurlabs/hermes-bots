/**
 * Question cards: a bot asks the user something with clickable options (`ask_user` on the app's
 * `hermes-bots-groups` MCP server). The card shows in the chat the bot is in; picking an option
 * sends its value (or label) as the user's next message and locks the card. A typed message
 * instead dismisses any open card as unanswered.
 *
 * Storage: in a group the card is a log entry (saved and synced with the log). 1:1 history comes
 * from Hermes, so 1:1 cards are kept on this device in localStorage.
 */
import { atom } from 'nanostores'

import type { AskCard, AskOption } from './types'

export const MAX_OPTIONS = 6

/** Validates `ask_user`'s arguments into a card, or explains what's wrong. */
export function parseAsk(args: Record<string, unknown>, id: string): AskCard | string {
  const prompt = String(args.prompt ?? '').trim().slice(0, 2000)

  if (!prompt) {
    return 'prompt is required: the question to show the user.'
  }

  const raw = Array.isArray(args.options) ? args.options : []
  const options: AskOption[] = raw
    .map((item: any): AskOption | null => {
      const o = typeof item === 'string' ? { label: item } : item && typeof item === 'object' ? item : null
      const label = String(o?.label ?? '').trim().slice(0, 80)

      if (!label) {
        return null
      }

      const style = o.style === 'primary' || o.style === 'danger' ? o.style : undefined

      return {
        label,
        ...(o.value !== undefined && String(o.value).trim() ? { value: String(o.value).slice(0, 2000) } : {}),
        ...(o.description ? { description: String(o.description).slice(0, 200) } : {}),
        ...(style ? { style } : {})
      }
    })
    .filter((o): o is AskOption => !!o)

  if (options.length < 1 || options.length > MAX_OPTIONS) {
    return `options must have 1 to ${MAX_OPTIONS} items, each with a label.`
  }

  if (new Set(options.map(o => o.label)).size !== options.length) {
    return 'option labels must be different.'
  }

  return {
    id,
    at: Date.now(),
    prompt,
    options,
    ...(args.allow_custom === true ? { allowCustom: true } : {}),
    ...(args.multi_select === true ? { multi: true } : {}),
    status: 'open'
  }
}

/** The reply message for an answer: picked values (or labels), then any typed text, one per line. */
export function answerText(card: AskCard, picked: string[], custom: string): string {
  const values = card.options.filter(o => picked.includes(o.label)).map(o => o.value || o.label)

  return [...values, custom.trim()].filter(Boolean).join('\n')
}

/** What other bots in a group read for a card. */
export const askSummary = (card: AskCard) => `${card.prompt}\n(Options: ${card.options.map(o => o.label).join(' / ')}${card.allowCustom ? ' / other' : ''})`

// ── 1:1 cards (this device) ─────────────────────────────────────────────────
const key = (chat: string) => `ask-cards:${chat}`

/** chat key (`bot:<name>`) → its cards, oldest first */
export const $askCards = atom<Record<string, AskCard[]>>({})

export function chatCards(chat: string): AskCard[] {
  const cached = $askCards.get()[chat]

  if (cached) {
    return cached
  }

  let list: AskCard[] = []

  try {
    list = JSON.parse(localStorage.getItem(key(chat)) || '[]') || []
  } catch {
    list = []
  }

  $askCards.set({ ...$askCards.get(), [chat]: list })

  return list
}

function saveCards(chat: string, list: AskCard[]) {
  const kept = list.slice(-100)
  $askCards.set({ ...$askCards.get(), [chat]: kept })

  try {
    localStorage.setItem(key(chat), JSON.stringify(kept))
  } catch {
    /* kept for this session */
  }
}

export function addChatCard(chat: string, card: AskCard) {
  // A new question replaces any still-open one.
  saveCards(chat, [...chatCards(chat).map(c => (c.status === 'open' ? { ...c, status: 'dismissed' as const } : c)), card])
}

export function updateChatCard(chat: string, id: string, patch: Partial<AskCard>) {
  saveCards(
    chat,
    chatCards(chat).map(c => (c.id === id ? { ...c, ...patch } : c))
  )
}

/** A typed message: every open card in this chat goes unanswered. */
export function dismissChatCards(chat: string) {
  const list = chatCards(chat)

  if (list.some(c => c.status === 'open')) {
    saveCards(
      chat,
      list.map(c => (c.status === 'open' ? { ...c, status: 'dismissed' as const } : c))
    )
  }
}

export const isAskTool = (name: string) => /(^|__)ask_user$/.test(name)
