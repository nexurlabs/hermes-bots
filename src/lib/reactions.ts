/**
 * Reactions: one emoji per reactor per message, as a small pill under the bubble.
 *
 * - The user reacts to a bot's message from the hover button; the bot gets a quiet note in its
 *   next prompt ("[The user reacted 👍 to your message …]") but isn't woken for it.
 * - A bot reacts with the app's `react_to_message` tool (the `hermes-bots-groups` MCP server).
 *   It addresses messages by the ids it sees in its prompt: `Message id: u…` in the hidden
 *   context of each 1:1 message, `[g…]` before each line of a group prompt.
 * - Same emoji again removes the reaction; a different one replaces it.
 *
 * Storage: group reactions live on the room's log entries (saved and synced with the log). 1:1
 * chats come from Hermes's transcript, which has nowhere to keep them, so they're kept on this
 * device in localStorage, keyed by the user message's id or, for a bot's message, by its text.
 */
import { atom } from 'nanostores'

import type { ChatMsg } from './types'

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '✅', '👀', '🙏', '🔥', '😮', '😢'] as const

/** reactor (`user` or a bot's profile name) → emoji */
export type Reactions = Record<string, string>

export const USER = 'user'

// ── emoji ───────────────────────────────────────────────────────────────────
/** One emoji (a single grapheme with an emoji code point, at most a short ZWJ sequence), or null. */
export function cleanEmoji(raw: unknown): null | string {
  const text = String(raw ?? '').trim()

  if (!text || text.length > 16) {
    return null
  }

  let parts = [text]

  try {
    const Seg = (Intl as any).Segmenter

    if (Seg) {
      parts = Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(text), (s: any) => String(s.segment))
    }
  } catch {
    /* fall back to the whole string */
  }

  if (parts.length !== 1) {
    return null
  }

  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text) ? text : null
}

/** Same emoji again removes it; anything else replaces this reactor's reaction. */
export function toggle(current: Reactions | undefined, reactor: string, emoji: string): Reactions {
  const next = { ...(current || {}) }

  if (next[reactor] === emoji) {
    delete next[reactor]
  } else {
    next[reactor] = emoji
  }

  return next
}

/** Pills to draw: one per emoji, with who reacted, in first-reacted order. */
export function pills(reactions: Reactions | undefined): { emoji: string; who: string[] }[] {
  const out: { emoji: string; who: string[] }[] = []

  for (const [who, emoji] of Object.entries(reactions || {})) {
    const pill = out.find(p => p.emoji === emoji)
    pill ? pill.who.push(who) : out.push({ emoji, who: [who] })
  }

  return out
}

// ── ids bots can see ────────────────────────────────────────────────────────
export function hash(text: string) {
  let h = 5381

  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }

  return (h >>> 0).toString(36)
}

/** A group entry's short id as bots see it: `g` + 6 base-36 characters. */
export const roomRef = (entryId: string) => `g${hash(entryId).padStart(6, '0').slice(-6)}`

/** The line in a 1:1 message's hidden context that names it. */
export const refLine = (ref: string) => `Message id: ${ref}`
const REF_LINE = /(?:^|\n)Message id: (u[0-9a-z]{4,16})(?:\n|$)/

/** The id a 1:1 user message was sent with (read back from its raw text, context included). */
export function refFromRaw(raw: string): string | undefined {
  return raw.match(REF_LINE)?.[1]
}

export const normalizeRef = (raw: unknown) =>
  String(raw ?? '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/^message id:\s*/i, '')
    .toLowerCase()

// ── 1:1 chats (this device) ─────────────────────────────────────────────────
const storeKey = (chat: string) => `reactions:${chat}`

/** chat key (`bot:<name>`) → message key → reactions */
export const $chatReactions = atom<Record<string, Record<string, Reactions>>>({})

export function loadChatReactions(chat: string): Record<string, Reactions> {
  const cached = $chatReactions.get()[chat]

  if (cached) {
    return cached
  }

  let stored: Record<string, Reactions> = {}

  try {
    stored = JSON.parse(localStorage.getItem(storeKey(chat)) || '{}') || {}
  } catch {
    stored = {}
  }

  $chatReactions.set({ ...$chatReactions.get(), [chat]: stored })

  return stored
}

function saveChat(chat: string, map: Record<string, Reactions>) {
  const clean = Object.fromEntries(Object.entries(map).filter(([, r]) => Object.keys(r).length))
  // Keep the newest 500 so localStorage stays small.
  const trimmed = Object.fromEntries(Object.entries(clean).slice(-500))
  $chatReactions.set({ ...$chatReactions.get(), [chat]: trimmed })

  try {
    localStorage.setItem(storeKey(chat), JSON.stringify(trimmed))
  } catch {
    /* quota: kept for this session */
  }
}

/**
 * A stable key for a message in a 1:1 chat, the same before and after a reload (local ids and
 * Hermes's row ids differ): the user message's sent id, else role + text (+ which repeat it is).
 */
export function messageKeys(messages: ChatMsg[]): Map<string, string> {
  const keys = new Map<string, string>()
  const seen = new Map<string, number>()

  for (const msg of messages) {
    if (msg.role === 'user' && msg.ref) {
      keys.set(msg.id, `ref:${msg.ref}`)
      continue
    }

    if ((msg.role !== 'assistant' && msg.role !== 'user') || !msg.text.trim() || msg.streaming) {
      continue
    }

    const base = `${msg.role[0]}:${hash(msg.text.trim())}`
    const n = seen.get(base) || 0
    seen.set(base, n + 1)
    keys.set(msg.id, n ? `${base}#${n}` : base)
  }

  return keys
}

/** Messages with their reactions filled in from this device's store. */
export function withChatReactions(chat: string, messages: ChatMsg[], store: Record<string, Record<string, Reactions>>): ChatMsg[] {
  // Loaded by the view's effect (loadChatReactions); not during render.
  const map = store[chat] || {}
  const keys = messageKeys(messages)

  return messages.map(msg => {
    const key = keys.get(msg.id)
    const reactions = key ? map[key] : undefined

    return reactions && Object.keys(reactions).length ? { ...msg, reactions } : msg
  })
}

/** Toggle a reaction on a 1:1 message. Returns the reactor's emoji afterwards ('' if removed). */
export function reactInChat(chat: string, messages: ChatMsg[], msgId: string, reactor: string, emoji: string): string | null {
  const key = messageKeys(messages).get(msgId)

  if (!key) {
    return null
  }

  return reactByKey(chat, key, reactor, emoji)
}

export function reactByKey(chat: string, key: string, reactor: string, emoji: string): string {
  const map = { ...loadChatReactions(chat) }
  const next = toggle(map[key], reactor, emoji)
  map[key] = next
  saveChat(chat, map)

  return next[reactor] || ''
}

// ── notes for the bot's next turn ────────────────────────────────────────────
const notesKey = (session: string) => `react-notes:${session}`

/** Queue a line for this session's next prompt (it doesn't wake the bot). */
export function queueNote(session: string, line: string) {
  try {
    const list = JSON.parse(localStorage.getItem(notesKey(session)) || '[]') as string[]
    localStorage.setItem(notesKey(session), JSON.stringify([...list, line].slice(-20)))
  } catch {
    /* best effort */
  }
}

/** The queued lines for this session, cleared. */
export function takeNotes(session: string): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(notesKey(session)) || '[]') as string[]
    localStorage.removeItem(notesKey(session))

    return Array.isArray(list) ? list.map(String) : []
  } catch {
    return []
  }
}

export function excerpt(text: string, max = 80) {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The note a bot gets when the user reacts to (or un-reacts from) one of its messages. */
export function userReactionNote(emoji: string, text: string, ref?: string) {
  const which = `${ref ? `[${ref}] ` : ''}"${excerpt(text)}"`

  return emoji ? `[The user reacted ${emoji} to your message ${which}. No reply is needed for this.]` : `[The user removed their reaction from your message ${which}.]`
}

/** Hermes's name for the tool, for hiding react-only turns. */
export const isReactTool = (name: string) => /(^|__)react_to_message$/.test(name)
