/**
 * Memory, per bot and shared.
 *
 * Per bot: Hermes's built-in memory is two small files in each profile, `memories/MEMORY.md` (the
 * bot's own notes) and `memories/USER.md` (what it knows about the user). Entries are separated by
 * a line holding only `§`. The bot writes them with its `memory` tool, and Hermes loads both into
 * the system prompt when a session starts. The app reads and edits the same files through Hermes's
 * `/api/fs/read-text` and `/api/fs/write-text`, inside the profile folder `profiles.list` reports.
 *
 * Shared: facts about the user that every bot sees. They live in the default profile's
 * `ui_meta['hermes-bots-memory']` (where the group list lives too) and go out with each turn in
 * the team directory (team.ts, resent only when it changes). A bot adds one by saving it with its
 * memory tool (target "user"): after the bot's turn the app copies new USER.md entries in here.
 */
import { atom, computed } from 'nanostores'

import { gateway } from './gateway'
import { native } from './native'
import { hostHttp } from './hosts'
import { $active, $profiles, refreshProfiles } from './store'
import type { ProfileRow } from './types'

export type MemoryTarget = 'memory' | 'user'

export const ENTRY_DELIMITER = '\n§\n'
const FILES: Record<MemoryTarget, string> = { memory: 'MEMORY.md', user: 'USER.md' }
/** Hermes's defaults for `memory.memory_char_limit` / `memory.user_char_limit`. */
const DEFAULT_LIMITS: Record<MemoryTarget, number> = { memory: 2200, user: 1375 }

export interface BotMemory {
  notes: string[]
  user: string[]
  limits: Record<MemoryTarget, number>
  /** `memory.memory_enabled` / `memory.user_profile_enabled` in the bot's config. */
  enabled: Record<MemoryTarget, boolean>
}

type MemoryState = BotMemory | 'loading' | { error: string }

export const $botMemory = atom<Record<string, MemoryState>>({})

export const isMemory = (state: MemoryState | undefined): state is BotMemory => Boolean(state && typeof state === 'object' && 'notes' in state)

let preview = false

/** Design preview: sample memory, and edits stay in this window. */
export function seedMemoryPreview(bots: Record<string, BotMemory>) {
  preview = true
  $botMemory.set(bots)
}

const parse = (raw: string) =>
  raw
    .split(ENTRY_DELIMITER)
    .map(entry => entry.trim())
    .filter(Boolean)

export const usage = (entries: string[]) => entries.join(ENTRY_DELIMITER).length

// ── files on the Hermes machine ───────────────────────────────────────────
async function api(method: string, path: string, body?: unknown, who?: string) {
  const active = $active.get()

  if (!active) {
    throw new Error('Not connected to Hermes')
  }

  return hostHttp({ baseUrl: active.baseUrl, token: active.token, method, path, body, timeoutMs: 20_000 }, who)
}

const detailOf = (res: { status: number; json: any; text?: string }) =>
  String(res.json?.detail || res.text || `Hermes answered ${res.status}`)

/** A file's text, or '' when it doesn't exist yet. */
async function readText(path: string, who?: string): Promise<string> {
  const res = await api('GET', `api/fs/read-text?path=${encodeURIComponent(path)}`, undefined, who)

  if (res.status === 404 && /file not found/i.test(detailOf(res))) {
    return ''
  }

  if (res.status === 404) {
    throw new Error("This Hermes doesn't have the file API the app uses for memory. Update Hermes to edit memory here.")
  }

  if (!res.ok) {
    throw new Error(`Couldn't read ${path}: ${detailOf(res)}`)
  }

  if (res.json?.truncated) {
    throw new Error(`${path} is too large to edit here`)
  }

  return String(res.json?.text || '')
}

async function writeText(path: string, content: string, who?: string) {
  const res = await api('POST', 'api/fs/write-text', { path, content }, who)

  if (!res.ok && /parent directory/i.test(detailOf(res))) {
    throw new Error("This bot has no memory folder yet. Send it a message first and Hermes will set one up.")
  }

  if (!res.ok) {
    throw new Error(`Couldn't save ${path}: ${detailOf(res)}`)
  }
}

function rowOf(name: string): ProfileRow {
  const row = $profiles.get().find(entry => entry.name === name)

  if (!row?.path) {
    throw new Error(`Hermes didn't say where ${name}'s profile is`)
  }

  return row
}

/** `<profile>/memories/<file>`, with the separator the Hermes machine uses. */
export function memoryPath(profilePath: string, target: MemoryTarget) {
  const sep = profilePath.includes('\\') && !profilePath.includes('/') ? '\\' : '/'

  return [profilePath.replace(/[\\/]+$/, ''), 'memories', FILES[target]].join(sep)
}

async function readEntries(name: string, target: MemoryTarget) {
  return parse(await readText(memoryPath(rowOf(name).path as string, target), name))
}

// ── per bot ───────────────────────────────────────────────────────────────
export async function loadBotMemory(name: string, force = false) {
  if (preview) {
    return
  }

  const existing = $botMemory.get()[name]

  if (!force && existing && (existing === 'loading' || isMemory(existing))) {
    return
  }

  if (!isMemory(existing)) {
    $botMemory.set({ ...$botMemory.get(), [name]: 'loading' })
  }

  try {
    const [notes, user, full] = await Promise.all([
      readEntries(name, 'memory'),
      readEntries(name, 'user'),
      gateway.request<any>('config.get', { key: 'full', profile: name }, 30_000).catch(() => null)
    ])
    const mem = (full?.config?.memory || {}) as Record<string, unknown>
    const num = (value: unknown, fallback: number) => (Number(value) > 0 ? Number(value) : fallback)
    const on = (value: unknown) => !['false', '0', 'no', 'off'].includes(String(value ?? 'true').toLowerCase())

    $botMemory.set({
      ...$botMemory.get(),
      [name]: {
        notes,
        user,
        limits: { memory: num(mem.memory_char_limit, DEFAULT_LIMITS.memory), user: num(mem.user_char_limit, DEFAULT_LIMITS.user) },
        enabled: { memory: on(mem.memory_enabled), user: on(mem.user_profile_enabled) }
      }
    })
  } catch (error) {
    $botMemory.set({ ...$botMemory.get(), [name]: { error: String((error as Error).message || error) } })
  }
}

// ── telling the bot about your edits ──────────────────────────────────────
// Hermes reads memory into a chat's instructions when the chat starts, and a long chat keeps those
// instructions. So the app also lists your recent edits in the bot's team directory (team.ts),
// which reaches every one of its chats on the next turn.
const EDITS_KEY = 'memory-edits:v1'
const MAX_EDITS = 6

function readEdits(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(EDITS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

export const $memoryEdits = atom<Record<string, string[]>>(readEdits())

const clip = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function logEdit(name: string, target: MemoryTarget, change: MemoryEdit) {
  const where = target === 'memory' ? 'your notes' : 'what you know about the user'
  const line =
    'add' in change
      ? `added to ${where}: "${clip(change.add)}"`
      : 'remove' in change || !change.to.trim()
        ? `removed from ${where}: "${clip('remove' in change ? change.remove : change.edit)}"`
        : `changed in ${where}: "${clip(change.edit, 100)}" is now "${clip(change.to)}"`
  const next = { ...$memoryEdits.get(), [name]: [...($memoryEdits.get()[name] || []), line].slice(-MAX_EDITS) }
  $memoryEdits.set(next)

  try {
    localStorage.setItem(EDITS_KEY, JSON.stringify(next))
  } catch {
    /* still sent this session */
  }
}

export type MemoryEdit = { add: string } | { edit: string; to: string } | { remove: string }

function applyEdit(entries: string[], change: MemoryEdit): string[] {
  if ('add' in change) {
    const text = change.add.trim()

    return !text || entries.includes(text) ? entries : [...entries, text]
  }

  const old = 'edit' in change ? change.edit : change.remove
  const index = entries.indexOf(old)

  if (index < 0) {
    throw new Error('That entry changed since you opened it. Showing the latest.')
  }

  if ('remove' in change) {
    return entries.filter((_, i) => i !== index)
  }

  const text = change.to.trim()

  return text ? entries.map((entry, i) => (i === index ? text : entry)) : entries.filter((_, i) => i !== index)
}

/**
 * Add, change or remove one entry in a bot's MEMORY.md or USER.md. Reads the file fresh first, so
 * an entry the bot saved a moment ago isn't lost, and keeps Hermes's size limit.
 */
export async function editBotMemory(name: string, target: MemoryTarget, change: MemoryEdit) {
  const state = $botMemory.get()[name]
  const key = target === 'memory' ? 'notes' : 'user'
  const limit = isMemory(state) ? state.limits[target] : DEFAULT_LIMITS[target]

  try {
    const current = preview && isMemory(state) ? state[key] : await readEntries(name, target)
    const next = applyEdit(current, change)

    if (usage(next) > limit && usage(next) > usage(current)) {
      throw new Error(`That's over this bot's limit (${usage(next).toLocaleString()} of ${limit.toLocaleString()} characters). Shorten or remove something first.`)
    }

    if (!preview) {
      await writeText(memoryPath(rowOf(name).path as string, target), next.join(ENTRY_DELIMITER), name)
    }

    if (next !== current) {
      logEdit(name, target, change)
    }

    const latest = $botMemory.get()[name]

    if (isMemory(latest)) {
      $botMemory.set({ ...$botMemory.get(), [name]: { ...latest, [key]: next } })
    }
  } catch (error) {
    void loadBotMemory(name, true)
    throw error
  }
}

// ── shared about the user ─────────────────────────────────────────────────
export const SHARED_KEY = 'hermes-bots-memory'
const MAX_SEEN = 600

export interface SharedFact {
  id: string
  text: string
  /** Who added it: a bot's profile name, or '' for you. */
  by: string
  at: number
}

interface SharedEnvelope {
  facts: SharedFact[]
  /** Fingerprints of USER.md entries already copied in or deleted here, so they aren't copied again. */
  seen: string[]
}

const defaultRow = (rows = $profiles.get()) => rows.find(row => row.name === 'default') || rows.find(row => row.is_default)

function envelopeOf(row: ProfileRow | undefined): SharedEnvelope {
  const raw = (row?.ui_meta?.[SHARED_KEY] || {}) as Partial<SharedEnvelope>

  return {
    facts: Array.isArray(raw.facts) ? raw.facts.filter(f => f && typeof f.text === 'string' && f.text.trim()) : [],
    seen: Array.isArray(raw.seen) ? raw.seen.map(String) : []
  }
}

export const $sharedFacts = computed($profiles, rows => envelopeOf(defaultRow(rows)).facts)

/** One fact's identity: its text, ignoring case and spacing. */
export function fingerprint(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim().toLowerCase()
  let h = 5381

  for (let i = 0; i < flat.length; i++) {
    h = ((h << 5) + h + flat.charCodeAt(i)) | 0
  }

  return (h >>> 0).toString(36)
}

let uid = 0
const newFactId = () => `f${Date.now().toString(36)}${(uid++).toString(36)}`

function putLocal(row: ProfileRow, envelope: SharedEnvelope, revisions?: Record<string, number>) {
  $profiles.set(
    $profiles.get().map(entry =>
      entry.name === row.name
        ? {
            ...entry,
            ui_meta: { ...(entry.ui_meta || {}), [SHARED_KEY]: envelope as unknown as Record<string, unknown> },
            ui_meta_revisions: { ...(entry.ui_meta_revisions || {}), ...(revisions || {}) }
          }
        : entry
    )
  )
}

/** Compare-and-swap write of the shared list on the default profile; re-reads and retries on a clash. */
async function saveShared(update: (envelope: SharedEnvelope) => SharedEnvelope | null) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = defaultRow()

    if (!row) {
      throw new Error('No default profile to keep shared memory in')
    }

    const next = update(envelopeOf(row))

    if (!next) {
      return
    }

    next.seen = next.seen.slice(-MAX_SEEN)

    if (preview) {
      putLocal(row, next)

      return
    }

    const revision = row.ui_meta_revisions?.[SHARED_KEY]
    const result = await gateway.request<any>('profiles.configure', {
      name: row.name,
      profile: row.name,
      ui_meta: { [SHARED_KEY]: next },
      ...(typeof revision === 'number' ? { ui_meta_expected_revisions: { [SHARED_KEY]: revision } } : {})
    })

    if (result?.applied?.ui_meta_conflicts && Object.keys(result.applied.ui_meta_conflicts).length) {
      await refreshProfiles()
      continue
    }

    putLocal(row, next, result?.applied?.ui_meta_revisions)

    return
  }

  throw new Error('Another device keeps changing shared memory. Try again.')
}

export const addSharedFact = (text: string, by = '') =>
  saveShared(envelope => {
    const clean = text.trim()

    if (!clean || envelope.facts.some(f => fingerprint(f.text) === fingerprint(clean))) {
      return null
    }

    return { facts: [...envelope.facts, { id: newFactId(), text: clean, by, at: Date.now() }], seen: [...envelope.seen, fingerprint(clean)] }
  })

function changeShared(id: string, text: string) {
  let before = ''

  return saveShared(envelope => {
    const clean = text.trim()
    const old = envelope.facts.find(f => f.id === id)

    if (!old || old.text === clean) {
      return null
    }

    before = old.text

    return {
      facts: clean ? envelope.facts.map(f => (f.id === id ? { ...f, text: clean } : f)) : envelope.facts.filter(f => f.id !== id),
      seen: [...envelope.seen, fingerprint(old.text), ...(clean ? [fingerprint(clean)] : [])]
    }
  }).then(() => before)
}

/**
 * A shared fact also lives in the USER.md of any bot that saved it, so an edit or delete is made
 * there too (best effort), or that bot would keep the old version.
 */
async function propagate(before: string, text: string) {
  if (!before) {
    return
  }

  const fp = fingerprint(before)

  for (const row of $profiles.get().filter(entry => entry.path)) {
    try {
      const state = $botMemory.get()[row.name]
      const entries = preview ? (isMemory(state) ? state.user : []) : await readEntries(row.name, 'user')
      const match = entries.find(entry => fingerprint(entry) === fp)

      if (match) {
        await editBotMemory(row.name, 'user', text.trim() ? { edit: match, to: text } : { remove: match })
      }
    } catch {
      /* that bot keeps its copy */
    }
  }
}

export const editSharedFact = async (id: string, text: string) => propagate(await changeShared(id, text), text)

/** Deleting also remembers the text, so the same entry is never copied back in. */
export const removeSharedFact = (id: string) => editSharedFact(id, '')

/**
 * Copies USER.md entries the given bots saved since last time into shared memory. Entries already
 * shared, or deleted here before, are skipped.
 */
export async function importUserFacts(names: string[]) {
  if (preview || !defaultRow()) {
    return 0
  }

  const found: { text: string; by: string }[] = []

  for (const name of names) {
    try {
      for (const text of await readEntries(name, 'user')) {
        found.push({ text, by: name })
      }
    } catch {
      /* a bot we can't read just isn't imported this time */
    }
  }

  let added = 0

  await saveShared(envelope => {
    const known = new Set([...envelope.seen, ...envelope.facts.map(f => fingerprint(f.text))])
    const fresh: SharedFact[] = []

    for (const item of found) {
      const fp = fingerprint(item.text)

      if (!known.has(fp)) {
        known.add(fp)
        fresh.push({ id: newFactId(), text: item.text, by: item.by, at: Date.now() })
      }
    }

    added = fresh.length

    return fresh.length ? { facts: [...envelope.facts, ...fresh], seen: [...envelope.seen, ...fresh.map(f => fingerprint(f.text))] } : null
  })

  return added
}

/** Every bot's USER.md, on connect and when the Shared memory view opens. */
export const syncSharedMemory = () => importUserFacts($profiles.get().filter(row => row.path).map(row => row.name)).catch(() => 0)

const pendingImports = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * After a bot's turn: pick up anything it saved about the user (debounced per bot, and a little
 * late so a save Hermes makes just after the reply is caught too).
 */
export function noteTurnEnd(name: string) {
  if (preview) {
    return
  }

  clearTimeout(pendingImports.get(name))
  pendingImports.set(
    name,
    setTimeout(() => {
      pendingImports.delete(name)
      void importUserFacts([name]).catch(() => undefined)
    }, 4000)
  )
}

/** The shared facts as bullet lines for the team directory, newest kept when there are too many. */
export function sharedFactLines(facts: SharedFact[], maxChars = 2400): string[] {
  const out: string[] = []
  let size = 0

  for (const fact of [...facts].reverse()) {
    const line = `- ${fact.text.replace(/\s+/g, ' ').trim()}`

    if (size + line.length > maxChars) {
      break
    }

    out.unshift(line)
    size += line.length + 1
  }

  return out
}
