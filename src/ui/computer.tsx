/**
 * Computer tab — a live view of the bot's own desktop on the Hermes machine
 * (the headless Xfce screen its computer-use tool drives). The gateway owns the
 * screen and a "who is in control" lease. The panel shows a small view-only noVNC
 * preview with one Open button; Open expands it to a large overlay and takes the
 * lease for this viewer (the user drives the mouse and keyboard), and closing the
 * overlay releases the lease so the bot has the screen again.
 *
 * Wire contract: tui_gateway/contracts/display.py — `display.status/start/stop/
 * observe/install/lease.*`, a single-use ticket redeemed on /api/display/ws, and
 * the `display.lease` / `display.status` / `display.install.*` events.
 */
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

// @ts-ignore — vendored noVNC (plain ES modules, no types)
import RFB from '../../vendor/novnc/core/rfb.js'
import { $prompts } from '../lib/chat'
import { $computerDemo } from '../lib/computer-demo'
import { $handoff } from '../lib/handoff'
import { finishHandoff } from '../lib/handoff-actions'
import { gateway } from '../lib/gateway'
import { readClipboardText } from '../lib/native'
import { $active, toast } from '../lib/store'
import { endpointOf, hostOf, machineLabel } from '../lib/hosts'
import type { Bot } from '../lib/types'
import { Icon } from './icons'
import { type Dot, geometryRatio, ScreenOverlay, StatusDot } from './screen-overlay'
import { ThisPcTab } from './this-pc'

// Sandbox (the bot's own desktop on the Hermes machine) vs This PC (this computer): a small icon toggle.
function ModeToggle({ mode, onChange }: { mode: 'sandbox' | 'thispc'; onChange: (mode: 'sandbox' | 'thispc') => void }) {
  return (
    <div className="mode-toggle" role="tablist">
      {(
        [
          ['sandbox', 'server', "Bot's computer (sandbox on the Hermes machine)"],
          ['thispc', 'computer', 'This PC']
        ] as const
      ).map(([id, icon, label]) => (
        <button aria-label={label} aria-selected={id === mode} data-on={id === mode || undefined} key={id} onClick={() => onChange(id)} role="tab" title={label} type="button">
          <Icon name={icon} size={14} />
        </button>
      ))}
    </div>
  )
}

interface Lease {
  holder: 'agent' | 'human'
  viewer_hash?: null | string
  since?: number
  epoch?: number
  reason?: string
}

interface Status {
  profile: string
  profile_key: string
  supported: boolean
  installed: boolean
  missing: string[]
  running: boolean
  display?: null | string
  geometry?: string
  install_command?: null | string
  blocker?: null | string
  placement?: string
  image_switch?: null | { current_image: string; target_image: string; containers: number }
  lease: Lease
}

interface Observe extends Status {
  ticket: string
  path: string
  viewer_id: string
}

type Conn = 'idle' | 'attaching' | 'live' | 'error'

const CLOSE_CONTROL_TAKEN = 4000
const EVICTION_WINDOW_MS = 10_000
const MAX_RAPID_EVICTIONS = 3
const MAX_PASTE = 256 * 1024
const XK_ESCAPE = 0xff1b
const XK_SHIFT_L = 0xffe1
const XK_CONTROL_L = 0xffe3
const XK_CONTROL_R = 0xffe4
const XK_INSERT = 0xff63
const XK_V = 0x56
/** Paste budget in UTF-8 bytes: Xvnc runs with -MaxCutText 262144 and Hermes's bridge closes the
 *  socket on a bigger ClientCutText, so stay a little under it. */
const MAX_PASTE_BYTES = 256 * 1024 - 1024

async function viewerHash(id: string) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))

    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12)
  } catch {
    return ''
  }
}

function errText(error: unknown) {
  return String((error as Error)?.message || error || 'Something went wrong')
}

function isUnavailable(error: unknown) {
  const text = errText(error).toLowerCase()

  return text.includes('method not found') || text.includes('method-not-found') || text.includes('-32601')
}

export function ComputerTab({ bot }: { bot: Bot }) {
  const [mode, setMode] = useState<'sandbox' | 'thispc'>(() => $computerDemo.get()?.mode || 'sandbox')

  return (
    <div className="computer-tab">
      <ModeToggle mode={mode} onChange={setMode} />
      {mode === 'sandbox' ? <SandboxPanel bot={bot} /> : <ThisPcTab profile={bot.name} />}
    </div>
  )
}

function SandboxPanel({ bot }: { bot: Bot }) {
  const active = useStore($active)
  const prompts = useStore($prompts)
  const demoView = useStore($computerDemo)
  const isDemo = Boolean(demoView)
  const [status, setStatus] = useState<null | Status>(null)
  const [lease, setLease] = useState<Lease | null>(null)
  const [viewer, setViewer] = useState<null | { id: string; hash: string }>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [conn, setConn] = useState<Conn>('idle')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [evicted, setEvicted] = useState(false)
  const [open, setOpen] = useState(false)
  const [ratio, setRatio] = useState(16 / 10)
  const [installPhase, setInstallPhase] = useState<'idle' | 'running' | 'failed'>('idle')
  const [log, setLog] = useState<string[]>([])
  const [password, setPassword] = useState('')

  // One host element for noVNC for the life of the panel. It is moved between the small
  // preview slot and the large overlay slot, so opening never reconnects the stream.
  const host = useMemo(() => {
    const el = document.createElement('div')
    el.className = 'computer-canvas'

    return el
  }, [])
  const stage = useRef<HTMLDivElement | null>(host)
  const previewSlot = useRef<HTMLDivElement | null>(null)
  const overlaySlot = useRef<HTMLDivElement | null>(null)
  const rfb = useRef<any>(null)
  const socket = useRef<null | WebSocket>(null)
  const generation = useRef(0)
  const viewerRef = useRef<null | { id: string; hash: string }>(null)
  const dialedAt = useRef(0)
  const rapid = useRef(0)
  const pasteOff = useRef<(() => void) | null>(null)
  const statusRef = useRef<null | Status>(null)
  statusRef.current = status
  const openRef = useRef(false)
  openRef.current = open
  /** This viewer asked for the lease since the overlay opened (so closing must release it). */
  const acquired = useRef(false)

  const call = useCallback(
    <T,>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000) =>
      gateway.request<T>(method, { profile: bot.name, ...params }, timeoutMs),
    [bot.name]
  )

  useLayoutEffect(() => {
    const slot = open ? overlaySlot.current : previewSlot.current

    if (slot && host.parentNode !== slot) {
      slot.appendChild(host)

      // Back in the preview: drop the canvas focus it had in the large view, or the preview's
      // :focus-within would keep the hover-only Open button showing.
      if (!open && document.activeElement instanceof HTMLElement && host.contains(document.activeElement)) {
        document.activeElement.blur()
      }
    }
  })

  const applyStatus = useCallback((next: Status) => {
    setStatus(next)
    setLease(next.lease)
    setUnavailable(false)
    setRatio(r => (next.geometry ? geometryRatio(next.geometry, r) : r))
  }, [])

  const refresh = useCallback(async () => {
    if ($computerDemo.get()) {
      return
    }

    try {
      applyStatus(await call<Status>('display.status'))
      setError('')
    } catch (err) {
      if (isUnavailable(err)) {
        setUnavailable(true)
      } else {
        setError(errText(err))
      }
    }
  }, [applyStatus, call])

  // Design preview: a still picture stands in for the stream, nothing talks to Hermes.
  useEffect(() => {
    if (!demoView || demoView.mode !== 'sandbox') {
      return
    }

    const img = document.createElement('img')
    img.src = demoView.screen
    img.alt = ''
    img.className = 'computer-demo-screen'
    host.replaceChildren(img)
    const demoViewer = { id: 'demo', hash: 'demo' }
    viewerRef.current = demoViewer
    setViewer(demoViewer)
    applyStatus({
      profile: bot.name,
      profile_key: bot.name,
      supported: true,
      installed: true,
      missing: [],
      running: true,
      display: ':1',
      geometry: `${demoView.width}x${demoView.height}`,
      lease: demoView.open ? { holder: 'human', viewer_hash: 'demo' } : { holder: 'agent' }
    })
    setConn('live')
    setOpen(demoView.open)
    acquired.current = demoView.open
  }, [applyStatus, bot.name, demoView, host])

  // status + pushed events
  useEffect(() => {
    if (isDemo) {
      return undefined
    }

    void refresh()

    const off = gateway.on(event => {
      const payload = event.payload
      const key = statusRef.current?.profile_key

      if (!payload || !key || payload.profile_key !== key) {
        return
      }

      if (event.type === 'display.lease' && payload.lease) {
        setLease(payload.lease)
      } else if (event.type === 'display.status') {
        applyStatus(payload as Status)
      } else if (event.type === 'display.install.log') {
        setLog(lines => [...lines.slice(-199), String(payload.line || '')])
      } else if (event.type === 'display.install.done') {
        setInstallPhase(payload.code === 0 ? 'idle' : 'failed')

        if (payload.code !== 0) {
          setError(`The install exited with code ${payload.code}.`)
        }

        void refresh()
      }
    })

    return off
  }, [applyStatus, isDemo, refresh])

  const detach = useCallback(
    (handBack = false) => {
      generation.current += 1

      if (handBack) {
        socket.current?.close(1000)
      }

      try {
        rfb.current?.disconnect()
      } catch {}

      rfb.current = null
      socket.current?.close()
      socket.current = null
      pasteOff.current?.()
      pasteOff.current = null
      host.replaceChildren()
    },
    [host]
  )

  const attach = useCallback(
    async (auto = false) => {
      const target = stage.current
      // The bot's own machine (hosts.ts): an added machine's Computer streams from that Hermes.
      const base = endpointOf(bot.name, $active.get())?.baseUrl

      if (!target || !base || $computerDemo.get()) {
        return
      }

      if (!auto) {
        rapid.current = 0
      }

      detach()
      const mine = generation.current
      setConn('attaching')
      setError('')

      try {
        const observe = await call<Observe>('display.observe', viewerRef.current ? { viewer_id: viewerRef.current.id } : {})

        if (mine !== generation.current) {
          return
        }

        const minted = { id: observe.viewer_id, hash: await viewerHash(observe.viewer_id) }
        viewerRef.current = minted
        setViewer(minted)
        applyStatus(observe)

        const url = new URL(observe.path || '/api/display/ws', base.replace(/\/?$/, '/'))
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.searchParams.set('display_ticket', observe.ticket)

        if (mine !== generation.current || !stage.current) {
          return
        }

        dialedAt.current = Date.now()
        const ws = new WebSocket(url.toString())
        ws.binaryType = 'arraybuffer'
        socket.current = ws
        let closeCode = 0
        ws.addEventListener('close', e => {
          closeCode = e.code
        })

        const client = new RFB(stage.current, ws, { shared: true })
        // Scale the remote screen to fit its box, keeping the aspect ratio, in both the preview
        // and the large view. The remote resolution is left alone (resizeSession off): it is the
        // bot's screen, and its computer-use coordinates are in that resolution.
        client.scaleViewport = true
        client.clipViewport = false
        client.resizeSession = false
        client.focusOnClick = true
        client.background = 'transparent'
        client.qualityLevel = 7
        // Only the open view takes input, and only while this viewer holds the lease.
        const holds = observe.lease?.holder === 'human' && Boolean(observe.lease.viewer_hash) && observe.lease.viewer_hash === minted.hash
        client.viewOnly = !(openRef.current && holds)
        client.addEventListener('connect', () => {
          if (mine === generation.current) {
            setConn('live')
            setEvicted(false)
            const canvas = stage.current?.querySelector('canvas')

            if (canvas?.width && canvas.height) {
              setRatio(canvas.width / canvas.height)
            }

            if (openRef.current && !client.viewOnly) {
              client.focus({ preventScroll: true })
            }
          }
        })
        client.addEventListener('disconnect', (event: any) => {
          if (rfb.current === client) {
            rfb.current = null
          }

          if (mine !== generation.current) {
            return
          }

          const reason = String(event?.detail?.reason || '')

          if (closeCode === CLOSE_CONTROL_TAKEN || reason.includes('control-taken')) {
            rapid.current = Date.now() - dialedAt.current < EVICTION_WINDOW_MS ? rapid.current + 1 : 1

            if (rapid.current > MAX_RAPID_EVICTIONS) {
              setEvicted(false)
              setConn('error')
              setError('Someone else took control of this screen.')
            } else {
              setEvicted(true)
              setConn('idle')
            }
          } else if (event?.detail?.clean) {
            setConn('idle')
          } else {
            setConn('error')
            setError(reason || 'The screen stream was lost.')
          }

          void refresh()
        })
        rfb.current = client

        const onPaste = (event: ClipboardEvent) => {
          if (client.viewOnly) {
            return
          }

          const text = event.clipboardData?.getData('text')

          if (text && text.length <= MAX_PASTE) {
            event.preventDefault()
            client.clipboardPasteFrom(text)
          }
        }

        const el = stage.current
        el.addEventListener('paste', onPaste)
        pasteOff.current = () => el.removeEventListener('paste', onPaste)
      } catch (err) {
        if (mine === generation.current) {
          setConn('error')
          setError(errText(err))
        }
      }
    },
    [applyStatus, call, detach, refresh]
  )

  const release = useCallback(() => {
    const mine = viewerRef.current

    if (!acquired.current || !mine) {
      return
    }

    acquired.current = false

    if ($computerDemo.get()) {
      setLease({ holder: 'agent' })

      return
    }

    void call<{ lease: Lease }>('display.lease.release', { viewer_id: mine.id })
      .then(result => setLease(result.lease))
      .catch(() => undefined)
  }, [call])

  // leaving the tab (or switching bot) closes the stream and hands control back
  useEffect(
    () => () => {
      release()
      detach(true)
    },
    [detach, release]
  )

  useEffect(() => {
    if (status?.running && conn === 'idle') {
      void attach(true)
    }
  }, [attach, conn, status?.running])

  const iHold = Boolean(lease?.holder === 'human' && lease.viewer_hash && viewer && lease.viewer_hash === viewer.hash)
  const humanOther = lease?.holder === 'human' && !iHold
  const control = open && iHold

  // Input goes to the remote desktop only while the large view is open and this viewer holds
  // the lease; the preview is always view-only.
  useEffect(() => {
    if (rfb.current) {
      rfb.current.viewOnly = !control

      if (control) {
        rfb.current.focus({ preventScroll: true })
      }
    }
  }, [control])

  // Paste from this computer into the bot's desktop while you're in control.
  //
  // noVNC's keyboard handler preventDefault()s every keydown on its canvas, so the browser never
  // fires a 'paste' event and the old paste listener never ran: Ctrl+V reached the remote as a bare
  // keystroke with the remote's own (empty or stale) clipboard. Instead, catch the paste chords
  // here (capture phase, before noVNC), read the local clipboard, hand it to Xvnc with
  // clipboardPasteFrom (Xvnc runs with -AcceptCutText and TigerVNC's default SetPrimary, so it
  // owns both CLIPBOARD and PRIMARY afterwards), then press a paste key on the remote:
  //  - Ctrl+V      → Shift+Insert, the X11 paste key that works in terminals (xfce4-terminal,
  //                  xterm: pastes PRIMARY) and in GTK/Qt apps and browsers (pastes CLIPBOARD) —
  //                  so plain Ctrl+V works in a terminal too. Ctrl is released around it.
  //  - Ctrl+Shift+V → forwarded as is (the terminal paste chord / paste-as-plain-text).
  //  - Shift+Insert → forwarded as is.
  // The remote → local direction isn't possible: Hermes starts Xvnc with -SendCutText=0 on purpose
  // (watchers must never receive the holder's clipboard).
  useEffect(() => {
    if (!control) {
      return undefined
    }

    let ctrlCode = 'ControlLeft'
    let swallowUp = ''

    const press = (client: any, keysym: number, code: string, down?: boolean) => client.sendKey(keysym, code, down)

    const onDown = (event: KeyboardEvent) => {
      if (event.key === 'Control') {
        ctrlCode = event.code === 'ControlRight' ? 'ControlRight' : 'ControlLeft'

        return
      }

      const isV = event.code === 'KeyV' || event.key === 'v' || event.key === 'V'
      const ctrlV = event.ctrlKey && !event.altKey && !event.metaKey && isV
      const shiftInsert = event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Insert'

      if (!ctrlV && !shiftInsert) {
        return
      }

      // Only when the remote screen has focus: Ctrl+V in an app field (the handoff banner's reason
      // box, the composer…) pastes locally as usual.
      if (!(document.activeElement instanceof Element) || !host.contains(document.activeElement)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (event.repeat) {
        return
      }

      swallowUp = event.code
      const chord = shiftInsert ? 'shift-insert' : event.shiftKey ? 'ctrl-shift-v' : 'ctrl-v'

      void readClipboardText().then(text => {
        const client = rfb.current

        if (!client || client.viewOnly) {
          return
        }

        if (!text) {
          toast('Nothing to paste: the clipboard has no text.')

          return
        }

        if (new TextEncoder().encode(text).length > MAX_PASTE_BYTES) {
          toast('That is too much text to paste into the bot\'s computer (256 KB at most).')

          return
        }

        client.clipboardPasteFrom(text)

        if (chord === 'ctrl-v') {
          const ctrl = ctrlCode === 'ControlRight' ? XK_CONTROL_R : XK_CONTROL_L
          press(client, ctrl, ctrlCode, false)
          press(client, XK_SHIFT_L, 'ShiftLeft', true)
          press(client, XK_INSERT, 'Insert')
          press(client, XK_SHIFT_L, 'ShiftLeft', false)
          // you're still holding Ctrl: put it back so the remote matches the keyboard
          press(client, ctrl, ctrlCode, true)
        } else if (chord === 'ctrl-shift-v') {
          press(client, XK_V, 'KeyV')
        } else {
          press(client, XK_INSERT, 'Insert')
        }
      })
    }

    // The matching keyup belongs to a keydown noVNC never saw; keep it away from noVNC too.
    const onUp = (event: KeyboardEvent) => {
      if (swallowUp && event.code === swallowUp) {
        swallowUp = ''
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)

    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
    }
  }, [control])

  // Lost the lease while open (someone else took it, or it was force-released): close the
  // large view instead of leaving a dead, view-only overlay.
  const held = useRef(false)
  useEffect(() => {
    if (open && iHold) {
      held.current = true
    } else if (open && held.current && !iHold) {
      held.current = false
      acquired.current = false
      setOpen(false)
      openRef.current = false
      toast(humanOther ? 'Someone else took control of the screen.' : `${bot.display} has the screen again.`)
    } else if (!open) {
      held.current = false
    }
  }, [bot.display, humanOther, iHold, open])

  const openView = async () => {
    setOpen(true)
    // Set the ref now, not on the next render: the checks below can run before React re-renders
    // (when the stream is already live there is no await before them). v1.1.2 read the stale
    // `false` here, returned early and never asked for the lease, so the view stayed view-only.
    openRef.current = true
    setError('')

    if ($computerDemo.get()) {
      acquired.current = true
      setLease({ holder: 'human', viewer_hash: viewerRef.current?.hash || 'demo' })

      return
    }

    if (!viewerRef.current || conn === 'idle' || conn === 'error') {
      await attach()
    }

    const mine = viewerRef.current

    if (!mine || !openRef.current) {
      return
    }

    // Same lease the old Take over button used: Hermes (and the bot) see the user in control.
    try {
      acquired.current = true
      const result = await call<{ lease: Lease }>('display.lease.acquire', { viewer_id: mine.id })

      if (result?.lease) {
        setLease(result.lease)
      }

      if (!openRef.current) {
        // closed while the request was in flight
        release()
      } else if (!result?.lease || result.lease.holder !== 'human' || !mine.hash || result.lease.viewer_hash !== mine.hash) {
        // Don't sit silently in a view-only screen: say why the mouse and keyboard don't work.
        setError(mine.hash ? "Control wasn't handed to you, so you're only watching. Minimize and open again to retry." : "This app can't confirm it has control (no secure hashing here), so you're only watching.")
      }
    } catch (err) {
      acquired.current = false
      setError(`Couldn't take control: ${errText(err)}`)
    }
  }

  // An Esc tap in the large view goes to the remote desktop as one keydown + keyup (noVNC's
  // sendKey with no `down` sends both). ScreenOverlay keeps Esc away from noVNC's own keyboard
  // handler and only calls this on a short tap, so autorepeat and a hold-to-close send nothing.
  // Without control (the lease isn't ours) there's nothing to type into, so a tap closes.
  const sendEsc = useCallback(() => {
    const client = rfb.current

    if (client && !client.viewOnly) {
      client.sendKey(XK_ESCAPE, 'Escape')
    } else if (!$computerDemo.get()) {
      setOpen(false)
      openRef.current = false
      release()
    }
  }, [release])

  const closeView = useCallback(() => {
    setOpen(false)
    openRef.current = false
    release()
  }, [release])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)

    try {
      await fn()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const start = () =>
    run(async () => {
      applyStatus(await call<Status>('display.start', {}, 180_000))
      setConn('idle')
    })

  const decideImage = (approve: boolean) =>
    run(async () => {
      applyStatus(await call<Status>('display.switchSandboxImage', { approve }))
    })

  const install = () =>
    run(async () => {
      setLog([])
      setInstallPhase('running')
      await call('display.install')
    }).then(() => undefined)

  // Sign-in handoff: a card asked to open this screen for the user. Start the computer if it's
  // off, then open the large view in control (same lease as Open).
  const handoff = useStore($handoff)
  const mineHandoff = handoff && handoff.bot === bot.name ? handoff : null

  const openAfterStart = useRef(false)

  useEffect(() => {
    if (openAfterStart.current && status?.running && !busy) {
      openAfterStart.current = false

      if (!openRef.current) {
        void openView()
      }

      return
    }

    if (!mineHandoff?.pending || !status || busy) {
      return
    }

    $handoff.set({ ...mineHandoff, pending: false })

    if (!status.running) {
      // One try; if it can't start (blocker, install, error) the panel shows why.
      if (!status.blocker && !status.image_switch && status.installed) {
        openAfterStart.current = true
        void start()
      }
    } else if (!openRef.current) {
      void openView()
    }
  })

  const [helpReason, setHelpReason] = useState<null | string>(null)
  const finish = (ok: boolean) => {
    if (!mineHandoff) {
      return
    }

    finishHandoff(bot.name, mineHandoff.card, ok, helpReason || '')
    setHelpReason(null)
    closeView()
  }

  const helpBanner = mineHandoff ? (
    <div className="handoff-banner">
      <Icon name="bell" size={14} />
      <span className="handoff-text">
        <b>{bot.display} needs you:</b> {mineHandoff.card.instruction}
        {mineHandoff.card.url ? <small>{mineHandoff.card.url}</small> : null}
      </span>
      {helpReason !== null ? (
        <>
          <input
            aria-label="Why not (optional)"
            autoFocus
            className="handoff-reason"
            onChange={e => setHelpReason(e.target.value)}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') finish(false)
            }}
            placeholder="Why not? (optional)"
            value={helpReason}
          />
          <button className="btn sm ghost" onClick={() => setHelpReason(null)} type="button">
            Back
          </button>
          <button className="btn sm danger" onClick={() => finish(false)} type="button">
            Send
          </button>
        </>
      ) : (
        <>
          <button className="btn sm ghost" onClick={() => setHelpReason('')} type="button">
            Can't do it
          </button>
          <button className="btn sm primary" onClick={() => finish(true)} type="button">
            <Icon name="check" size={13} /> {mineHandoff.card.doneLabel}
          </button>
        </>
      )}
    </div>
  ) : undefined

  const sudo = prompts.find(p => p.method === 'display.install.sudo')
  const where = (hostOf(bot.name) ? machineLabel(hostOf(bot.name)) : active?.label) || 'the Hermes machine'

  if (unavailable) {
    return (
      <div className="computer-card">
        <b>Computer isn't available here</b>
        <p>The Hermes on {where} is too old to have the bot desktop. Update Hermes on that machine and it will appear.</p>
      </div>
    )
  }

  if (!status) {
    return <div className="panel-empty">{error || 'Looking for the computer…'}</div>
  }

  if (!status.supported) {
    return (
      <div className="computer-card">
        <b>This machine can't host a computer</b>
        <p>The bot desktop needs a Linux Hermes host with a desktop session available. {where} doesn't support it.</p>
      </div>
    )
  }

  if (!status.installed) {
    return (
      <div className="computer-card">
        <b>Give {bot.display} a computer</b>
        <p>
          A small private desktop (TigerVNC + Xfce) gets installed on {where}, so {bot.display} can open apps and browse — and you can watch, or open it and use it yourself.
          {status.missing?.length ? ` Missing: ${status.missing.join(', ')}.` : ''}
        </p>
        {status.install_command ? <pre className="computer-cmd">{status.install_command}</pre> : null}
        {sudo ? (
          <div className="computer-sudo">
            <small>The install needs the machine's sudo password.</small>
            <input
              autoFocus
              className="input"
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (sudo.resolve({ value: password }), setPassword(''))}
              placeholder="sudo password"
              type="password"
              value={password}
            />
            <div className="computer-actions">
              <button className="btn sm ghost" onClick={() => (sudo.reject(new Error('cancelled')), setPassword(''))} type="button">
                Cancel
              </button>
              <button className="btn sm primary" onClick={() => (sudo.resolve({ value: password }), setPassword(''))} type="button">
                Send
              </button>
            </div>
          </div>
        ) : (
          <button className="btn primary block" disabled={busy || installPhase === 'running'} onClick={() => void install()} type="button">
            {installPhase === 'running' ? <span className="spinner xs" /> : null}
            {installPhase === 'running' ? 'Installing…' : installPhase === 'failed' ? 'Try the install again' : 'Install'}
          </button>
        )}
        {log.length ? <pre className="computer-log">{log.join('\n')}</pre> : null}
        {error ? <div className="banner bad">{error}</div> : null}
      </div>
    )
  }

  if (!status.running && status.image_switch) {
    const sw = status.image_switch

    return (
      <div className="computer-card">
        <b>Switch the sandbox image?</b>
        <p>
          The sandbox is still on {sw.current_image}. The computer needs {sw.target_image}
          {sw.containers ? ` (${sw.containers} container${sw.containers === 1 ? '' : 's'} will be recreated on next use)` : ''}.
        </p>
        <div className="computer-actions">
          <button className="btn sm ghost" disabled={busy} onClick={() => void decideImage(false)} type="button">
            Keep current
          </button>
          <button className="btn sm primary" disabled={busy} onClick={() => void decideImage(true)} type="button">
            Switch
          </button>
        </div>
        {error ? <div className="banner bad">{error}</div> : null}
      </div>
    )
  }

  if (!status.running) {
    return (
      <div className="computer-card">
        <b>{bot.display}'s computer is off</b>
        <p>{status.blocker || 'Start it to watch the desktop live, or let the bot start it when it needs one.'}</p>
        <button className="btn primary block" disabled={busy || Boolean(status.blocker)} onClick={() => void start()} type="button">
          {busy ? <span className="spinner xs" /> : <Icon name="play" size={14} />} Start computer
        </button>
        {error ? <div className="banner bad">{error}</div> : null}
      </div>
    )
  }

  const dot: { tone: Dot; title: string } =
    conn === 'error'
      ? { tone: 'error', title: error || 'The screen stream was lost' }
      : conn !== 'live'
        ? { tone: 'connecting', title: 'Connecting to the screen…' }
        : control
          ? { tone: 'you', title: `You're using ${bot.display}'s computer. Close to hand it back.` }
          : humanOther
            ? { tone: 'other', title: 'Someone else is using this screen' }
            : { tone: 'live', title: `Live: ${bot.display}'s screen${status.geometry ? ` (${status.geometry})` : ''}` }

  const notes = (
    <>
      {conn === 'attaching' ? (
        <div className="computer-veil">
          <span className="spinner" /> Connecting to the screen…
        </div>
      ) : null}
      {evicted ? <div className="computer-note warn">Someone else took control — watching instead.</div> : null}
      {conn === 'error' && error ? (
        <div className="computer-note bad">
          {error}{' '}
          <button className="link-btn" onClick={() => void attach()} type="button">
            Reconnect
          </button>
        </div>
      ) : null}
    </>
  )

  return (
    <div className="computer" style={{ '--ar': String(ratio) } as React.CSSProperties}>
      <div className="computer-stage" data-demo-hover={demoView?.hover || undefined} data-open={open || undefined}>
        <div className="computer-slot" ref={previewSlot} />
        {/* noVNC stops click propagation on its canvas, so a transparent layer over the view-only
            preview catches clicks: anywhere on the preview opens it (the Open button is the
            keyboard / screen-reader way in). */}
        {open ? null : <div aria-hidden="true" className="computer-hit" onClick={() => !(conn === 'attaching' && !viewer) && void openView()} />}
        <div className="screen-bar">
          <StatusDot {...dot} />
          <span className="grow" />
          <button aria-label="Reconnect" className="icon-btn sm glass" disabled={conn === 'attaching'} onClick={() => void attach()} title="Reconnect" type="button">
            <Icon name="refresh" size={14} />
          </button>
        </div>
        {open ? (
          <div className="computer-veil">In the large view</div>
        ) : (
          <button className="computer-open" disabled={conn === 'attaching' && !viewer} onClick={() => void openView()} title={`Open ${bot.display}'s computer and use it yourself`} type="button">
            <Icon name="expand" size={14} /> Open
          </button>
        )}
        {open ? null : notes}
      </div>

      {lease?.holder === 'human' && lease.reason ? (
        <div className="computer-reason">
          <Icon name="bell" size={13} /> {lease.reason}
        </div>
      ) : null}
      {!open && conn !== 'error' && error ? <div className="banner bad">{error}</div> : null}

      {open ? (
        <ScreenOverlay banner={helpBanner} demoHold={demoView?.hold} dot={dot} label={`${bot.display}'s computer`} onClose={closeView} onEscTap={sendEsc} ratio={ratio}>
          <div className="computer-slot" ref={overlaySlot} />
          {notes}
          {error && conn !== 'error' ? <div className="computer-note bad">{error}</div> : null}
        </ScreenOverlay>
      ) : null}
    </div>
  )
}
