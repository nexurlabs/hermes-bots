import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { $chats } from '../lib/chat'
import { $rooms, roomBots } from '../lib/rooms'
import { $jumpTo, $searchPalette, allDocs, loadMatchingChats, searchDocs, type SearchFilters, type SearchHit } from '../lib/search'
import { $allBots, $selection } from '../lib/store'
import { $openThread } from '../lib/threads'
import { Avatar, AvatarStack } from './avatar'
import { Icon } from './icons'

const DEBOUNCE_MS = 120

const when = (at: number) => {
  if (!at) return ''
  const date = new Date(at)
  const today = new Date()

  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) })
}

function Marked({ text, marks }: { text: string; marks: [number, number][] }) {
  const parts: React.ReactNode[] = []
  let at = 0

  for (const [start, end] of marks) {
    if (start < at) continue
    parts.push(text.slice(at, start), <mark key={start}>{text.slice(start, end)}</mark>)
    at = end
  }

  parts.push(text.slice(at))

  return <>{parts}</>
}

/** Opens a result: selects its chat, opens the thread pane for a reply, then scrolls to and flashes it. */
export function jumpTo(hit: SearchHit) {
  const { doc } = hit
  $selection.set(doc.target)
  $openThread.set(doc.thread ? { scope: doc.scope, root: doc.thread } : null)
  $jumpTo.set({ scope: doc.scope, id: doc.id, at: Date.now() })
  $searchPalette.set(false)
}

export function SearchPalette() {
  const open = useStore($searchPalette)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      const key = event.key.toLowerCase()

      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (key === 'k' || key === 'f') && (!typing || key === 'k')) {
        if (document.querySelector('.screen-overlay')) return
        event.preventDefault()
        $searchPalette.set(!$searchPalette.get())
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return open ? createPortal(<Palette />, document.body) : null
}

function Palette() {
  const bots = useStore($allBots)
  const rooms = useStore($rooms)
  const chats = useStore($chats)
  const [query, setQuery] = useState(() => sessionStorage.getItem('search:last') || '')
  const [debounced, setDebounced] = useState(query)
  const [filters, setFilters] = useState<SearchFilters>({ scope: '', who: 'all' })
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS)
    sessionStorage.setItem('search:last', query)

    return () => clearTimeout(timer)
  }, [query])

  // Pull in bot chats Hermes says match (or all unloaded ones on an older Hermes), a few at a time.
  useEffect(() => {
    if (debounced.trim().length < 2) return
    let live = true
    setLoading(true)
    void loadMatchingChats(debounced.trim(), () => live && setTick(t => t + 1)).finally(() => live && setLoading(false))

    return () => {
      live = false
    }
  }, [debounced])

  const hits = useMemo(() => searchDocs(allDocs(), debounced, filters), [debounced, filters, chats, rooms, tick])

  const groups = useMemo(() => {
    const out: { scope: string; hits: { hit: SearchHit; index: number }[] }[] = []
    const byScope = new Map<string, number>()

    hits.forEach(hit => {
      let at = byScope.get(hit.doc.scope)

      if (at === undefined) {
        at = out.length
        byScope.set(hit.doc.scope, at)
        out.push({ scope: hit.doc.scope, hits: [] })
      }

      out[at].hits.push({ hit, index: 0 })
    })

    let n = 0
    for (const group of out) for (const item of group.hits) item.index = n++

    return out
  }, [hits])

  const flat = groups.flatMap(group => group.hits.map(item => item.hit))

  useEffect(() => setActive(0), [debounced, filters])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const chatOf = (scope: string) => {
    if (scope.startsWith('bot:')) {
      const bot = bots.find(b => b.name === scope.slice(4))

      return { label: bot?.display || scope.slice(4), face: <Avatar badge={false} bot={bot || null} size={22} /> }
    }

    const room = Object.values(rooms).find(r => `room:${r.roomId}` === scope)

    return { label: room?.name || 'Group', face: room ? <AvatarStack bots={roomBots(room)} size={22} /> : null }
  }

  const scopes = [
    ...bots.map(bot => ({ scope: `bot:${bot.name}`, label: bot.display })),
    ...Object.values(rooms).map(room => ({ scope: `room:${room.roomId}`, label: room.name }))
  ]

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      $searchPalette.set(false)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(i => Math.min(flat.length - 1, i + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(i => Math.max(0, i - 1))
    } else if (event.key === 'Enter' && flat[active]) {
      event.preventDefault()
      jumpTo(flat[active])
    }
  }

  const nameOf = (hit: SearchHit) => (hit.doc.fromMe ? 'You' : bots.find(b => b.name === hit.doc.from)?.display || hit.doc.from || 'Bot')

  return (
    <div className="palette-backdrop" onMouseDown={event => event.target === event.currentTarget && $searchPalette.set(false)}>
      <div aria-label="Search chats" className="palette" onKeyDown={onKey} role="dialog">
        <div className="palette-input">
          <Icon name="search" size={17} />
          <input onChange={event => setQuery(event.target.value)} placeholder="Search messages, files and cards in every chat" ref={input} value={query} />
          {loading ? <span className="spinner xs" /> : null}
          <kbd>Esc</kbd>
        </div>
        <div className="palette-filters">
          <select aria-label="Chat" onChange={event => setFilters(f => ({ ...f, scope: event.target.value }))} value={filters.scope}>
            <option value="">All chats</option>
            {scopes.map(item => (
              <option key={item.scope} value={item.scope}>
                {item.label}
              </option>
            ))}
          </select>
          {(['all', 'me', 'bots'] as const).map(who => (
            <button className="palette-chip" data-on={filters.who === who || undefined} key={who} onClick={() => setFilters(f => ({ ...f, who }))} type="button">
              {who === 'all' ? 'Everyone' : who === 'me' ? 'From me' : 'From bots'}
            </button>
          ))}
          <span className="palette-count">{debounced.trim() ? `${hits.length}${hits.length >= 200 ? '+' : ''} result${hits.length === 1 ? '' : 's'}` : ''}</span>
        </div>
        <div className="palette-results" ref={list}>
          {!debounced.trim() ? (
            <div className="palette-empty">Type to search every 1:1 chat and group, thread replies, file names and cards.</div>
          ) : !hits.length && !loading ? (
            <div className="palette-empty">No matches.</div>
          ) : (
            groups.map(group => {
              const chat = chatOf(group.scope)

              return (
                <section className="palette-group" key={group.scope}>
                  <header>
                    {chat.face}
                    <b>{chat.label}</b>
                    <small>{group.hits.length}</small>
                  </header>
                  {group.hits.map(({ hit, index }) => (
                    <button
                      className="palette-hit"
                      data-active={index === active || undefined}
                      data-index={index}
                      key={`${hit.doc.id}:${hit.doc.kind}:${index}`}
                      onClick={() => jumpTo(hit)}
                      onMouseMove={() => setActive(index)}
                      type="button"
                    >
                      <span className="palette-hit-top">
                        <b>{nameOf(hit)}</b>
                        {hit.doc.thread ? <span className="palette-tag">thread</span> : null}
                        {hit.doc.kind !== 'message' ? <span className="palette-tag">{hit.doc.kind}</span> : null}
                        <small>{when(hit.doc.at)}</small>
                      </span>
                      <span className="palette-snippet">
                        <Marked marks={hit.marks} text={hit.snippet} />
                      </span>
                    </button>
                  ))}
                </section>
              )
            })
          )}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
          <span>
            <kbd>Ctrl</kbd>
            <kbd>K</kbd> to toggle
          </span>
        </div>
      </div>
    </div>
  )
}

