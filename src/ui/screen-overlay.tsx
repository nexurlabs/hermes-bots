/**
 * The large view of a screen (the bot's sandbox desktop or the last This PC screenshot):
 * a modal over the whole app window, portalled to <body> so no panel styling can shrink it.
 * The screen frame keeps the screen's aspect ratio and is sized in CSS from the window
 * (`--ar`), so it fills the space along one axis and letterboxes only along the other,
 * and it follows the window as it resizes. The minimize button in the top-right corner
 * shrinks it back to the panel preview (for the sandbox that also hands control back).
 *
 * Esc: with `onEscTap` (the sandbox view, where Esc belongs to the remote desktop) a tap is
 * handed to `onEscTap` once, on release, and holding Esc for HOLD_MS minimizes the view instead
 * (nothing is sent to the remote then). Key autorepeat while holding is swallowed. Without
 * `onEscTap` (This PC's screenshot view, nothing to send to) a plain Esc minimizes it.
 */
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Icon } from './icons'

/** How long Esc must be held to minimize the large view. */
export const HOLD_MS = 1000
const HINT_MS = 4000

/** After a hold-to-minimize the overlay is gone but Esc is still down: keep its autorepeat and
 *  its keyup away from the rest of the app (and the preview) until the key is released. */
function swallowEscUntilRelease() {
  const eat = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()

    if (event.type === 'keyup') stop()
  }
  const stop = () => {
    window.removeEventListener('keydown', eat, true)
    window.removeEventListener('keyup', eat, true)
    window.removeEventListener('blur', stop)
  }
  window.addEventListener('keydown', eat, true)
  window.addEventListener('keyup', eat, true)
  window.addEventListener('blur', stop)
}

export type Dot = 'idle' | 'connecting' | 'live' | 'you' | 'other' | 'error' | 'off'

export function StatusDot({ tone, title }: { tone: Dot; title: string }) {
  return <i aria-label={title} className="screen-dot" data-tone={tone} role="img" title={title} />
}

export function ScreenOverlay({
  ratio,
  label,
  dot,
  onClose,
  onEscTap,
  demoHold,
  banner,
  children
}: {
  ratio: number
  label: string
  dot: { tone: Dot; title: string }
  onClose: () => void
  /** Given: Esc taps go here and only a held Esc minimizes. Omitted: a plain Esc minimizes. */
  onEscTap?: () => void
  /** Design preview only: show the hold hint frozen part-way. */
  demoHold?: boolean
  /** A thin strip over the top of the screen (the sign-in handoff's instruction and Done). */
  banner?: ReactNode
  children: ReactNode
}) {
  const holdMode = Boolean(onEscTap)
  const [holding, setHolding] = useState(Boolean(demoHold))
  const [hint, setHint] = useState(holdMode)
  const timer = useRef<null | ReturnType<typeof setTimeout>>(null)
  const latest = useRef({ onClose, onEscTap })
  latest.current = { onClose, onEscTap }

  // Make the hold-Esc hint discoverable: show it for a few seconds after opening.
  useEffect(() => {
    if (!holdMode || demoHold) return undefined
    const t = setTimeout(() => setHint(false), HINT_MS)

    return () => clearTimeout(t)
  }, [demoHold, holdMode])

  useEffect(() => {
    const cancel = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setHolding(false)
    }

    // Capture phase on window, so these run before noVNC's keyboard handler on the canvas;
    // stopping propagation keeps noVNC from ever seeing Esc (we send it ourselves on a tap).
    const onDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()

      if (!latest.current.onEscTap) {
        latest.current.onClose()

        return
      }

      // Autorepeat while holding, or a second keydown without a keyup: ignore.
      if (event.repeat || timer.current) return
      setHolding(true)
      timer.current = setTimeout(() => {
        timer.current = null
        setHolding(false)
        swallowEscUntilRelease()
        latest.current.onClose()
      }, HOLD_MS)
    }

    const onUp = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !latest.current.onEscTap) return
      event.preventDefault()
      event.stopPropagation()

      if (timer.current) {
        // Released before the hold finished: a tap, sent to the remote exactly once.
        cancel()
        latest.current.onEscTap()
      }
    }

    // Focus left the window mid-hold (Alt+Tab…): no tap, no close.
    const onBlur = () => cancel()

    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', onBlur)

    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', onBlur)
      cancel()
    }
  }, [])

  const closeTitle = holdMode ? 'Minimize (or hold Esc)' : 'Minimize (Esc)'

  return createPortal(
    <div aria-label={label} aria-modal="true" className="screen-overlay" role="dialog" style={{ '--ar': String(ratio > 0 ? ratio : 1.6) } as CSSProperties}>
      <div aria-hidden="true" className="screen-overlay-bar" />
      {banner ? <div className="screen-overlay-banner">{banner}</div> : null}
      <div className="screen-overlay-frame">{children}</div>
      <div className="screen-overlay-dot">
        <StatusDot {...dot} />
      </div>
      {holdMode ? (
        <div aria-live="polite" className="screen-hold" data-demo={demoHold || undefined} data-holding={holding || undefined} data-show={hint || holding || undefined}>
          <span>{holding ? 'Keep holding to minimize' : 'Hold Esc to minimize'}</span>
          <i>
            <b />
          </i>
        </div>
      ) : null}
      <button aria-label={closeTitle} className="icon-btn sm glass screen-overlay-close" onClick={onClose} title={closeTitle} type="button">
        <Icon name="minimize" size={14} />
      </button>
    </div>,
    document.body
  )
}

/** "1280x800" or "1280x800x24" → 1.6; anything else → fallback. */
export function geometryRatio(geometry: string | undefined, fallback = 16 / 10) {
  const match = /^(\d+)x(\d+)/.exec(geometry || '')
  const w = match ? Number(match[1]) : 0
  const h = match ? Number(match[2]) : 0

  return w > 0 && h > 0 ? w / h : fallback
}
