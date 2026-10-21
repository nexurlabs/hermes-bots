import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { $botConfig, isLoaded, loadBotConfig, approvalLabel, type BotConfig } from '../lib/botconfig'
import { $chats } from '../lib/chat'
import { $routines, isPaused, isRoutineList, loadRoutines, type Routine } from '../lib/routines'
import { $handoff } from '../lib/handoff'
import { $secretNames, deleteSecret, refreshSecretNames } from '../lib/secrets'
import { $screenChip } from '../lib/screen-chip'
import { $rooms, roomBots, roomSettings, setQuiet, setRoomMembers } from '../lib/rooms'
import { $bots, $panelOpen, $selection, saveMeta, setLead, toast } from '../lib/store'
import type { Bot, ChatMsg, Room } from '../lib/types'
import { native } from '../lib/native'
import { Avatar, AvatarStack } from './avatar'
import { $computerDemo } from '../lib/computer-demo'
import { ComputerTab } from './computer'
import { openContextMenu } from './context-menu'
import { $dialog } from './dialogs'
import type { SettingsSection } from './bot-settings'
import { Icon, type IconName } from './icons'
import { Library } from './library'
import { Menu, type MenuItem } from './menu'

export function Panel() {
  const selection = useStore($selection)
  const bots = useStore($bots)
  const rooms = useStore($rooms)
  const open = useStore($panelOpen)

  if (!open || !selection) {
    return null
  }

  if (selection.kind === 'room') {
    const room = rooms[selection.id]

    return room ? <RoomPanel room={room} /> : null
  }

  const bot = bots.find(b => b.name === selection.id)

  return bot ? <BotPanel bot={bot} /> : null
}

interface Line {
  who: string
  at: number
  text: string
  mine: boolean
}

function shareItems(lines: Line[]): (MenuItem | 'sep')[] {
  const said = lines.filter(line => line.text.trim())
  const last = [...said].reverse().find(line => !line.mine)

  const copy = (text: string, done: string) =>
    void native.copyText(text).then(ok => toast(ok ? done : 'Could not copy', ok ? 'good' : 'bad'))

  const stamp = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  return [
    {
      icon: 'copy',
      label: 'Copy conversation',
      disabled: !said.length,
      onSelect: () =>
        copy(said.map(line => `**${line.who}** · ${stamp(line.at)}\n\n${line.text.trim()}`).join('\n\n---\n\n'), 'Conversation copied')
    },
    { icon: 'copy', label: 'Copy last reply', disabled: !last, onSelect: () => last && copy(last.text.trim(), 'Reply copied') }
  ]
}

function PanelShell({ children, share }: { children: React.ReactNode; share?: (MenuItem | 'sep')[] }) {
  return (
    <aside className="panel">
      <div className="panel-top-bar">
        <div className="drag-fill" />
        {share ? (
          <Menu
            align="start"
            items={share}
            trigger={
              <button aria-label="Share" className="icon-btn" type="button">
                <Icon name="share" />
              </button>
            }
          />
        ) : null}
        <button aria-label="Hide details" className="icon-btn" onClick={() => $panelOpen.set(false)} type="button">
          <Icon name="panel" />
        </button>
        <i className="top-divider" />
      </div>
      <div className="panel-scroll">{children}</div>
    </aside>
  )
}

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map(([id, label]) => (
        <button data-on={id === value || undefined} key={id} onClick={() => onChange(id)} type="button">
          {label}
        </button>
      ))}
    </div>
  )
}

// ── bot ───────────────────────────────────────────────────────────────────

interface SetupRow {
  icon: IconName
  label: string
  value: string
  /** The full value on hover, when the row shows a shorter one. */
  full?: string
  section: SettingsSection
}

/** "openrouter/minimax/MiniMax-M3.1-Flash" → "MiniMax-M3.1-Flash": the provider shows in settings. */
const shortModel = (model: string) => model.split('/').pop() || model

/** One plain value per row; the details live one click away in settings. */
function setupRows(bot: Bot, cfg: BotConfig, routines?: Routine[]): SetupRow[] {
  const live = (routines || []).filter(r => !isPaused(r) && r.state !== 'completed').length
  const model = cfg.model.model || bot.row.model || ''

  return [
    { icon: 'sparkle', label: 'Model', value: model ? shortModel(model) : 'Default', full: [model, cfg.model.provider && `via ${cfg.model.provider}`].filter(Boolean).join(' '), section: 'model' },
    { icon: 'shield', label: 'Approvals', value: approvalLabel(cfg.approvals), full: cfg.cwd ? `Works in ${cfg.cwd}` : undefined, section: 'safety' },
    {
      icon: 'clock',
      label: 'Routines',
      value: routines ? (routines.length ? String(routines.length) : 'None') : 'View',
      full: routines?.length ? `${live} active, ${routines.length - live} paused or done` : undefined,
      section: 'routines'
    }
  ]
}

/** The editable line under a bot's name. Empty by default; click to add or change it. */
function BotLabel({ bot }: { bot: Bot }) {
  const saved = String(bot.meta.label || '')
  const [draft, setDraft] = useState<null | string>(null)

  const commit = () => {
    const next = (draft ?? '').trim().slice(0, 40)
    setDraft(null)

    if (next !== saved) {
      void saveMeta(bot.name, { label: next }).catch(error => toast(`Couldn't save the label: ${(error as Error).message}`, 'bad'))
    }
  }

  if (draft !== null) {
    return (
      <input
        aria-label="Label"
        autoFocus
        className="head-label-input"
        maxLength={40}
        onBlur={commit}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') setDraft(null)
        }}
        placeholder="Add a label"
        value={draft}
      />
    )
  }

  return (
    <button className="head-label" data-empty={!saved || undefined} onClick={() => setDraft(saved)} type="button">
      {saved || 'Add a label'}
    </button>
  )
}

function Setup({ bot }: { bot: Bot }) {
  const state = useStore($botConfig)[bot.name]
  const routines = useStore($routines)[bot.name]

  useEffect(() => {
    void loadRoutines(bot.name)
  }, [bot.name])
  const open = (section: SettingsSection) => $dialog.set({ kind: 'bot-settings', name: bot.name, section })

  return (
    <section className="group">
      <header>
        <b>Setup</b>
        <button className="link-btn" onClick={() => open('model')} type="button">
          All settings
        </button>
      </header>
      <div className="group-card">
        {isLoaded(state) ? (
          setupRows(bot, state, isRoutineList(routines) ? routines : undefined).map(row => (
            <button className="setup-row" key={row.section} onClick={() => open(row.section)} type="button">
              <span className="tile">
                <Icon name={row.icon} size={16} />
              </span>
              <b className="txt">{row.label}</b>
              <span className="end" title={row.full || row.value}>
                {row.value}
              </span>
              <Icon className="chev" name="chevron-right" size={15} />
            </button>
          ))
        ) : state && typeof state === 'object' && 'error' in state ? (
          <div className="retry-row">
            <span>Couldn't read this bot's setup. {state.error}</span>
            <button className="btn sm" onClick={() => void loadBotConfig(bot.name, true)} type="button">
              Retry
            </button>
          </div>
        ) : (
          [0, 1, 2].map(index => (
            <div className="setup-row" key={index}>
              <span className="tile" />
              <span className="txt">
                <i className="skel a" />
                <i className="skel" />
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function BotPanel({ bot }: { bot: Bot }) {
  const [tab, setTab] = useState<'computer' | 'details' | 'library'>(() => ($computerDemo.get() ? 'computer' : 'details'))
  const handoff = useStore($handoff)

  // A sign-in handoff card for this bot: show its Computer tab, which opens the screen.
  useEffect(() => {
    if (handoff?.pending && handoff.bot === bot.name) {
      setTab('computer')
    }
  }, [handoff, bot.name])

  // A "see its screen" chip on one of this bot's messages: same tab, same reason.
  const chip = useStore($screenChip)
  useEffect(() => {
    if (chip && chip.bot === bot.name) {
      setTab('computer')
      $screenChip.set(null)
    }
  }, [chip, bot.name])
  const chats = useStore($chats)
  const bots = useStore($bots)
  const state = useStore($botConfig)[bot.name]
  const team = bot.lead ? bots.filter(b => b.name !== bot.name) : []
  const about = bot.meta.description || bot.row.description

  useEffect(() => {
    void loadBotConfig(bot.name)
  }, [bot.name])

  const lines: Line[] = (chats[bot.name]?.messages || [])
    .filter(msg => msg.role === 'user' || msg.role === 'assistant')
    .map(msg => ({ who: msg.role === 'user' ? 'You' : bot.display, at: msg.at, text: msg.text, mine: msg.role === 'user' }))

  return (
    <PanelShell share={shareItems(lines)}>
      <div className="panel-head">
        <Avatar bot={bot} size={58} />
        <h3>{bot.display}</h3>
        <BotLabel bot={bot} />
        {bot.lead ? (
          <div className="head-chips">
            <span className="chip-s gold">
              <Icon name="star" size={12} />
              <span>Lead</span>
            </span>
          </div>
        ) : null}
      </div>
      <Tabs onChange={setTab} tabs={[['details', 'Details'], ['library', 'Library'], ['computer', 'Computer']]} value={tab} />
      <div className="panel-body" key={tab}>
        {tab === 'details' ? (
          <>
            {about ? <p className="about">{about}</p> : null}
            <Setup bot={bot} />
            <SecretsSection bot={bot} />
            {team.length ? (
              <section className="group">
                <header>
                  <b>Team</b>
                  <span className="count">{team.length}</span>
                </header>
                <div className="group-card">
                  {team.map(member => (
                    <button className="setup-row" key={member.name} onClick={() => $selection.set({ kind: 'bot', id: member.name })} type="button">
                      <Avatar badge={false} bot={member} size={30} />
                      <span className="txt">
                        <b>{member.display}</b>
                        {member.meta.label ? <small>{String(member.meta.label)}</small> : null}
                      </span>
                      <Icon className="chev" name="chevron-right" size={15} />
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            <div className="panel-actions">
              <button className="btn block" onClick={() => $dialog.set({ kind: 'bot', name: bot.name })} type="button">
                <Icon name="edit" size={15} /> Edit name, face and role
              </button>
              <div className="panel-actions-row">
                <button className="btn block" onClick={() => $dialog.set({ kind: 'export-template', name: bot.name })} type="button">
                  <Icon name="download" size={15} /> Export as template
                </button>
                <button className="btn block" onClick={() => void duplicateBot(bot.name)} type="button">
                  <Icon name="copy" size={15} /> Duplicate
                </button>
              </div>
              {bot.name !== 'default' ? (
                <button className="btn block danger" onClick={() => $dialog.set({ kind: 'delete-bot', name: bot.name })} type="button">
                  <Icon name="trash" size={15} /> Delete bot
                </button>
              ) : null}
            </div>
          </>
        ) : tab === 'computer' ? (
          <ComputerTab bot={bot} key={bot.name} />
        ) : (
          <Library messages={chats[bot.name]?.messages || []} scope={`bot:${bot.name}`} />
        )}
      </div>
    </PanelShell>
  )
}

// ── secrets (names only) ──────────────────────────────────────────────────
function SecretsSection({ bot }: { bot: Bot }) {
  const list = useStore($secretNames)[bot.name]
  const [confirm, setConfirm] = useState('')

  useEffect(() => {
    if (!$secretNames.get()[bot.name]) {
      void refreshSecretNames(bot.name)
    }
  }, [bot.name])

  const names = list?.names || []

  return (
    <section className="group secrets">
      <header>
        <b>Secrets</b>
        {names.length ? <span className="count">{names.length}</span> : null}
      </header>
      <div className="group-card">
        {list?.error ? (
          <div className="setup-row">
            <span className="txt">
              <small>{list.error}</small>
            </span>
          </div>
        ) : !names.length ? (
          <div className="setup-row">
            <span className="txt">
              <small>{list?.loading ? 'Loading…' : `None yet. When ${bot.display} needs a key it asks with a secure card in your chat.`}</small>
            </span>
          </div>
        ) : (
          names.map(item => (
            <div className="setup-row" key={item.name}>
              <span className="tile">
                <Icon name="key" size={15} />
              </span>
              <span className="txt">
                <b className="mono">{item.name}</b>
                <small>{item.custom ? 'Set · value hidden' : 'Hermes key · value hidden'}</small>
              </span>
              {confirm === item.name ? (
                <span className="end secret-del">
                  <button className="btn sm ghost" onClick={() => setConfirm('')} type="button">
                    Keep
                  </button>
                  <button
                    className="btn sm danger"
                    onClick={() =>
                      void deleteSecret(bot.name, item.name)
                        .then(() => toast(`Deleted ${item.name}`))
                        .catch(error => toast(String(error.message || error), 'bad'))
                        .finally(() => {
                          setConfirm('')
                          void refreshSecretNames(bot.name)
                        })
                    }
                    type="button"
                  >
                    Delete
                  </button>
                </span>
              ) : (
                <button aria-label={`Delete ${item.name}`} className="icon-btn xs ghost" onClick={() => setConfirm(item.name)} title="Delete" type="button">
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  )
}

// ── room ──────────────────────────────────────────────────────────────────
function memberMenuItems(bot: Bot, room: Room, members: Bot[]): (MenuItem | 'sep')[] {
  const items: (MenuItem | 'sep')[] = [
    { icon: 'bot', label: 'Open profile', onSelect: () => $selection.set({ kind: 'bot', id: bot.name }) },
    {
      icon: 'star',
      label: bot.lead ? 'Remove as Lead' : 'Set as Lead',
      onSelect: () =>
        void setLead(bot.lead ? null : bot.name)
          .then(() => toast(bot.lead ? `${bot.display} is no longer the Lead` : `${bot.display} is now the Lead`))
          .catch(error => toast(String(error.message || error), 'bad'))
    }
  ]

  const quiet = (room.quiet || []).includes(bot.name)

  items.push({
    icon: 'bell-off',
    label: quiet ? 'Let speak freely' : 'Quiet unless @mentioned',
    onSelect: () => setQuiet(room.key, bot.name, !quiet)
  })

  if (members.length > 2) {
    items.push('sep', {
      icon: 'close',
      label: 'Remove from group',
      danger: true,
      onSelect: () => setRoomMembers(room.key, members.filter(m => m.name !== bot.name).map(m => m.name))
    })
  }

  return items
}

function howItWorks(room: Room, members: Bot[]) {
  const cfg = roomSettings(room)
  const lead = members.find(m => m.lead)
  const quiet = members.filter(m => (room.quiet || []).includes(m.name))

  const who =
    cfg.reply === 'mentions'
      ? 'Bots only answer when you @mention them (or @all).'
      : cfg.reply === 'lead' && lead
        ? `${lead.display} answers every message; @mention someone to ask them directly.`
        : lead
          ? `Every bot reads each message and decides whether to answer, ${lead.display} first. @mention to ask someone directly.`
          : 'Every bot reads each message and decides whether to answer. @mention to ask someone directly.'

  const tail = [
    `Bots can hand off to each other (up to ${cfg.maxTurns} turns per message).`,
    cfg.stop === 'sticky' ? 'Stop silences them until you @mention them again.' : 'Stop only interrupts the current message.',
    quiet.length ? `${quiet.map(m => m.display).join(', ')} only ${quiet.length > 1 ? 'speak' : 'speaks'} when @mentioned.` : ''
  ]

  return [who, ...tail].filter(Boolean).join(' ')
}

function RoomPanel({ room }: { room: Room }) {
  const [tab, setTab] = useState<'details' | 'library' | 'members'>('members')
  const members = roomBots(room)
  const messages: ChatMsg[] = room.log.map(entry => ({ id: entry.id, role: 'assistant', text: entry.text, at: entry.at, attachments: entry.attachments }))

  const lines: Line[] = room.log.map(entry => ({
    who: entry.from.kind === 'user' ? 'You' : members.find(bot => bot.name === entry.from.name)?.display || entry.from.name,
    at: entry.at,
    text: entry.text,
    mine: entry.from.kind === 'user'
  }))

  return (
    <PanelShell share={shareItems(lines)}>
      <div className="panel-head">
        <AvatarStack bots={members} size={58} />
        <h3>{room.name}</h3>
        <p>{members.length} bots</p>
      </div>
      <Tabs
        onChange={setTab}
        tabs={[
          ['details', 'Details'],
          ['library', 'Library'],
          ['members', 'Members']
        ]}
        value={tab}
      />
      <div className="panel-body" key={tab}>
        {tab === 'members' ? (
          <div className="members">
            {members.map(bot => (
              <div className="member-row" key={bot.name} onContextMenu={event => openContextMenu(event, memberMenuItems(bot, room, members))}>
                <button className="member" onClick={() => $selection.set({ kind: 'bot', id: bot.name })} type="button">
                  <Avatar bot={bot} size={30} />
                  <span>
                    <b>{bot.display}</b>
                  </span>
                </button>
                {bot.lead ? <span className="pill">Lead</span> : null}
                {(room.quiet || []).includes(bot.name) ? (
                  <span className="pill quiet" title="Only speaks when @mentioned">
                    Quiet
                  </span>
                ) : null}
                {members.length > 2 ? (
                  <button
                    aria-label={`Remove ${bot.display}`}
                    className="icon-btn xs ghost member-x"
                    onClick={() => setRoomMembers(room.key, members.filter(m => m.name !== bot.name).map(m => m.name))}
                    type="button"
                  >
                    <Icon name="close" size={13} />
                  </button>
                ) : null}
              </div>
            ))}
            <button className="add-member" onClick={() => $dialog.set({ kind: 'room', key: room.key })} type="button">
              <Icon name="plus" size={17} />
              <span>Add Member</span>
            </button>
          </div>
        ) : tab === 'library' ? (
          <Library messages={messages} scope={`room:${room.roomId}`} />
        ) : (
          <>
            <div className="detail">
              <dt>Group</dt>
              <dd>{room.name}</dd>
            </div>
            <div className="detail">
              <dt>How it works</dt>
              <dd>{howItWorks(room, members)}</dd>
            </div>
            {roomSettings(room).instructions ? (
              <div className="detail">
                <dt>Group instructions</dt>
                <dd>{roomSettings(room).instructions}</dd>
              </div>
            ) : null}
            <div className="panel-actions">
              <button className="btn block" onClick={() => $dialog.set({ kind: 'room', key: room.key })} type="button">
                <Icon name="edit" size={15} /> Edit group
              </button>
              <button className="btn block danger" onClick={() => $dialog.set({ kind: 'delete-room', key: room.key })} type="button">
                <Icon name="trash" size={15} /> Delete group
              </button>
            </div>
          </>
        )}
      </div>
    </PanelShell>
  )
}

import { duplicateBot } from './templates'

