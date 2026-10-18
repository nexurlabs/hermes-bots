import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useState, type ReactNode } from 'react'

import { disconnect } from '../lib/connection'
import { cleanError, native } from '../lib/native'
import { $rooms, createRoom, deleteRoom, renameRoom, roomSettings, setRoomMembers, setRoomSettings } from '../lib/rooms'
import {
  $active,
  $allBots,
  $avatars,
  $bots,
  $busy,
  $selection,
  $userName,
  createBot,
  deleteBot,
  describeBot,
  setLead,
  slugify,
  toast,
  updateBot
} from '../lib/store'
import { $botConfig } from '../lib/botconfig'
import { $teamOnline, memberOf } from '../lib/team'
import type { Bot, RoomSettings } from '../lib/types'
import { Avatar } from './avatar'
import { BotSettings, type SettingsSection } from './bot-settings'
import { Seg } from './controls'
import { BLOB_KINDS, BotFace, blobShapeString, parseBlobShape } from './avatar-face'
import { Icon } from './icons'
import { SharedMemoryBody } from './memory'
import { SharedFolderBody } from './shared-folder'
import type { Routine } from '../lib/routines'
import { RoutineEditor } from './routines'

export type Dialog =
  | { kind: 'bot'; name?: string }
  | { kind: 'bot-settings'; name: string; section?: SettingsSection }
  | { kind: 'room'; key?: string }
  | { kind: 'routine'; name: string; back?: boolean; edit?: Routine }
  | { kind: 'delete-bot'; name: string }
  | { kind: 'delete-room'; key: string }
  | { kind: 'lead' }
  | { kind: 'settings' }
  | { kind: 'export-template'; name: string }
  | { kind: 'import-template'; template: BotTemplate; duplicateOf?: string }
  | { kind: 'team' }
  | { kind: 'memory' }
  | { kind: 'folder'; open?: string }

export const $dialog = atom<Dialog | null>(null)

const close = () => $dialog.set(null)

function Sheet({ title, sub, children, wide }: { title: string; sub?: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && close()
    window.addEventListener('keydown', esc)

    return () => window.removeEventListener('keydown', esc)
  }, [])

  return (
    <div className="sheet-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}>
      <div className="sheet" data-wide={wide || undefined} role="dialog">
        <div className="sheet-head">
          <div>
            <h2>{title}</h2>
            {sub ? <p>{sub}</p> : null}
          </div>
          <button aria-label="Close" className="icon-btn sm ghost" onClick={close} type="button">
            <Icon name="close" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Dialogs() {
  const dialog = useStore($dialog)

  if (!dialog) {
    return null
  }

  switch (dialog.kind) {
    case 'bot':
      return <BotEditor name={dialog.name} />
    case 'bot-settings':
      return (
        <BotSettings
          name={dialog.name}
          onClose={close}
          onNewRoutine={() => $dialog.set({ kind: 'routine', name: dialog.name, back: true })}
          onEditRoutine={routine => $dialog.set({ kind: 'routine', name: dialog.name, back: true, edit: routine })}
          onShared={() => $dialog.set({ kind: 'memory' })}
          section={dialog.section}
        />
      )
    case 'room':
      return <RoomEditor roomKey={dialog.key} />
    case 'routine': {
      // Opened from settings: go back there when done.
      const done = () => (dialog.back ? $dialog.set({ kind: 'bot-settings', name: dialog.name, section: 'routines' }) : close())

      return (
        <Sheet sub={dialog.edit ? 'Change what it does, its name or when it runs.' : 'A task a bot runs by itself, on a schedule or once.'} title={dialog.edit ? 'Edit routine' : 'New routine'}>
          <RoutineEditor key={dialog.edit?.id || 'new'} name={dialog.name} onClose={done} routine={dialog.edit} />
        </Sheet>
      )
    }
    case 'delete-bot':
      return <DeleteBot name={dialog.name} />
    case 'delete-room':
      return <DeleteRoom roomKey={dialog.key} />
    case 'lead':
      return <LeadPicker />
    case 'settings':
      return <Settings />
    case 'export-template':
      return (
        <Sheet sub="A file someone else can make the same bot from. Secrets stay here." title="Export as template" wide>
          <ExportTemplate name={dialog.name} />
        </Sheet>
      )
    case 'import-template':
      return (
        <Sheet sub={dialog.duplicateOf ? 'A new bot with the same setup. Chats and memory stay with the original.' : 'Check what comes with it, then pick a name.'} title={dialog.duplicateOf ? 'Duplicate bot' : 'New bot from template'} wide>
          <ImportTemplate duplicateOf={dialog.duplicateOf} template={dialog.template} />
        </Sheet>
      )
    case 'team':
      return <TeamView />
    case 'memory':
      return (
        <Sheet sub="Things about you that every bot knows: your name, time zone, preferences." title="Shared memory" wide>
          <SharedMemoryBody />
        </Sheet>
      )
    case 'folder':
      return (
        <Sheet sub="Files every bot can read and write, for handing work to each other." title="Shared folder" wide>
          <SharedFolderBody initial={dialog.open} />
        </Sheet>
      )
  }
}

function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')

    try {
      await fn()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  return { busy, error, run }
}

// ── bot editor ────────────────────────────────────────────────────────────
function BotEditor({ name }: { name?: string }) {
  const allBots = useStore($allBots)
  const avatars = useStore($avatars)
  const existing = name ? allBots.find(bot => bot.name === name) || null : null
  const [display, setDisplay] = useState(existing?.display || '')
  const [handle, setHandle] = useState('')
  const [description, setDescription] = useState(existing?.meta.description || existing?.row.description || '')
  const [soul, setSoul] = useState('')
  const [soulLoaded, setSoulLoaded] = useState(!existing)
  const [soulTouched, setSoulTouched] = useState(false)
  const [shape, setShape] = useState(existing ? String(existing.meta.shape || '') : 'blobatar')
  const [image, setImage] = useState<null | string | undefined>(existing ? avatars[existing.name] || null : null)
  const [imageTouched, setImageTouched] = useState(false)
  const [inherit, setInherit] = useState(true)
  const { busy, error, run } = useAction()

  useEffect(() => {
    if (!existing) {
      return
    }

    describeBot(existing.name)
      .then(info => {
        setSoul(info?.soul || '')
        setSoulLoaded(true)
      })
      .catch(() => setSoulLoaded(true))
  }, [existing?.name])

  const slug = existing ? existing.name : slugify(handle || display)
  const [host, setHost] = useState(() => $defaultHost.get())
  const previewBot: Bot = {
    name: slug || 'new-bot',
    row: { name: slug || 'new-bot' },
    meta: { shape, custom: true },
    display: display || 'New bot',
    handle: slug || 'new-bot',
    lead: false,
    lastActive: 0,
    preview: ''
  }

  const parsed = parseBlobShape(shape.startsWith('blobatar') ? shape : 'blobatar', slug || 'new-bot')

  const save = () =>
    run(async () => {
      if (existing) {
        await updateBot(existing.name, {
          display: display.trim(),
          description: description.trim(),
          soul,
          soulChanged: soulTouched,
          shape: shape || undefined,
          ...(imageTouched ? { image: image || null } : {})
        })
        toast('Saved')
      } else {
        const created = await createBot({
          name: slug,
          display: display.trim(),
          description: description.trim(),
          soul: soul.trim(),
          shape,
          image: image || null,
          inherit,
          host
        })
        $selection.set({ kind: 'bot', id: created })
        toast(`${display.trim() || created} is ready`, 'good')
      }

      close()
    })

  return (
    <Sheet sub={existing ? `@${existing.handle}` : 'Your own agent — with its own memory, tools and personality.'} title={existing ? 'Edit bot' : 'New bot'} wide>
      <div className="editor">
        <div className="editor-face">
          <div className="face-preview">
            {image ? (
              <img alt="" className="avatar-img" src={image} style={{ width: 96, height: 96 }} />
            ) : !shape && existing ? (
              <Avatar badge={false} bot={{ ...existing, meta: { ...existing.meta, image: null } }} size={96} />
            ) : (
              <BotFace color="#8b5cf6" image={null} mood="idle" name={previewBot.name} shape={shape} size={96} />
            )}
          </div>
          <div className="face-grid">
            {BLOB_KINDS.map(kind => {
              const value = blobShapeString(parsed.seedPart, kind)

              return (
                <button
                  className="face-opt"
                  data-on={(!image && shape === value) || undefined}
                  key={kind}
                  onClick={() => {
                    setShape(value)
                    setImage(null)
                    setImageTouched(true)
                  }}
                  title={kind}
                  type="button"
                >
                  <BotFace color="#8b5cf6" image={null} mood="idle" name={previewBot.name} shape={value} size={34} />
                </button>
              )
            })}
          </div>
          <div className="face-actions">
            <button
              className="btn sm"
              onClick={() => {
                setShape(blobShapeString(Math.random().toString(36).slice(2, 8), parsed.kind))
                setImage(null)
                setImageTouched(true)
              }}
              type="button"
            >
              🎲 Shuffle
            </button>
            <button
              className="btn sm"
              onClick={() =>
                void native.pickImage().then(picked => {
                  if (picked) {
                    setImage(picked)
                    setImageTouched(true)
                  }
                })
              }
              type="button"
            >
              <Icon name="image" size={14} /> Photo
            </button>
          </div>
        </div>
        <div className="editor-fields">
          <label className="field">
            <span>Name</span>
            <input autoFocus className="input" onChange={e => setDisplay(e.target.value)} placeholder="e.g. Nova" value={display} />
          </label>
          {!existing ? (
            <label className="field">
              <span>Handle</span>
              <div className="input-prefix">
                <i>@</i>
                <input className="input" onChange={e => setHandle(e.target.value)} placeholder={slugify(display) || 'nova'} value={handle} />
              </div>
              <small>How you @mention it in groups. Lowercase, no spaces.</small>
            </label>
          ) : null}
          <label className="field">
            <span>What it does</span>
            <input className="input" onChange={e => setDescription(e.target.value)} placeholder="e.g. Keeps my repos tidy and reviews PRs" value={description} />
          </label>
          <label className="field">
            <span>Personality & instructions</span>
            <textarea
              className="input area"
              disabled={!soulLoaded}
              onChange={e => {
                setSoul(e.target.value)
                setSoulTouched(true)
              }}
              placeholder={soulLoaded ? 'Who is this bot? How should it talk, what should it care about?' : 'Loading…'}
              rows={6}
              value={soul}
            />
          </label>
          {!existing ? <MachineField onChange={setHost} value={host} /> : null}
          {!existing ? (
            <button
              aria-checked={inherit}
              className="pick inherit"
              data-on={inherit || undefined}
              onClick={() => setInherit(v => !v)}
              role="checkbox"
              type="button"
            >
              <span>
                <b>Start from my main Hermes setup</b>
                <small>Copies its tools, connected apps, skills and model, and what it knows about you. Turn off for a blank slate.</small>
              </span>
              <i className="check">{inherit ? <Icon name="check" size={13} /> : null}</i>
            </button>
          ) : null}
        </div>
      </div>
      {error ? <div className="banner bad">{error}</div> : null}
      <div className="sheet-actions">
        {!existing ? (
          <button className="btn ghost tpl-from" onClick={pickTemplateFile} title={`Or drop a ${'.hermesbot.json'} file anywhere on the app`} type="button">
            <Icon name="upload" size={14} /> From template…
          </button>
        ) : null}
        <span className="grow" />
        <button className="btn ghost" onClick={close} type="button">
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !(display.trim() || slug)} onClick={() => void save()} type="button">
          {busy ? <span className="spinner xs" /> : null}
          {existing ? 'Save' : 'Create bot'}
        </button>
      </div>
    </Sheet>
  )
}

// ── group editor ──────────────────────────────────────────────────────────
const REPLY_HINT: Record<NonNullable<RoomSettings['reply']>, string> = {
  everyone: 'Every bot reads your message and decides for itself whether to answer. Bots with nothing to add stay silent.',
  lead: 'Only your Lead answers unless you @mention someone else.',
  mentions: 'Bots only answer when you @mention them (or @all).'
}

function RoomEditor({ roomKey }: { roomKey?: string }) {
  const bots = useStore($bots)
  const rooms = useStore($rooms)
  const room = roomKey ? rooms[roomKey] : null
  const [name, setName] = useState(room?.name || '')
  const [picked, setPicked] = useState<string[]>(room ? room.members.map(m => m.name) : [])
  const initial = room ? roomSettings(room) : { reply: 'everyone' as const, stop: 'turn' as const, maxTurns: 0, instructions: '' }
  const [reply, setReply] = useState<NonNullable<RoomSettings['reply']>>(initial.reply)
  const [stop, setStop] = useState<NonNullable<RoomSettings['stop']>>(initial.stop)
  const [turns, setTurns] = useState<string>(room?.settings?.maxTurns ? String(room.settings.maxTurns) : '')
  const [rules, setRules] = useState(initial.instructions)
  const [more, setMore] = useState(Boolean(room?.settings))

  const toggle = (bot: string) => setPicked(list => (list.includes(bot) ? list.filter(n => n !== bot) : list.length >= 6 ? list : [...list, bot]))

  const settings = (): RoomSettings => ({
    reply,
    stop,
    maxTurns: Number(turns) > 0 ? Number(turns) : undefined,
    instructions: rules
  })

  const save = () => {
    if (picked.length < 2) {
      return
    }

    if (room) {
      if (name.trim() && name.trim() !== room.name) {
        renameRoom(room.key, name.trim())
      }

      setRoomMembers(room.key, picked)
      setRoomSettings(room.key, settings())
    } else {
      const created = createRoom(
        name.trim() || picked.map(n => bots.find(b => b.name === n)?.display || n).join(', '),
        picked,
        settings()
      )
      $selection.set({ kind: 'room', id: created.key })
    }

    close()
  }

  return (
    <Sheet sub="Pick 2–6 bots. Everyone reads every message — your Lead answers first." title={room ? 'Edit group' : 'New group chat'}>
      <label className="field">
        <span>Group name</span>
        <input autoFocus className="input" onChange={e => setName(e.target.value)} placeholder="e.g. Launch crew" value={name} />
      </label>
      <div className="pick-list">
        {bots.map(bot => (
          <button className="pick" data-on={picked.includes(bot.name) || undefined} key={bot.name} onClick={() => toggle(bot.name)} type="button">
            <Avatar bot={bot} size={32} />
            <span>
              <b>{bot.display}</b>
              <small>{bot.lead ? 'Lead' : `@${bot.handle}`}</small>
            </span>
            <i className="check">{picked.includes(bot.name) ? <Icon name="check" size={13} /> : null}</i>
          </button>
        ))}
      </div>
      <button className="more-toggle" data-open={more || undefined} onClick={() => setMore(v => !v)} type="button">
        <Icon name="chevron-down" size={13} />
        More options
      </button>
      {more ? (
        <div className="more-body">
          <div className="field">
            <span>Who answers</span>
            <Seg
              onChange={setReply}
              options={[
                ['everyone', 'Everyone decides'],
                ['lead', 'Lead only'],
                ['mentions', '@mentions only']
              ]}
              value={reply}
            />
            <small>{REPLY_HINT[reply]}</small>
          </div>
          <div className="field">
            <span>Stop button</span>
            <Seg
              onChange={setStop}
              options={[
                ['turn', 'Just this message'],
                ['sticky', 'Until @mentioned']
              ]}
              value={stop}
            />
            <small>
              {stop === 'turn'
                ? 'Stops the bots that are working now. They can answer your next message as usual.'
                : 'Stops the bots that are working now and keeps them quiet until you @mention them again.'}
            </small>
          </div>
          <label className="field">
            <span>Max bot-to-bot turns per message</span>
            <input
              className="input narrow"
              inputMode="numeric"
              max={24}
              min={1}
              onChange={e => setTurns(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
              placeholder="auto"
              value={turns}
            />
            <small>A safety cap so bots can't keep handing off forever. Leave empty for automatic.</small>
          </label>
          <label className="field">
            <span>Group instructions</span>
            <textarea
              className="input area"
              maxLength={800}
              onChange={e => setRules(e.target.value)}
              placeholder="e.g. Keep replies under 5 lines. Disagree openly before agreeing."
              rows={3}
              value={rules}
            />
            <small>Added to every bot's prompt in this group only.</small>
          </label>
        </div>
      ) : null}
      <div className="sheet-actions">
        <button className="btn ghost" onClick={close} type="button">
          Cancel
        </button>
        <button className="btn primary" disabled={picked.length < 2} onClick={save} type="button">
          {room ? 'Save' : `Create group${picked.length ? ` (${picked.length})` : ''}`}
        </button>
      </div>
    </Sheet>
  )
}

// ── confirmations ─────────────────────────────────────────────────────────
function DeleteBot({ name }: { name: string }) {
  const bot = useStore($allBots).find(b => b.name === name)
  const { busy, error, run } = useAction()

  return (
    <Sheet sub="Its memory, skills, chats and scheduled jobs on this Hermes are removed. This can't be undone." title={`Delete ${bot?.display || name}?`}>
      {error ? <div className="banner bad">{error}</div> : null}
      <div className="sheet-actions">
        <button className="btn ghost" onClick={close} type="button">
          Cancel
        </button>
        <button
          className="btn danger-solid"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await deleteBot(name)
              toast(`${bot?.display || name} deleted`)
              close()
            })
          }
          type="button"
        >
          {busy ? <span className="spinner xs" /> : null}
          Delete bot
        </button>
      </div>
    </Sheet>
  )
}

function DeleteRoom({ roomKey }: { roomKey: string }) {
  const room = useStore($rooms)[roomKey]

  return (
    <Sheet sub="The bots stay — only this group and its chat go." title={`Delete ${room?.name || 'group'}?`}>
      <div className="sheet-actions">
        <button className="btn ghost" onClick={close} type="button">
          Cancel
        </button>
        <button
          className="btn danger-solid"
          onClick={() => {
            deleteRoom(roomKey)
            $selection.set(null)
            close()
          }}
          type="button"
        >
          Delete group
        </button>
      </div>
    </Sheet>
  )
}

function TeamView() {
  const bots = useStore($bots)
  const busy = useStore($busy)
  const online = useStore($teamOnline)
  useStore($botConfig)
  const rooms = Object.values(useStore($rooms))

  return (
    <Sheet sub="What every bot knows about the team. They get this with each turn." title="Team" wide>
      <div className="team-list">
        {bots.map(bot => {
          const m = memberOf(bot, rooms, busy, online)

          return (
            <button
              className="team-row"
              key={bot.name}
              onClick={() => {
                $selection.set({ kind: 'bot', id: bot.name })
                close()
              }}
              type="button"
            >
              <Avatar bot={bot} size={36} />
              <span className="team-main">
                <span className="team-name">
                  <b>{bot.display}</b>
                  {m.label ? <span className="team-label">{m.label}</span> : null}
                  {bot.lead ? <span className="chip-s">Lead</span> : null}
                </span>
                {m.role ? <small>{m.role}</small> : null}
                <span className="team-meta">
                  {[m.model, m.strengths.join(', '), m.groups.length ? `In ${m.groups.join(', ')}` : ''].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="team-status" data-status={m.status}>
                {m.status === 'busy' ? 'Busy' : m.status === 'idle' ? 'Idle' : 'Offline'}
              </span>
            </button>
          )
        })}
      </div>
    </Sheet>
  )
}

function LeadPicker() {
  const bots = useStore($bots)
  const { busy, error, run } = useAction()

  return (
    <Sheet sub="The Lead sits at the top, answers first in group chats and hands work to the right teammate." title="Pick a Lead">
      <div className="pick-list">
        {bots.map(bot => (
          <button
            className="pick"
            disabled={busy}
            key={bot.name}
            onClick={() =>
              void run(async () => {
                await setLead(bot.name)
                toast(`${bot.display} is now the Lead`, 'good')
                close()
              })
            }
            type="button"
          >
            <Avatar bot={bot} size={32} />
            <span>
              <b>{bot.display}</b>
              <small>@{bot.handle}</small>
            </span>
          </button>
        ))}
      </div>
      {error ? <div className="banner bad">{error}</div> : null}
    </Sheet>
  )
}

function Settings() {
  const active = useStore($active)
  const user = useStore($userName)
  const [name, setName] = useState(user)

  const saveName = () => {
    const value = name.trim() || 'You'
    $userName.set(value)
    void native.setSettings({ user: { name: value } })
  }

  return (
    <Sheet title="Settings">
      <label className="field">
        <span>Your name</span>
        <input className="input" onBlur={saveName} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveName()} value={name} />
        <small>What your bots call you in group chats.</small>
      </label>
      <VoiceSettings />
      <MachinesSettings />
      <div className="sheet-actions">
        <button
          className="btn"
          onClick={() => {
            close()
            void disconnect()
          }}
          type="button"
        >
          <Icon name="logout" size={15} /> Log out
        </button>
        <button className="btn primary" onClick={() => (saveName(), close())} type="button">
          Done
        </button>
      </div>
    </Sheet>
  )
}

import { VoiceSettings } from './voice'

import type { BotTemplate } from '../lib/templates'
import { ExportTemplate, ImportTemplate, pickTemplateFile } from './templates'

import { MachineField, MachinesSettings } from './machines'
import { $defaultHost } from '../lib/hosts'
