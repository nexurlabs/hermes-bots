/**
 * Settings > Machines: every Hermes host the app is connected to, with its status, a name you can
 * change, the default machine for new bots, and adding/removing hosts. Adding one uses the same
 * three ways as the Connect screen (this computer, a server URL + token, or SSH).
 */
import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { makeConnection } from '../lib/connection'
import { $defaultHost, $machines, addMachine, removeMachine, renameMachine, retryMachine, setDefaultHost, type MachineView } from '../lib/hosts'
import { cleanError } from '../lib/native'
import { toast } from '../lib/store'
import type { Connection } from '../lib/types'
import { OPTIONS, type Mode } from './connect'
import { Icon } from './icons'

const iconOf = (kind: Connection['kind']) => (kind === 'local' ? 'computer' : kind === 'ssh' ? 'terminal' : 'globe')
const stateText = (m: MachineView) => (m.state === 'online' ? 'Online' : m.state === 'connecting' ? 'Connecting…' : 'Offline')

function MachineRow({ m, isDefault, many }: { m: MachineView; isDefault: boolean; many: boolean }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(m.label)
  const [busy, setBusy] = useState(false)
  const save = () => {
    setEditing(false)
    if (label.trim() && label.trim() !== m.label) void renameMachine(m.id, label)
  }

  return (
    <div className="machine-row" data-state={m.state}>
      <span className="machine-icon">
        <Icon name={iconOf(m.kind)} size={17} />
        <i className="machine-dot" title={stateText(m)} />
      </span>
      <div className="machine-text">
        {editing ? (
          <input autoFocus className="input sm" onBlur={save} onChange={e => setLabel(e.target.value)} onKeyDown={e => (e.key === 'Enter' ? save() : e.key === 'Escape' && setEditing(false))} value={label} />
        ) : (
          <b onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {m.label}
            {m.main ? <small className="machine-tag">main</small> : null}
            {many && isDefault ? <small className="machine-tag on">new bots</small> : null}
          </b>
        )}
        <small>
          {stateText(m)} · {m.where}
          {m.error && m.state === 'offline' ? ` · ${m.error}` : ''}
        </small>
      </div>
      <div className="machine-actions">
        {many && !isDefault && m.state === 'online' ? (
          <button className="btn sm ghost" onClick={() => void setDefaultHost(m.id)} title="New bots are created on this machine" type="button">
            Use for new bots
          </button>
        ) : null}
        {m.state === 'offline' && !m.main ? (
          <button className="btn sm ghost" disabled={busy} onClick={() => (setBusy(true), void retryMachine(m.id).finally(() => setBusy(false)))} type="button">
            Retry
          </button>
        ) : null}
        <button aria-label="Rename" className="icon-btn sm ghost" onClick={() => (setLabel(m.label), setEditing(true))} type="button">
          <Icon name="edit" size={14} />
        </button>
        {!m.main ? (
          <button
            aria-label="Remove machine"
            className="icon-btn sm ghost"
            onClick={() => window.confirm(`Remove ${m.label}? Its bots disappear from the app (nothing is deleted on that machine).`) && void removeMachine(m.id)}
            type="button"
          >
            <Icon name="trash" size={14} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function AddMachine({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('remote')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const conn = (): null | Connection =>
    mode === 'local'
      ? makeConnection('local', { label: label.trim() || undefined })
      : mode === 'remote'
        ? url.trim()
          ? makeConnection('remote', { baseUrl: url.trim(), token: token.trim(), label: label.trim() || undefined })
          : null
        : host.trim()
          ? makeConnection('ssh', { label: label.trim() || undefined, ssh: { host: host.trim(), user: user.trim() || undefined, port: Number(port) || undefined, keyPath: keyPath.trim() || undefined } })
          : null

  const submit = async () => {
    const next = conn()
    if (!next) return
    setBusy(true)
    setError('')
    try {
      await addMachine(next)
      toast(`${next.label} added`, 'good')
      onDone()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="machine-add">
      <div className="connect-options compact">
        {OPTIONS.map(option => (
          <button className="option" data-on={mode === option.mode || undefined} key={option.mode} onClick={() => setMode(option.mode)} type="button">
            <span className="option-icon">
              <Icon name={option.icon} size={17} />
            </span>
            <span className="option-text">
              <b>{option.title}</b>
            </span>
            <span className="radio" />
          </button>
        ))}
      </div>
      {mode === 'remote' ? (
        <div className="fields">
          <input autoFocus className="input" onChange={e => setUrl(e.target.value)} placeholder="Server address — e.g. https://hermes.example.com" value={url} />
          <input className="input" onChange={e => setToken(e.target.value)} placeholder="Session token" type="password" value={token} />
        </div>
      ) : mode === 'ssh' ? (
        <div className="fields">
          <div className="row2">
            <input autoFocus className="input" onChange={e => setHost(e.target.value)} placeholder="Host — e.g. 203.0.113.10" value={host} />
            <input className="input narrow" onChange={e => setPort(e.target.value)} placeholder="Port" value={port} />
          </div>
          <input className="input" onChange={e => setUser(e.target.value)} placeholder="User — e.g. ubuntu" value={user} />
          <input className="input" onChange={e => setKeyPath(e.target.value)} placeholder="Private key file (optional)" value={keyPath} />
        </div>
      ) : (
        <small className="machine-hint">Hermes on this PC — found, or started for you.</small>
      )}
      <input className="input" onChange={e => setLabel(e.target.value)} placeholder="Name (optional) — e.g. Office Mac" value={label} />
      {error ? <div className="banner bad">{error}</div> : null}
      <div className="machine-add-actions">
        <button className="btn ghost sm" onClick={onDone} type="button">
          Cancel
        </button>
        <button className="btn primary sm" disabled={busy || !conn()} onClick={() => void submit()} type="button">
          {busy ? <span className="spinner xs" /> : null} Connect
        </button>
      </div>
    </div>
  )
}

export function MachinesSettings({ startAdding = false }: { startAdding?: boolean }) {
  const machines = useStore($machines)
  const def = useStore($defaultHost)
  const [adding, setAdding] = useState(startAdding)
  const many = machines.length > 1

  return (
    <div className="field machines">
      <span>Machines</span>
      <div className="machine-list">
        {machines.map(m => (
          <MachineRow isDefault={def === m.id} key={m.id || 'main'} m={m} many={many} />
        ))}
      </div>
      {adding ? (
        <AddMachine onDone={() => setAdding(false)} />
      ) : (
        <button className="btn sm ghost machine-add-btn" onClick={() => setAdding(true)} type="button">
          <Icon name="plus" size={14} /> Add a machine
        </button>
      )}
      <small>Bots from every machine show together. Each bot runs on its own machine; group chats can mix them.</small>
    </div>
  )
}

/** "Machine" choice for a new bot / template import (only when there's more than one). */
export function MachineField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const machines = useStore($machines)

  if (machines.length < 2) return null

  return (
    <label className="field">
      <span>Machine</span>
      <select className="input" onChange={e => onChange(e.target.value)} value={value}>
        {machines.map(m => (
          <option disabled={m.state !== 'online'} key={m.id || 'main'} value={m.id}>
            {m.label}
            {m.state !== 'online' ? ' (offline)' : ''}
          </option>
        ))}
      </select>
      <small>Where the bot lives: its chats, tools, files and memory are on that Hermes.</small>
    </label>
  )
}

