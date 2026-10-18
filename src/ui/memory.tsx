/**
 * Memory views: one bot's own memory (in its settings sheet) and the shared memory about you
 * (from the + menu). Both are plain lists you can add to, edit and delete from.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import {
  $botMemory,
  $sharedFacts,
  addSharedFact,
  editBotMemory,
  editSharedFact,
  fingerprint,
  isMemory,
  loadBotMemory,
  type MemoryTarget,
  removeSharedFact,
  syncSharedMemory,
  usage
} from '../lib/memory'
import { cleanError } from '../lib/native'
import { $allBots, $userName } from '../lib/store'
import { Icon } from './icons'

interface Entry {
  key: string
  text: string
  meta?: string
}

/** Resolves true when the change went through, so the editor can close. */
type Run = (work: () => Promise<unknown>) => Promise<boolean>

function EntryList({
  entries,
  empty,
  placeholder,
  run,
  onAdd,
  onEdit,
  onRemove
}: {
  entries: Entry[]
  empty: string
  placeholder: string
  run: Run
  onAdd: (text: string) => Promise<unknown>
  onEdit: (entry: Entry, text: string) => Promise<unknown>
  onRemove: (entry: Entry) => Promise<unknown>
}) {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<null | string>(null)
  const [edit, setEdit] = useState('')

  const add = async () => {
    if (draft.trim() && (await run(() => onAdd(draft)))) {
      setDraft('')
    }
  }

  const saveEdit = async (entry: Entry) => {
    if (await run(() => onEdit(entry, edit))) {
      setEditing(null)
    }
  }

  return (
    <div className="mem-list">
      {entries.map(entry =>
        editing === entry.key ? (
          <div className="mem-entry" data-editing key={entry.key}>
            <textarea
              autoFocus
              className="input"
              onChange={event => setEdit(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  void saveEdit(entry)
                } else if (event.key === 'Escape') {
                  event.stopPropagation()
                  setEditing(null)
                }
              }}
              rows={Math.min(6, Math.max(2, Math.ceil(edit.length / 70)))}
              value={edit}
            />
            <div className="mem-edit-actions">
              <button className="btn sm ghost" onClick={() => setEditing(null)} type="button">
                Cancel
              </button>
              <button className="btn sm primary" disabled={!edit.trim() || edit.trim() === entry.text} onClick={() => void saveEdit(entry)} type="button">
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="mem-entry" key={entry.key}>
            <div>
              <p>{entry.text}</p>
              {entry.meta ? <small>{entry.meta}</small> : null}
            </div>
            <button
              aria-label="Edit"
              className="icon-btn xs ghost"
              onClick={() => {
                setEditing(entry.key)
                setEdit(entry.text)
              }}
              title="Edit"
              type="button"
            >
              <Icon name="edit" size={13} />
            </button>
            <button aria-label="Delete" className="icon-btn xs ghost" onClick={() => void run(() => onRemove(entry))} title="Delete" type="button">
              <Icon name="trash" size={13} />
            </button>
          </div>
        )
      )}
      {!entries.length ? <div className="panel-empty">{empty}</div> : null}
      <div className="inline-field">
        <input className="input" onChange={event => setDraft(event.target.value)} onKeyDown={event => event.key === 'Enter' && void add()} placeholder={placeholder} value={draft} />
        <button className="btn" disabled={!draft.trim()} onClick={() => void add()} type="button">
          Add
        </button>
      </div>
    </div>
  )
}

// ── one bot ───────────────────────────────────────────────────────────────
export function MemoryPane({ name, save, onShared }: { name: string; save: Run; onShared: () => void }) {
  const state = useStore($botMemory)[name]
  const shared = useStore($sharedFacts)
  const bot = useStore($allBots).find(b => b.name === name)
  const user = useStore($userName)
  const who = bot?.display || name

  useEffect(() => {
    void loadBotMemory(name, true)
  }, [name])

  if (!isMemory(state)) {
    return state && typeof state === 'object' && 'error' in state ? (
      <div className="panel-empty">
        {state.error}{' '}
        <button className="link-btn" onClick={() => void loadBotMemory(name, true)} type="button">
          Try again
        </button>
      </div>
    ) : (
      <div className="thread-loading">
        <span className="spinner" />
      </div>
    )
  }

  const sharedBy = new Map(shared.map(fact => [fingerprint(fact.text), fact]))

  const section = (target: MemoryTarget, title: string, hint: string, list: string[], empty: string, placeholder: string) => (
    <section className="mem-section">
      <header>
        <div>
          <h4>{title}</h4>
          <p>{hint}</p>
        </div>
        <span className="mem-usage" data-full={usage(list) > state.limits[target] * 0.9 || undefined}>
          {usage(list).toLocaleString()} / {state.limits[target].toLocaleString()}
        </span>
      </header>
      {!state.enabled[target] ? (
        <div className="banner warn">
          <span className="banner-text">
            Hermes has this turned off for {who} (<code>{target === 'memory' ? 'memory.memory_enabled' : 'memory.user_profile_enabled'}</code>), so it won't read or add to it.
          </span>
        </div>
      ) : null}
      <EntryList
        empty={empty}
        entries={list.map(text => ({ key: text, text }))}
        onAdd={text => editBotMemory(name, target, { add: text })}
        onEdit={(entry, text) => {
          const fact = target === 'user' ? sharedBy.get(fingerprint(entry.text)) : undefined

          // A shared fact is changed everywhere it lives, this bot included.
          return fact ? editSharedFact(fact.id, text) : editBotMemory(name, target, { edit: entry.text, to: text })
        }}
        onRemove={entry => editBotMemory(name, target, { remove: entry.text })}
        placeholder={placeholder}
        run={save}
      />
    </section>
  )

  return (
    <div className="pane">
      <header>
        <h3>Memory</h3>
        <p>
          What {who} remembers between chats. It writes these itself with its memory tool, and you can change them here. {who} sees your edits on its
          next message.
        </p>
      </header>
      {section('memory', 'Notes', `${who}'s own notes: your projects, how things are set up, what worked.`, state.notes, 'No notes yet.', 'Add a note')}
      {section(
        'user',
        `What it knows about ${user === 'You' ? 'you' : user}`,
        'New facts it saves here are copied to shared memory, so every bot knows them.',
        state.user,
        'Nothing saved about you yet.',
        'Add a fact about you'
      )}
      <button className="link-btn mem-link" onClick={onShared} type="button">
        <Icon name="users" size={14} />
        Open shared memory
      </button>
    </div>
  )
}

// ── shared about the user ─────────────────────────────────────────────────
export function SharedMemoryBody() {
  const facts = useStore($sharedFacts)
  const bots = useStore($allBots)
  const [error, setError] = useState('')

  useEffect(() => {
    void syncSharedMemory()
  }, [])

  const run: Run = async work => {
    setError('')

    try {
      await work()

      return true
    } catch (err) {
      setError(cleanError(err))

      return false
    }
  }

  const byLine = (by: string) => (by ? `Added by ${bots.find(b => b.name === by)?.display || by}` : 'Added by you')

  return (
    <>
      {error ? <div className="banner bad">{error}</div> : null}
      <div className="mem-scroll">
        <EntryList
          empty="Nothing yet. Add something every bot should know, like your name, time zone or how you like answers."
          entries={facts.map(fact => ({ key: fact.id, text: fact.text, meta: byLine(fact.by) }))}
          onAdd={text => addSharedFact(text)}
          onEdit={(entry, text) => editSharedFact(entry.key, text)}
          onRemove={entry => removeSharedFact(entry.key)}
          placeholder="Add something every bot should know"
          run={run}
        />
      </div>
      <p className="mem-foot">
        Every bot gets this list with its next message. When a bot saves a fact about you with its memory tool, it shows up here too. Editing or deleting
        here also changes the bots' own copies.
      </p>
    </>
  )
}
