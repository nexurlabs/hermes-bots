/**
 * Switching models mid-chat. The pick applies to ONE chat session from the next message on:
 * Hermes's own per-session `/model` override, `config.set {key: 'model', value: '<model>
 * --provider <slug> --session', session_id}` (the same call the Hermes desktop composer's model
 * menu makes). Hermes pins it on that session (`model_override`) and never touches the profile or
 * other chats. Thinking goes the same way: `config.set {key: 'reasoning', scope: 'session'}`.
 *
 * Group chats have one Hermes session per member, so the pick is per bot in that group.
 * The app keeps the pick here and pins it again on every resume (`reapplySessionModel`). Hermes
 * also keeps a session's pin across resumes, so a chat with no pick is put back on the bot's
 * default when Hermes reports an old pin (a pick cleared while the session wasn't running).
 * "Set as bot default" writes the profile like Details > Model does and clears the per-chat pick.
 */
import { atom } from 'nanostores'

import { $botConfig, isLoaded, loadBotConfig, setModel, setReasoning } from './botconfig'
import { gateway } from './gateway'

export interface SessionModel {
  provider: string
  model: string
  reasoning?: string
}

export interface SwitchNote {
  id: string
  at: number
  text: string
}

const PICKS_KEY = 'session-models'
const NOTES_KEY = 'model-switch-notes'
const MAX_NOTES = 40

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null')

    return raw && typeof raw === 'object' ? raw : fallback
  } catch {
    return fallback
  }
}

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* still works until restart */
  }
}

/** Session key (`bot:<name>` or `room:<roomId>:<member>`) → the model picked for it. */
export const $sessionModels = atom<Record<string, SessionModel>>(typeof localStorage === 'undefined' ? {} : read(PICKS_KEY, {}))
/** Chat scope (`bot:<name>` or `room:<roomId>`) → "Switched to …" lines. */
export const $switchNotes = atom<Record<string, SwitchNote[]>>(typeof localStorage === 'undefined' ? {} : read(NOTES_KEY, {}))
/** Ctrl+Shift+M: which chat's picker to open. */
export const $pickerOpen = atom<string>('')

let preview = false
export const setSessionModelPreview = (on: boolean) => {
  preview = on
}

let live: (key: string) => string | undefined = () => undefined
/** chat.ts hands over its runtime lookup (avoids an import cycle). */
export const useRuntimeLookup = (fn: (key: string) => string | undefined) => {
  live = fn
}

function putPick(key: string, pick: SessionModel | null) {
  const next = { ...$sessionModels.get() }

  if (pick) next[key] = pick
  else delete next[key]
  $sessionModels.set(next)
  if (!preview) write(PICKS_KEY, next)
}

export function addSwitchNote(scope: string, text: string) {
  const note = { id: `ms${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), text }
  const all = { ...$switchNotes.get(), [scope]: [...($switchNotes.get()[scope] || []), note].slice(-MAX_NOTES) }
  $switchNotes.set(all)
  if (!preview) write(NOTES_KEY, all)
}

export const seedSwitchNotes = (notes: Record<string, SwitchNote[]>, picks: Record<string, SessionModel>) => {
  $switchNotes.set(notes)
  $sessionModels.set(picks)
}

async function pin(runtime: string, profile: string, pick: SessionModel, confirmed: boolean): Promise<{ confirm?: string; warning?: string }> {
  const res = await gateway.request<any>(
    'config.set',
    { key: 'model', value: `${pick.model} --provider ${pick.provider} --session`, session_id: runtime, profile, ...(confirmed ? { confirm_expensive_model: true } : {}) },
    60_000
  )

  if (res?.confirm_required) return { confirm: String(res.confirm_message || 'Hermes asks you to confirm this model.') }

  if (pick.reasoning) {
    await gateway.request('config.set', { key: 'reasoning', value: pick.reasoning, scope: 'session', session_id: runtime, profile }).catch(() => undefined)
  }

  return { warning: res?.warning ? String(res.warning) : undefined }
}

/**
 * Picks a model for one chat session. With no live session yet, the pick waits and is pinned
 * when the chat's session starts. `confirm` comes back when Hermes wants a yes for a pricey model.
 */
export async function switchSessionModel(opts: { key: string; scope: string; profile: string; who?: string; pick: SessionModel; confirmed?: boolean }) {
  const runtime = live(opts.key)
  let warning: string | undefined

  if (runtime && !preview) {
    const result = await pin(runtime, opts.profile, opts.pick, Boolean(opts.confirmed))
    if (result.confirm) return { confirm: result.confirm }
    warning = result.warning
  }

  const before = $sessionModels.get()[opts.key]
  putPick(opts.key, opts.pick)

  if (before?.model !== opts.pick.model || before?.provider !== opts.pick.provider) {
    addSwitchNote(opts.scope, `${opts.who ? `${opts.who} switched` : 'Switched'} to ${opts.pick.model}`)
  } else if (before?.reasoning !== opts.pick.reasoning && opts.pick.reasoning) {
    addSwitchNote(opts.scope, `${opts.who ? `${opts.who}: ` : ''}${opts.pick.reasoning} thinking`)
  }

  return { warning }
}

/** Back to the bot's default model in this chat. */
export async function clearSessionModel(opts: { key: string; scope: string; profile: string; who?: string; fallback: SessionModel }) {
  const runtime = live(opts.key)

  if (runtime && !preview) await pin(runtime, opts.profile, opts.fallback, true)
  if ($sessionModels.get()[opts.key]) {
    putPick(opts.key, null)
    addSwitchNote(opts.scope, `${opts.who ? `${opts.who} is back on` : 'Back to'} the bot default (${opts.fallback.model})`)
  }
}

/** Writes the pick to the bot's profile (every chat of that bot) and drops the per-chat pick. */
export async function makeBotDefault(opts: { key: string; scope: string; profile: string; who?: string; pick: SessionModel; confirmed?: boolean }) {
  const result = await setModel(opts.profile, opts.pick.provider, opts.pick.model, Boolean(opts.confirmed))

  if (result.confirm) return result
  if (opts.pick.reasoning) await setReasoning(opts.profile, opts.pick.reasoning).catch(() => undefined)
  putPick(opts.key, null)
  addSwitchNote(opts.scope, `${opts.who || 'Bot'} default is now ${opts.pick.model}`)

  return {}
}

const shortModel = (model: string) => model.split('/').pop() || model

/** The bot's default model, once its config has loaded. */
async function botDefault(profile: string): Promise<SessionModel | null> {
  await loadBotConfig(profile)

  if ($botConfig.get()[profile] === 'loading') {
    await new Promise<void>(resolve => {
      const off = $botConfig.listen(all => {
        if (all[profile] !== 'loading') {
          off()
          resolve()
        }
      })
    })
  }

  const cfg = $botConfig.get()[profile]

  return isLoaded(cfg) && cfg.model.model ? { provider: cfg.model.provider, model: cfg.model.model } : null
}

/**
 * Called after a session (re)starts: pins the chat's pick again, or, with no pick, puts the
 * session back on the bot's default if Hermes reports another model for it. `running` is the
 * model Hermes says the session runs. Never throws.
 */
export async function reapplySessionModel(key: string, runtime: string, profile: string, running?: { model?: string }) {
  const pick = $sessionModels.get()[key]

  if (preview) return
  try {
    if (pick) {
      await pin(runtime, profile, pick, true)

      return
    }

    if (!running?.model) return
    const fallback = await botDefault(profile)

    if (fallback && shortModel(running.model) !== shortModel(fallback.model)) {
      await pin(runtime, profile, fallback, true)
    }
  } catch {
    /* the model may be gone; the chat falls back to the profile's */
  }
}
