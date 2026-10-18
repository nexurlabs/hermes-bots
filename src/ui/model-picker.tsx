/**
 * The chat's model pill and picker: switch this chat's model from the next message on, pick a
 * thinking level when the model takes one, or make the pick the bot's default. Ctrl+Shift+M opens it.
 * In a group the pill lists the members, each with their own pick.
 */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useMemo, useRef, useState } from 'react'

import { $botConfig, isLoaded, loadBotConfig, loadProviders, REASONING_CHOICES, type ProviderOption } from '../lib/botconfig'
import { cleanError } from '../lib/native'
import { clearSessionModel, makeBotDefault, $sessionModels, switchSessionModel, type SessionModel } from '../lib/session-model'
import { toast } from '../lib/store'
import type { Bot } from '../lib/types'
import { Avatar } from './avatar'
import { Icon } from './icons'

/** Bumped by Ctrl+Shift+M; the visible chat's pill opens. */
export const $pickerHotkey = atom(0)

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'M' || event.key === 'm')) {
      event.preventDefault()
      $pickerHotkey.set($pickerHotkey.get() + 1)
    }
  })
}

const providerCache = new Map<string, Promise<ProviderOption[]>>()
const providersOf = (profile: string) => {
  if (!providerCache.has(profile)) {
    const p = loadProviders(profile)
    providerCache.set(profile, p)
    p.catch(() => providerCache.delete(profile))
  }

  return providerCache.get(profile)!
}

/** What this chat uses now: its own pick, else the bot's default. */
export function useCurrentModel(profile: string, sessionKey: string) {
  const pick = useStore($sessionModels)[sessionKey]
  const cfg = useStore($botConfig)[profile]

  useEffect(() => {
    void loadBotConfig(profile)
  }, [profile])

  const base: SessionModel | null = isLoaded(cfg) && cfg.model.model ? { provider: cfg.model.provider, model: cfg.model.model, reasoning: cfg.reasoning || undefined } : null

  return { pick, base, current: pick || base }
}

const shortName = (model: string) => model.split('/').pop() || model

function ModelMenu({ profile, sessionKey, scope, who, onDone }: { profile: string; sessionKey: string; scope: string; who?: string; onDone: () => void }) {
  const { pick, base, current } = useCurrentModel(profile, sessionKey)
  const [providers, setProviders] = useState<ProviderOption[] | null>(null)
  const [failed, setFailed] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState<null | { message: string; retry: () => Promise<unknown> }>(null)
  const search = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    providersOf(profile)
      .then(setProviders)
      .catch(error => setFailed(cleanError(error)))
    setTimeout(() => search.current?.focus(), 0)
  }, [profile])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return (providers || [])
      .map(p => ({ ...p, models: (needle ? p.models.filter(m => m.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)) : p.models).slice(0, needle ? 60 : 12) }))
      .filter(p => p.models.length)
      .sort((a, b) => Number(b.slug === current?.provider) - Number(a.slug === current?.provider) || Number(b.authenticated) - Number(a.authenticated))
  }, [providers, query, current?.provider])

  const reasons = current ? providers?.find(p => p.slug === current.provider)?.reasoning?.[current.model] !== false : false

  /** 'ok' closes the menu; 'confirm' keeps it open with Hermes's question. */
  const run = async (label: string, work: (confirmed: boolean) => Promise<{ confirm?: string; warning?: string } | void>, confirmed = false): Promise<'ok' | 'confirm' | 'error'> => {
    setBusy(label)
    try {
      const result = await work(confirmed)
      if (result && result.confirm) {
        setConfirm({ message: result.confirm, retry: () => run(label, work, true).then(r => r === 'ok' && onDone()) })
        return 'confirm'
      }
      if (result && result.warning) toast(result.warning)
      setConfirm(null)
      return 'ok'
    } catch (error) {
      toast(cleanError(error), 'bad')
      return 'error'
    } finally {
      setBusy('')
    }
  }

  const close = (r: string) => r === 'ok' && onDone()

  const choose = (provider: string, model: string) => {
    const next = { provider, model, ...(current?.reasoning ? { reasoning: current.reasoning } : {}) }

    void run(model, confirmed => switchSessionModel({ key: sessionKey, scope, profile, who, pick: next, confirmed })).then(close)
  }

  return (
    <div className="model-menu" onKeyDown={event => event.key === 'Escape' && onDone()} role="dialog">
      <div className="model-search">
        <Icon name="search" size={14} />
        <input onChange={e => setQuery(e.target.value)} placeholder="Search models" ref={search} value={query} />
      </div>
      <div className="model-list">
        {failed ? <div className="panel-empty">Couldn't load models: {failed}</div> : null}
        {!providers && !failed ? (
          <div className="thread-loading">
            <span className="spinner" />
          </div>
        ) : null}
        {groups.map(p => (
          <div className="model-group" key={p.slug}>
            <div className="model-provider">
              {p.name}
              {!p.authenticated ? <small> · not connected</small> : null}
            </div>
            {p.models.map(m => {
              const on = current?.provider === p.slug && current?.model === m

              return (
                <button className="model-row" data-on={on || undefined} disabled={!p.authenticated || !!busy} key={m} onClick={() => !on && choose(p.slug, m)} title={m} type="button">
                  <span>{shortName(m)}</span>
                  {base?.provider === p.slug && base?.model === m ? <small>bot default</small> : null}
                  {busy === m ? <span className="spinner xs" /> : on ? <Icon name="check" size={13} /> : null}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      {confirm ? (
        <div className="model-confirm">
          <span>{confirm.message}</span>
          <button className="btn sm ghost" onClick={() => setConfirm(null)} type="button">
            Cancel
          </button>
          <button className="btn sm primary" onClick={() => void confirm.retry()} type="button">
            Use it
          </button>
        </div>
      ) : null}
      {current && reasons ? (
        <div className="model-think">
          <span>Thinking</span>
          <div className="seg xs">
            {REASONING_CHOICES.map(choice => (
              <button
                data-on={(current.reasoning || '') === choice.id || undefined}
                disabled={!!busy}
                key={choice.id}
                onClick={() => void run('think', () => switchSessionModel({ key: sessionKey, scope, profile, who, pick: { ...current, reasoning: choice.id }, confirmed: true }))}
                type="button"
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="model-foot">
        <small>{pick ? 'This chat only, from your next message.' : 'Picking one changes this chat only.'}</small>
        <span className="grow" />
        {pick && base ? (
          <button className="btn sm ghost" disabled={!!busy} onClick={() => void run('reset', () => clearSessionModel({ key: sessionKey, scope, profile, who, fallback: base })).then(close)} type="button">
            Use bot default
          </button>
        ) : null}
        {pick ? (
          <button
            className="btn sm"
            disabled={!!busy}
            onClick={() =>
              void run('default', confirmed => makeBotDefault({ key: sessionKey, scope, profile, who, pick, confirmed })).then(close)
            }
            title="Every chat with this bot uses it (writes the bot's settings, like Details > Model)"
            type="button"
          >
            {busy === 'default' ? <span className="spinner xs" /> : null} Set as bot default
          </button>
        ) : null}
      </div>
    </div>
  )
}

function usePopover() {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => box.current && !box.current.contains(event.target as Node) && setOpen(false)
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)

    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  const hotkey = useStore($pickerHotkey)
  const first = useRef(hotkey)

  useEffect(() => {
    if (hotkey !== first.current) setOpen(v => !v)
  }, [hotkey])

  return { open, setOpen, box }
}

/** 1:1 chats: the pill in the header. */
export function ModelPill({ bot, startOpen }: { bot: Bot; startOpen?: boolean }) {
  const key = `bot:${bot.name}`
  const { current, pick } = useCurrentModel(bot.name, key)
  const { open, setOpen, box } = usePopover()

  useEffect(() => {
    if (startOpen) setOpen(true)
  }, [startOpen])

  return (
    <div className="model-pop" ref={box}>
      <button aria-expanded={open} className="model-pill" data-pinned={pick ? '' : undefined} onClick={() => setOpen(!open)} title={`Model for this chat (Ctrl+Shift+M)${current ? `: ${current.model}` : ''}`} type="button">
        <Icon name="sparkle" size={13} />
        <span>{current ? shortName(current.model) : 'Model'}</span>
        {current?.reasoning && current.reasoning !== 'none' ? <small>{current.reasoning}</small> : null}
        <Icon name="chevron-down" size={12} />
      </button>
      {open ? <ModelMenu onDone={() => setOpen(false)} profile={bot.name} scope={key} sessionKey={key} /> : null}
    </div>
  )
}

function MemberModel({ bot, roomId }: { bot: Bot; roomId: string }) {
  const { current, pick } = useCurrentModel(bot.name, `room:${roomId}:${bot.name}`)

  return (
    <>
      <Avatar badge={false} bot={bot} size={22} />
      <b>{bot.display}</b>
      <span className="grow" />
      <span className="member-model" data-pinned={pick ? '' : undefined}>
        {current ? shortName(current.model) : '…'}
      </span>
      <Icon name="chevron-right" size={13} />
    </>
  )
}

/** Group chats: a pill listing each member's model; pick per bot. */
export function RoomModels({ members, roomId, startOpen }: { members: Bot[]; roomId: string; startOpen?: string }) {
  const { open, setOpen, box } = usePopover()
  const [member, setMember] = useState<string>('')
  const picks = useStore($sessionModels)
  const pinned = members.filter(m => picks[`room:${roomId}:${m.name}`]).length

  useEffect(() => {
    if (startOpen !== undefined) {
      setOpen(true)
      setMember(startOpen)
    }
  }, [startOpen])

  useEffect(() => {
    if (!open) setMember('')
  }, [open])

  const chosen = members.find(m => m.name === member)

  return (
    <div className="model-pop" ref={box}>
      <button aria-expanded={open} className="model-pill" data-pinned={pinned ? '' : undefined} onClick={() => setOpen(!open)} title="Each bot's model in this group (Ctrl+Shift+M)" type="button">
        <Icon name="sparkle" size={13} />
        <span>Models</span>
        {pinned ? <small>{pinned} changed</small> : null}
        <Icon name="chevron-down" size={12} />
      </button>
      {open ? (
        chosen ? (
          <div className="model-room">
            <button className="model-back" onClick={() => setMember('')} type="button">
              <Icon name="back" size={13} /> <Avatar badge={false} bot={chosen} size={18} /> {chosen.display} <small>in this group</small>
            </button>
            <ModelMenu onDone={() => setOpen(false)} profile={chosen.name} scope={`room:${roomId}`} sessionKey={`room:${roomId}:${chosen.name}`} who={chosen.display} />
          </div>
        ) : (
          <div className="model-menu model-members">
            {members.map(m => (
              <button className="member-row" key={m.name} onClick={() => setMember(m.name)} type="button">
                <MemberModel bot={m} roomId={roomId} />
              </button>
            ))}
            <div className="model-foot">
              <small>Each bot keeps its own model; a pick here is for this group only.</small>
            </div>
          </div>
        )
      ) : null}
    </div>
  )
}
