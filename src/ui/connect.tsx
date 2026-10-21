import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { $connectError, $connectLog, $connectStep, $saved, cancelConnect, connect, forget, makeConnection } from '../lib/connection'
import { native } from '../lib/native'
import { $phase } from '../lib/store'
import type { Connection } from '../lib/types'
import { BotFace } from './avatar-face'
import { Icon, type IconName } from './icons'
import { isMissingAgentError } from '../lib/install-help'
import { MissingAgent } from './missing-agent'

export type Mode = 'local' | 'remote' | 'ssh'

export const OPTIONS: { mode: Mode; icon: IconName; title: string; body: string }[] = [
  { mode: 'local', icon: 'computer', title: 'This computer', body: 'Use Hermes on this PC — we find it, or start it for you.' },
  { mode: 'remote', icon: 'globe', title: 'Remote server', body: 'A Hermes server address and its session token.' },
  { mode: 'ssh', icon: 'terminal', title: 'Over SSH', body: 'A VM or server you can SSH into. We start Hermes and tunnel to it.' }
]

export function ConnectScreen() {
  const phase = useStore($phase)
  const step = useStore($connectStep)
  const error = useStore($connectError)
  const logPath = useStore($connectLog)
  const saved = useStore($saved)
  const [mode, setMode] = useState<Mode>('local')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [label, setLabel] = useState('')
  const busy = phase === 'connecting' || phase === 'boot'
  const [machines, setMachines] = useState<Connection[]>([])

  useEffect(() => {
    void native.hermesMachines().then(list => setMachines(list.filter(m => !saved.some(c => c.ssh?.host === m.ssh?.host && c.ssh?.user === m.ssh?.user)))).catch(() => undefined)
  }, [saved.length])

  const go = (conn: Connection) => void connect(conn).catch(() => undefined)

  const submit = () => {
    if (mode === 'local') {
      go(saved.find(c => c.kind === 'local') || makeConnection('local', {}))
    } else if (mode === 'remote') {
      if (!url.trim()) {
        return
      }

      go(makeConnection('remote', { baseUrl: url.trim(), token: token.trim(), label: label.trim() || undefined }))
    } else {
      if (!host.trim()) {
        return
      }

      go(
        makeConnection('ssh', {
          label: label.trim() || undefined,
          ssh: { host: host.trim(), user: user.trim() || undefined, port: Number(port) || undefined, keyPath: keyPath.trim() || undefined }
        })
      )
    }
  }

  return (
    <div className="connect">
      <div className="drag-strip" />
      <div className="connect-card">
        <div className="connect-hero">
          <BotFace color="#8b5cf6" image={null} mood={busy ? 'work' : 'idle'} name="hermes-bots" shape="blobatar:hermes-bots:round" size={76} />
          <h1>Connect to Hermes</h1>
          <p>Your bots, their tools and memory live on a Hermes server. Pick where it runs.</p>
        </div>

        {busy ? (
          <>
            <div className="connect-progress">
              <span className="spinner" />
              <span>{step || 'Connecting…'}</span>
            </div>
            <button className="btn ghost block" onClick={cancelConnect} type="button">
              Cancel
            </button>
          </>
        ) : (
          <>
            {saved.length ? (
              <div className="connect-recent">
                <div className="label">Recent</div>
                {saved.map(conn => (
                  <div className="recent-row" key={conn.id}>
                    <button className="recent-main" onClick={() => go(conn)} type="button">
                      <span className="recent-icon">
                        <Icon name={conn.kind === 'local' ? 'computer' : conn.kind === 'ssh' ? 'terminal' : 'globe'} size={17} />
                      </span>
                      <span className="recent-text">
                        <b>{conn.label}</b>
                        <small>
                          {conn.kind === 'local'
                            ? 'This computer'
                            : conn.kind === 'ssh'
                              ? `SSH · ${conn.ssh?.user ? `${conn.ssh.user}@` : ''}${conn.ssh?.host}`
                              : conn.baseUrl}
                        </small>
                      </span>
                      <span className="recent-go">Connect</span>
                    </button>
                    <button aria-label="Forget" className="icon-btn sm ghost" onClick={() => void forget(conn.id)} type="button">
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {machines.length ? (
              <div className="connect-recent">
                <div className="label">Your machines in Hermes</div>
                {machines.map(conn => (
                  <div className="recent-row" key={conn.id}>
                    <button className="recent-main featured" onClick={() => go(conn)} type="button">
                      <span className="recent-icon">
                        <Icon name="server" size={17} />
                      </span>
                      <span className="recent-text">
                        <b>{conn.label}</b>
                        <small>
                          SSH · {conn.ssh?.user ? `${conn.ssh.user}@` : ''}
                          {conn.ssh?.host}
                        </small>
                      </span>
                      <span className="recent-go">Connect</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="connect-options">
              {OPTIONS.map(option => (
                <button
                  className="option"
                  data-on={mode === option.mode || undefined}
                  key={option.mode}
                  onClick={() => setMode(option.mode)}
                  type="button"
                >
                  <span className="option-icon">
                    <Icon name={option.icon} size={19} />
                  </span>
                  <span className="option-text">
                    <b>{option.title}</b>
                    <small>{option.body}</small>
                  </span>
                  <span className="radio" />
                </button>
              ))}
            </div>

            {mode === 'remote' ? (
              <div className="fields">
                <input autoFocus className="input" onChange={e => setUrl(e.target.value)} placeholder="Server address — e.g. https://hermes.example.com" value={url} />
                <input className="input" onChange={e => setToken(e.target.value)} placeholder="Session token" type="password" value={token} />
                <input className="input" onChange={e => setLabel(e.target.value)} placeholder="Name (optional)" value={label} />
              </div>
            ) : mode === 'ssh' ? (
              <div className="fields">
                <div className="row2">
                  <input autoFocus className="input" onChange={e => setHost(e.target.value)} placeholder="Host — e.g. 203.0.113.10" value={host} />
                  <input className="input narrow" onChange={e => setPort(e.target.value)} placeholder="Port" value={port} />
                </div>
                <input className="input" onChange={e => setUser(e.target.value)} placeholder="User — e.g. ubuntu" value={user} />
                <input className="input" onChange={e => setKeyPath(e.target.value)} placeholder="Private key file (optional) — e.g. C:\Users\you\.ssh\id_ed25519" value={keyPath} />
                <input className="input" onChange={e => setLabel(e.target.value)} placeholder="Name (optional) — e.g. My Hermes server" value={label} />
              </div>
            ) : null}

            {error && mode === 'local' && isMissingAgentError(error) ? (
              <MissingAgent logPath={logPath} onRetry={submit} platform={native.platform} />
            ) : error ? (
              <div className="banner bad">
                <Icon name="shield" size={16} />
                <span className="banner-text">
                  {error}
                  {logPath ? <small className="banner-hint">Details: {logPath}</small> : null}
                </span>
              </div>
            ) : null}

            <button className="btn primary block lg" onClick={submit} type="button">
              Connect
            </button>
          </>
        )}
      </div>
    </div>
  )
}
