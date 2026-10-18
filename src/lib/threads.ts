/**
 * Threads: replies that sit under one message (the ROOT) instead of the main timeline.
 *
 * - Groups: a reply is a log entry with `threadOf` = the root entry's id (synced with the log).
 * - 1:1: the user's thread message carries a hidden `Thread root: <id>` line in its context, so a
 *   reload reads it back from Hermes's transcript; the bot's answer to it (everything up to the next
 *   user message) belongs to the same thread. `reply_in_thread` posts from the bot are kept on this
 *   device. Root ids in 1:1: a user message's `u…` id, or `b…` (a hash of a bot message's key).
 *
 * Replying to a reply always attaches to the same root.
 */
import { atom } from 'nanostores'

import { hash, messageKeys } from './reactions'
import type { ChatMsg } from './types'

export const threadLine = (root: string) => `Thread root: ${root}`
const THREAD_LINE = /(?:^|\n)Thread root: ([ub][0-9a-z]{4,16})(?:\n|$)/

export const threadFromRaw = (raw: string): string | undefined => raw.match(THREAD_LINE)?.[1]

export const excerpt = (text: string, max = 120) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** What the bot reads before a thread message. */
export const threadNote = (root: string, rootText: string) =>
  `[In thread on message ${root}: "${excerpt(rootText) || '(attachment)'}"] The user wrote this as a reply in that thread; your reply goes into the same thread.`

/** 1:1 root ids, by message id. */
export function chatRootIds(messages: ChatMsg[]): Map<string, string> {
  const keys = messageKeys(messages)
  const out = new Map<string, string>()

  for (const msg of messages) {
    if (msg.role === 'user' && msg.ref) {
      out.set(msg.id, msg.ref)
    } else if (msg.role === 'assistant' && !msg.streaming) {
      const key = keys.get(msg.id)

      if (key) {
        out.set(msg.id, `b${hash(key).padStart(6, '0').slice(-6)}`)
      }
    }
  }

  return out
}

/** 1:1: a threaded user message and the bot's answer after it (up to the next user message) share its thread. */
export function assignChatThreads(messages: ChatMsg[]): ChatMsg[] {
  let current: string | undefined

  return messages.map(msg => {
    if (msg.role === 'user') {
      current = msg.thread

      return msg
    }

    return current && !msg.thread && !msg.note ? { ...msg, thread: current } : msg
  })
}

export interface ThreadSummary {
  count: number
  at: number
  who: string[]
}

/**
 * Splits a timeline into the main view and its threads. `rootOf` gives each message's root id
 * (the id replies point at). Replies to a reply are folded onto that reply's root.
 */
export function splitThreads(messages: ChatMsg[], rootOf: (msg: ChatMsg) => string | undefined) {
  const byRoot = new Map<string, ChatMsg>()
  const parentOfRoot = new Map<string, string>()

  for (const msg of messages) {
    const id = rootOf(msg)

    if (id) {
      byRoot.set(id, msg)

      if (msg.thread) {
        parentOfRoot.set(id, msg.thread)
      }
    }
  }

  const top = (id: string) => {
    let at = id

    for (let i = 0; i < 20 && parentOfRoot.has(at); i++) {
      at = parentOfRoot.get(at) as string
    }

    return at
  }

  const threads = new Map<string, ChatMsg[]>()
  const main: ChatMsg[] = []

  for (const msg of messages) {
    if (msg.thread && byRoot.has(top(msg.thread))) {
      const root = top(msg.thread)
      threads.set(root, [...(threads.get(root) || []), msg])
    } else {
      main.push(msg)
    }
  }

  const withSummary = main.map(msg => {
    const id = rootOf(msg)
    const replies = id ? threads.get(id) : undefined

    if (!id) {
      return msg
    }

    const shown = (replies || []).filter(r => r.text.trim() || r.files?.length || r.attachments?.length || r.ask)
    const summary: ThreadSummary | undefined = shown.length
      ? { count: shown.length, at: Math.max(...shown.map(r => r.at || 0)), who: [...new Set(shown.map(r => (r.role === 'user' ? 'user' : r.from || '')))] }
      : undefined

    return { ...msg, threadId: id, ...(summary ? { replies: summary } : {}) }
  })

  return { main: withSummary, threads, root: (id: string) => byRoot.get(top(id)) }
}

// ── 1:1 bot replies posted with reply_in_thread (this device) ─────────────────
export interface ThreadPost {
  id: string
  at: number
  root: string
  text: string
}

const key = (chat: string) => `thread-posts:${chat}`

export const $threadPosts = atom<Record<string, ThreadPost[]>>({})

export function chatThreadPosts(chat: string): ThreadPost[] {
  const cached = $threadPosts.get()[chat]

  if (cached) {
    return cached
  }

  let list: ThreadPost[] = []

  try {
    list = JSON.parse(localStorage.getItem(key(chat)) || '[]') || []
  } catch {
    list = []
  }

  $threadPosts.set({ ...$threadPosts.get(), [chat]: list })

  return list
}

export function addThreadPost(chat: string, post: ThreadPost) {
  const list = [...chatThreadPosts(chat), post].slice(-500)
  $threadPosts.set({ ...$threadPosts.get(), [chat]: list })

  try {
    localStorage.setItem(key(chat), JSON.stringify(list))
  } catch {
    /* session only */
  }
}

/** The thread pane: which chat (`bot:<name>` / `room:<id>`) and which root. */
export const $openThread = atom<{ scope: string; root: string } | null>(null)
