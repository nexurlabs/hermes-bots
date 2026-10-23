/**
 * Safe secret entry. A bot asks for a key with `request_secret` (the app's `hermes-bots-groups`
 * MCP server); the user types it into a masked card in the bot's 1:1 chat (never in a group).
 *
 * The value goes straight from the card to Hermes's own credential API, `PUT /api/env?profile=<bot>`,
 * which writes it to that profile's `.env` (merging: same name replaced, others kept; Hermes keeps
 * the file at 0600). It is never put in a message, the model's context, the app's logs, its
 * localStorage, or a group log. The bot is then told only the name. Afterwards the app asks the
 * gateway to re-read the env (`reload.env`), best effort.
 *
 * Cards (name/label/status only) are kept on this device, like question cards.
 */
import { atom } from 'nanostores'

import { gateway } from './gateway'
import { native } from './native'
import { hostHttp } from './hosts'
import { $active } from './store'
import type { SecretCard } from './types'
import { secretKind, type SecretName } from './secret-kinds'

export const NAME_RE = /^[A-Z_][A-Z0-9_]*$/
const MAX_VALUE = 8192

export function parseSecretRequest(args: Record<string, unknown>, id: string): SecretCard | string {
  const name = String(args.name ?? '').trim()

  if (!NAME_RE.test(name) || name.length > 64) {
    return 'name must be an environment variable name: capital letters, digits and _, not starting with a digit (e.g. OPENAI_API_KEY).'
  }

  const label = String(args.label ?? '').trim().slice(0, 80) || name
  const description = String(args.description ?? '').trim().slice(0, 300)

  return { id, at: Date.now(), name, label, ...(description ? { description } : {}), status: 'open' }
}

/** What the bot is told after a save. Never contains the value. */
export const savedNote = (name: string) => `[Secret ${name} saved. It's available as an environment variable; the value is not shown.]`

// ── cards (this device) ─────────────────────────────────────────────────────
const cardsKey = (chat: string) => `secret-cards:${chat}`

export const $secretCards = atom<Record<string, SecretCard[]>>({})

export function chatSecretCards(chat: string): SecretCard[] {
  const cached = $secretCards.get()[chat]

  if (cached) {
    return cached
  }

  let list: SecretCard[] = []

  try {
    list = JSON.parse(localStorage.getItem(cardsKey(chat)) || '[]') || []
  } catch {
    list = []
  }

  $secretCards.set({ ...$secretCards.get(), [chat]: list })

  return list
}

function saveCards(chat: string, list: SecretCard[]) {
  const kept = list.slice(-50)
  $secretCards.set({ ...$secretCards.get(), [chat]: kept })

  try {
    localStorage.setItem(cardsKey(chat), JSON.stringify(kept))
  } catch {
    /* session only */
  }
}

export function addSecretCard(chat: string, card: SecretCard) {
  // Asking again for the same name replaces the open card.
  saveCards(chat, [...chatSecretCards(chat).filter(c => !(c.status === 'open' && c.name === card.name)), card])
}

export function updateSecretCard(chat: string, id: string, status: SecretCard['status']) {
  saveCards(
    chat,
    chatSecretCards(chat).map(c => (c.id === id ? { ...c, status } : c))
  )
}

// ── Hermes's credential API ─────────────────────────────────────────────────
async function api(method: string, path: string, body?: unknown) {
  const active = $active.get()

  if (!active) {
    throw new Error('Not connected to Hermes')
  }

  return hostHttp({ baseUrl: active.baseUrl, token: active.token, method, path, body, timeoutMs: 20_000 })
}

const detail = (res: { status: number; json: any; text?: string }) => String(res.json?.detail || res.text || `Hermes answered ${res.status}`)
const withProfile = (path: string, profile: string) => `${path}?profile=${encodeURIComponent(profile)}`

/** Writes `name=value` into the bot's profile `.env`. Errors never include the value. */
export async function saveSecret(profile: string, name: string, value: string) {
  if (!NAME_RE.test(name)) {
    throw new Error('That name is not a valid environment variable name.')
  }

  const clean = value.replace(/[\r\n]+/g, '').trim()

  if (!clean) {
    throw new Error('Enter a value first.')
  }

  if (clean.length > MAX_VALUE) {
    throw new Error('That value is too long.')
  }

  const res = await api('PUT', withProfile('api/env', profile), { key: name, value: clean, profile })

  if (res.status === 404 && !res.json?.detail) {
    throw new Error("This Hermes doesn't have the env API (PUT /api/env). Update Hermes to save secrets from the app.")
  }

  if (!res.ok) {
    throw new Error(`Couldn't save ${name}: ${detail(res).replaceAll(clean, '•••')}`)
  }

  // Running sessions read the env when tools start; ask the gateway to re-read it now.
  await gateway.request('reload.env', { profile }).catch(() => undefined)
}

/** Names of the env vars set in the bot's profile (never values). */
export async function listSecretNames(profile: string): Promise<SecretName[]> {
  const res = await api('GET', withProfile('api/env', profile))

  if (!res.ok) {
    throw new Error(res.status === 404 ? "This Hermes doesn't have the env API." : `Couldn't list secrets: ${detail(res)}`)
  }

  return Object.entries((res.json || {}) as Record<string, { is_set?: boolean; custom?: boolean; is_password?: boolean }>)
    .filter(([, row]) => row?.is_set)
    .map(([name, row]) => ({ name, custom: !!row.custom, ...(typeof row.is_password === 'boolean' ? { password: row.is_password } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function deleteSecret(profile: string, name: string) {
  if (secretKind({ name, custom: false }) === 'app') {
    throw new Error(`${name} is managed by NexurBots and can't be deleted here.`)
  }

  const res = await api('DELETE', withProfile('api/env', profile), { key: name, profile })

  if (!res.ok && res.status !== 404) {
    throw new Error(`Couldn't delete ${name}: ${detail(res)}`)
  }

  await gateway.request('reload.env', { profile }).catch(() => undefined)
}

// ── "that looks like a key" guard ───────────────────────────────────────────
const KEY_PATTERNS: { re: RegExp; name: string }[] = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, name: 'ANTHROPIC_API_KEY' },
  { re: /\bsk-or-[A-Za-z0-9_-]{20,}/, name: 'OPENROUTER_API_KEY' },
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, name: 'OPENAI_API_KEY' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/, name: 'GITHUB_TOKEN' },
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, name: 'AWS_ACCESS_KEY_ID' },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, name: 'SLACK_TOKEN' },
  { re: /\bAIza[A-Za-z0-9_-]{35}\b/, name: 'GOOGLE_API_KEY' },
  { re: /\bxai-[A-Za-z0-9]{20,}/, name: 'XAI_API_KEY' },
  { re: /\bhf_[A-Za-z0-9]{30,}/, name: 'HF_TOKEN' }
]

/** The first thing in `text` that looks like a common API key, with a suggested env name. */
export function findKey(text: string): null | { key: string; name: string } {
  for (const { re, name } of KEY_PATTERNS) {
    const match = text.match(re)

    if (match) {
      return { key: match[0], name }
    }
  }

  return null
}

// ── the bot's Details list (names only) ─────────────────────────────────────
export interface SecretList {
  loading: boolean
  names: SecretName[]
  error?: string
}

export const $secretNames = atom<Record<string, SecretList>>({})

export async function refreshSecretNames(profile: string) {
  const prev = $secretNames.get()[profile]
  $secretNames.set({ ...$secretNames.get(), [profile]: { loading: true, names: prev?.names || [] } })

  try {
    const names = await listSecretNames(profile)
    $secretNames.set({ ...$secretNames.get(), [profile]: { loading: false, names } })
  } catch (error) {
    $secretNames.set({ ...$secretNames.get(), [profile]: { loading: false, names: [], error: String((error as Error).message || error) } })
  }
}
