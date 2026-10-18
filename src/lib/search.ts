/**
 * Search across every chat: each bot's 1:1 history, every group log, thread replies, file names and
 * card prompts. It searches what the app already holds in memory (messages as displayed, so hidden
 * context lines such as message ids are never searched; secret values are never in chat).
 *
 * Bot chats that aren't loaded yet: Hermes's own full-text search (`GET /api/sessions/search`,
 * FTS5, per profile) says which bots have a match, and only those chats are loaded. Without that
 * endpoint, unloaded chats are loaded a few at a time. Per-chat documents are cached by the
 * message list they came from, so typing re-filters without rebuilding.
 */
import { atom } from 'nanostores'

import { $askCards, chatCards } from './ask'
import { $filePosts, chatFilePosts } from './bot-files'
import { $chats, loadBotChat } from './chat'
import { $helpCards, chatHelpCards } from './handoff'
import { native } from './native'
import { hostHttp } from './hosts'
import { $rooms } from './rooms'
import { $secretCards, chatSecretCards } from './secrets'
import { $active, $allBots } from './store'
import { $threadPosts, assignChatThreads, chatThreadPosts } from './threads'
import type { ChatMsg, Room } from './types'

export interface SearchDoc {
  /** `bot:<name>` or `room:<roomId>`. */
  scope: string
  /** Bot name or room key, to select the chat. */
  target: { kind: 'bot'; id: string } | { kind: 'room'; id: string }
  id: string
  text: string
  at: number
  fromMe: boolean
  /** Bot name for bot messages. */
  from?: string
  /** A thread reply: its root's id. */
  thread?: string
  /** What kind of thing matched, shown as a small label. */
  kind: 'message' | 'file' | 'card'
}

export interface SearchFilters {
  /** A chat scope, or '' for all. */
  scope: string
  who: 'all' | 'me' | 'bots'
}

export const $searchPalette = atom(false)
/** A result to scroll to once its chat is showing: the chat's Thread finds it, scrolls and flashes it. */
export const $jumpTo = atom<{ scope: string; id: string; at: number } | null>(null)

// ── documents ───────────────────────────────────────────────────────────────
const msgCache = new WeakMap<object, SearchDoc[]>()

function chatDocs(name: string, messages: ChatMsg[]): SearchDoc[] {
  const hit = msgCache.get(messages)

  if (hit) {
    return hit
  }

  const scope = `bot:${name}`
  const target = { kind: 'bot' as const, id: name }
  const docs: SearchDoc[] = []

  for (const msg of assignChatThreads(messages)) {
    if ((msg.role !== 'user' && msg.role !== 'assistant') || msg.streaming) {
      continue
    }

    const base = { scope, target, id: msg.id, at: msg.at || 0, fromMe: msg.role === 'user', ...(msg.role === 'assistant' ? { from: name } : {}), ...(msg.thread ? { thread: msg.thread } : {}) }

    if (msg.text.trim()) {
      docs.push({ ...base, text: msg.text, kind: 'message' })
    }

    for (const att of msg.attachments || []) {
      docs.push({ ...base, text: att.name, kind: 'file' })
    }
  }

  msgCache.set(messages, docs)

  return docs
}

function chatExtras(name: string): SearchDoc[] {
  const scope = `bot:${name}`
  const target = { kind: 'bot' as const, id: name }
  const docs: SearchDoc[] = []
  const bot = { scope, target, fromMe: false, from: name }

  for (const card of $askCards.get()[scope] || chatCards(scope)) {
    docs.push({ ...bot, id: card.id, at: card.at, text: [card.prompt, ...card.options.map(o => o.label)].join(' · '), kind: 'card' })
  }

  for (const card of $secretCards.get()[scope] || chatSecretCards(scope)) {
    // The label and name only; values never reach chat.
    docs.push({ ...bot, id: card.id, at: card.at, text: `${card.label} (${card.name})`, kind: 'card' })
  }

  for (const card of $helpCards.get()[scope] || chatHelpCards(scope)) {
    docs.push({ ...bot, id: card.id, at: card.at, text: card.instruction, kind: 'card' })
  }

  for (const post of $filePosts.get()[scope] || chatFilePosts(scope)) {
    const thread = post.thread ? { thread: post.thread } : {}

    if (post.caption) docs.push({ ...bot, ...thread, id: post.id, at: post.at, text: post.caption, kind: 'message' })
    for (const file of post.files) docs.push({ ...bot, ...thread, id: post.id, at: post.at, text: file.name, kind: 'file' })
  }

  for (const post of $threadPosts.get()[scope] || chatThreadPosts(scope)) {
    docs.push({ ...bot, id: post.id, at: post.at, text: post.text, thread: post.root, kind: 'message' })
  }

  return docs
}

const roomCache = new WeakMap<object, SearchDoc[]>()

function roomDocs(room: Room): SearchDoc[] {
  const hit = roomCache.get(room.log)

  if (hit) {
    return hit
  }

  const scope = `room:${room.roomId}`
  const target = { kind: 'room' as const, id: room.key }
  const docs: SearchDoc[] = []

  for (const entry of room.log) {
    const base = {
      scope,
      target,
      id: entry.id,
      at: entry.at,
      fromMe: entry.from.kind === 'user',
      ...(entry.from.kind === 'member' ? { from: entry.from.name } : {}),
      ...(entry.threadOf ? { thread: entry.threadOf } : {})
    }

    if (entry.ask) docs.push({ ...base, text: [entry.ask.prompt, ...entry.ask.options.map(o => o.label)].join(' · '), kind: 'card' })
    else if (entry.helpAsk) docs.push({ ...base, text: entry.helpAsk.instruction, kind: 'card' })
    else if (entry.text.trim()) docs.push({ ...base, text: entry.text, kind: 'message' })

    for (const att of entry.attachments || []) docs.push({ ...base, text: att.name, kind: 'file' })
    for (const file of entry.files || []) docs.push({ ...base, text: file.name, kind: 'file' })
  }

  roomCache.set(room.log, docs)

  return docs
}

export function allDocs(): SearchDoc[] {
  const chats = $chats.get()
  const docs: SearchDoc[] = []

  for (const bot of $allBots.get()) {
    docs.push(...chatDocs(bot.name, chats[bot.name]?.messages || []), ...chatExtras(bot.name))
  }

  for (const room of Object.values($rooms.get())) {
    docs.push(...roomDocs(room))
  }

  return docs
}

// ── matching ────────────────────────────────────────────────────────────────
/** Case- and accent-insensitive, one UTF-16 unit per unit so match offsets line up with the text. */
const fold = (text: string) =>
  text
    .split('')
    .map(c => (c.charCodeAt(0) < 128 ? c.toLowerCase() : c.normalize('NFD').charAt(0).toLowerCase().charAt(0) || c))
    .join('')

/** Markdown markers out of the way of snippets. */
const plain = (text: string) => text.replace(/\*\*|__|~~|`+/g, '').replace(/^#{1,6}\s+/gm, '')

export const terms = (query: string) => fold(query).split(/\s+/).filter(Boolean).slice(0, 8)

export interface SearchHit {
  doc: SearchDoc
  snippet: string
  /** [start, end) ranges in `snippet` to highlight. */
  marks: [number, number][]
}

/** A short window of the text around the first match, with every term's matches marked. */
export function snippetOf(text: string, words: string[], width = 140): { snippet: string; marks: [number, number][] } {
  const flat = plain(text).replace(/\s+/g, ' ').trim()
  const lower = fold(flat)
  const first = Math.min(...words.map(w => lower.indexOf(w)).filter(i => i >= 0), flat.length)
  const start = flat.length <= width ? 0 : Math.max(0, Math.min(first - 40, flat.length - width))
  const end = Math.min(flat.length, start + width)
  const prefix = start > 0 ? '…' : ''
  const snippet = prefix + flat.slice(start, end) + (end < flat.length ? '…' : '')
  const marks: [number, number][] = []
  const low = fold(snippet)

  for (const word of words) {
    let at = low.indexOf(word)

    while (at >= 0 && marks.length < 40) {
      marks.push([at, at + word.length])
      at = low.indexOf(word, at + word.length)
    }
  }

  return { snippet, marks: marks.sort((a, b) => a[0] - b[0]) }
}

export const MAX_HITS = 200

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Not a letter or digit: where a whole word may start or end. */
const EDGE = '(?:^|[^\\p{L}\\p{N}])'
const EDGE_END = '(?:$|[^\\p{L}\\p{N}])'

/**
 * How well a matching text matches, best first: 2 = the query as typed (whole words, in order),
 * 1 = every word as a whole word, 0 = only inside other words ("on" in "done"). Every hit has every
 * word somewhere; this decides which come first, newest first within a tier.
 */
function tierOf(words: string[]) {
  const phrase = new RegExp(EDGE + words.map(escapeRe).join('\\s+') + EDGE_END, 'u')
  const whole = words.map(word => new RegExp(EDGE + escapeRe(word) + EDGE_END, 'u'))

  return (lower: string) => (phrase.test(lower) ? 2 : whole.every(re => re.test(lower)) ? 1 : 0)
}

export function searchDocs(docs: SearchDoc[], query: string, filters: SearchFilters): SearchHit[] {
  const words = terms(query)

  if (!words.length) {
    return []
  }

  const hits: (SearchHit & { tier: number })[] = []
  const tier = tierOf(words)

  for (const doc of docs) {
    if ((filters.scope && doc.scope !== filters.scope) || (filters.who === 'me' && !doc.fromMe) || (filters.who === 'bots' && doc.fromMe)) {
      continue
    }

    const lower = fold(doc.text)

    if (words.every(word => lower.includes(word))) {
      hits.push({ doc, tier: tier(lower), ...snippetOf(doc.text, words) })
    }
  }

  return hits
    .sort((a, b) => b.tier - a.tier || b.doc.at - a.doc.at)
    .slice(0, MAX_HITS)
    .map(({ tier: _tier, ...hit }) => hit)
}

// ── loading bot chats that aren't in memory yet ──────────────────────────────
async function hermesHasMatch(profile: string, query: string): Promise<boolean | null> {
  const active = $active.get()

  if (!active) {
    return null
  }

  try {
    const res = await hostHttp({ baseUrl: active.baseUrl, token: active.token, method: 'GET', path: `api/sessions/search?q=${encodeURIComponent(query)}&limit=5&profile=${encodeURIComponent(profile)}`, timeoutMs: 10_000 })

    return res.ok ? (Array.isArray(res.json?.results) ? res.json.results.length > 0 : null) : null
  } catch {
    return null
  }
}

const loadedFor = new Set<string>()

/** Loads the bot chats that may hold `query`; resolves when done. Already-loaded chats are skipped. */
export async function loadMatchingChats(query: string, onProgress: () => void) {
  const pending = $allBots.get().filter(bot => !$chats.get()[bot.name]?.messages.length && !loadedFor.has(bot.name))

  if (!pending.length || !$active.get()) {
    return
  }

  let next = 0
  const worker = async () => {
    while (next < pending.length) {
      const bot = pending[next++]
      const has = await hermesHasMatch(bot.name, query)

      if (has === false) {
        continue
      }

      loadedFor.add(bot.name)
      await loadBotChat(bot.name)
      onProgress()
    }
  }

  await Promise.all([worker(), worker(), worker()])
}
