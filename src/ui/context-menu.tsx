/**
 * The right-click (and ⋯-button) options menu used throughout the app —
 * roster rows, messages, members. One shared instance, mounted once at the
 * app root (see app.tsx) so it renders above everything and is never
 * clipped by a scrolling list — unlike `Menu` (./menu.tsx), which anchors
 * under a trigger and works only where that trigger isn't inside a
 * scrollable container.
 *
 * Usage is the same event handler for both ways in: a right-click
 *   onContextMenu={e => openContextMenu(e, items)}
 * or a visible options button
 *   onClick={e => openContextMenu(e, items)}
 * — either way the menu opens right at the pointer.
 */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Icon } from './icons'
import type { MenuItem } from './menu'

interface Point {
  clientX: number
  clientY: number
  preventDefault: () => void
  stopPropagation: () => void
}

interface MenuState {
  x: number
  y: number
  items: (MenuItem | 'sep')[]
}

const $contextMenu = atom<MenuState | null>(null)

export function openContextMenu(event: Point, items: (MenuItem | 'sep')[]) {
  event.preventDefault()
  event.stopPropagation()
  $contextMenu.set({ x: event.clientX, y: event.clientY, items })
}

export function closeContextMenu() {
  $contextMenu.set(null)
}

export function ContextMenuHost() {
  const state = useStore($contextMenu)
  const box = useRef<HTMLDivElement | null>(null)
  const [fit, setFit] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    if (!state) {
      setFit(null)
      return
    }

    const el = box.current
    const pad = 8
    const w = el?.offsetWidth || 200
    const h = el?.offsetHeight || 44
    const x = Math.min(state.x, window.innerWidth - w - pad)
    const y = Math.min(state.y, window.innerHeight - h - pad)
    setFit({ x: Math.max(pad, x), y: Math.max(pad, y) })
  }, [state])

  useEffect(() => {
    if (!state) {
      return undefined
    }

    const onMouseDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) {
        closeContextMenu()
      }
    }
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && closeContextMenu()

    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', closeContextMenu)
    window.addEventListener('resize', closeContextMenu)

    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', closeContextMenu)
      window.removeEventListener('resize', closeContextMenu)
    }
  }, [state])

  if (!state) {
    return null
  }

  return (
    <div
      className="menu"
      ref={box}
      style={{ position: 'fixed', top: fit?.y ?? state.y, left: fit?.x ?? state.x, visibility: fit ? 'visible' : 'hidden' }}
    >
      {state.items.map((item, index) =>
        item === 'sep' ? (
          <div className="menu-sep" key={`s${index}`} />
        ) : (
          <button
            className="menu-item"
            data-danger={item.danger || undefined}
            disabled={item.disabled}
            key={item.label}
            onClick={() => {
              closeContextMenu()
              item.onSelect()
            }}
            type="button"
          >
            {item.icon ? <Icon name={item.icon} size={16} /> : null}
            <span>{item.label}</span>
          </button>
        )
      )}
    </div>
  )
}
