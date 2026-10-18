/**
 * JSON-RPC 2.0 over Hermes's /api/ws — the same dialect Hermes Desktop and
 * the TUI speak. One long-lived socket per backend: closing it reaps the
 * runtime sessions it created, so we reconnect instead of re-dialing per call.
 */
import { atom } from 'nanostores'

export interface GatewayEvent {
  type: string
  session_id?: string
  seq?: number
  payload?: any
}

type ServerRequestHandler = (method: string, params: any, id: string) => Promise<unknown>

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

export class RpcError extends Error {
  code: number
  data: unknown

  constructor(message: string, code = -1, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

export type GatewayState = 'closed' | 'connecting' | 'open' | 'reconnecting'

/** What the reconnect loop is doing right now — drives the "Reconnecting…" bar. */
export interface RetryStatus {
  attempt: number
  /** When the next try starts (epoch ms); 0 while a try is running. */
  nextAt: number
  trying: boolean
  /** Why the last try failed, in plain words. */
  error: string
}

/** Works out where Hermes is right now (re-opening the SSH tunnel if it died) and returns the socket URL. */
export type Resolver = () => Promise<string>

export class Gateway {
  state = atom<GatewayState>('closed')
  retrying = atom<null | RetryStatus>(null)
  private ws: null | WebSocket = null
  private url = ''
  private resolver: null | Resolver = null
  /** Bumped by every connect/close, so a loop or socket from an older connection can tell it is stale. */
  private gen = 0
  private loopGen = -1
  private attempts = 0
  private wake: null | (() => void) = null
  private nextId = 1
  private pending = new Map<string, Pending>()
  private listeners = new Set<(event: GatewayEvent) => void>()
  private reconnectListeners = new Set<() => void>()
  private serverRequestHandler: null | ServerRequestHandler = null
  private ping: null | ReturnType<typeof setInterval> = null
  private lastFrameAt = 0
  private lastSeq = 0

  onServerRequest(handler: ServerRequestHandler) {
    this.serverRequestHandler = handler
  }

  get serverHandler(): null | ServerRequestHandler {
    return this.serverRequestHandler
  }

  /**
   * Several Hermes machines (hosts.ts): the main gateway hands a request naming a bot on another
   * machine to that machine's gateway, with the names rewritten. Null = handle it here.
   */
  private router: null | ((method: string, params: Record<string, unknown>) => null | { gw: Gateway; params: Record<string, unknown>; done?: (result: any) => void }) = null

  setRouter(router: Gateway['router']) {
    this.router = router
  }

  /** Delivers an event from another machine's gateway to this one's listeners. */
  dispatch(event: GatewayEvent) {
    this.listeners.forEach(listener => {
      try {
        listener(event)
      } catch (error) {
        console.error(error)
      }
    })
  }

  on(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener)

    return () => this.reconnectListeners.delete(listener)
  }

  /**
   * Fires every reconnect listener, exactly as `open()` does when a re-dial lands. Production
   * calls it from `open(isReconnect)`; tests call it to drive the reconnect path without a socket.
   */
  emitReconnect() {
    this.reconnectListeners.forEach(listener => listener())
  }

  /** Called on every reconnect try to find the current address (the tunnel may have been rebuilt). */
  setResolver(resolver: null | Resolver) {
    this.resolver = resolver
  }

  async connect(url: string): Promise<void> {
    this.close()
    this.url = url
    this.attempts = 0
    this.state.set('connecting')
    const gen = this.gen

    try {
      await this.open(false, gen)
    } catch (error) {
      if (gen === this.gen) {
        this.state.set('closed')
      }

      throw error
    }
  }

  private open(isReconnect: boolean, gen: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let ws: WebSocket
      const timers: ReturnType<typeof setTimeout>[] = []
      const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms))
      const clear = () => timers.forEach(clearTimeout)

      try {
        ws = new WebSocket(this.url)
      } catch (error) {
        reject(error as Error)

        return
      }

      this.ws = ws

      const fail = (message: string) => {
        if (settled) {
          return
        }

        settled = true
        clear()

        if (this.ws === ws) {
          this.ws = null
        }

        try {
          ws.close()
        } catch {
          /* already closed */
        }

        reject(new Error(message))
      }

      const ready = () => {
        if (settled) {
          return
        }

        if (gen !== this.gen) {
          fail('Superseded')

          return
        }

        settled = true
        clear()
        this.attempts = 0
        this.retrying.set(null)
        this.state.set('open')
        void this.request('client.capabilities', { server_requests: true }, 10_000).catch(() => undefined)
        this.startPing()

        if (isReconnect) {
          this.reconnectListeners.forEach(listener => listener())
        }

        resolve()
      }

      // A tunnel that is up but whose far end is dead leaves the socket hanging in CONNECTING.
      later(() => fail('Timed out reaching Hermes'), 15_000)

      ws.onopen = () => {
        this.lastFrameAt = Date.now()
        later(ready, 2500)
      }

      ws.onmessage = message => {
        if (this.ws !== ws) {
          return
        }

        this.lastFrameAt = Date.now()
        let frame: any

        try {
          frame = JSON.parse(String(message.data))
        } catch {
          return
        }

        if (frame?.method === 'event' && frame.params?.type === 'gateway.ready') {
          ready()
        }

        this.handleFrame(frame)
      }

      ws.onerror = () => undefined

      ws.onclose = event => {
        if (!settled) {
          fail(event.code === 4401 || event.code === 1008 ? 'Hermes refused the token' : 'Could not reach Hermes')

          return
        }

        this.drop(ws, event.code)
      }
    })
  }

  /** The live socket is gone (or went quiet): fail what was waiting and start trying to get back. */
  private drop(ws: WebSocket, code: number) {
    if (this.ws !== ws) {
      return
    }

    this.ws = null
    this.stopPing()
    this.failAll(new RpcError(`Connection closed (${code})`))
    this.startReconnect()
  }

  private startReconnect() {
    if (this.loopGen === this.gen) {
      return
    }

    this.loopGen = this.gen
    this.state.set('reconnecting')
    void this.reconnectLoop(this.gen)
  }

  /** Never gives up: 0.6s, 1.5s, 3s, 6s, 12s, then every 15s, until it connects or the person logs out. */
  private async reconnectLoop(gen: number) {
    let error = ''

    while (gen === this.gen) {
      this.attempts += 1
      const delay = this.attempts === 1 ? 600 : Math.min(15_000, 1500 * 2 ** (this.attempts - 2))
      this.retrying.set({ attempt: this.attempts, nextAt: Date.now() + delay, trying: false, error })
      await this.pause(delay)

      if (gen !== this.gen) {
        return
      }

      this.retrying.set({ attempt: this.attempts, nextAt: 0, trying: true, error })

      try {
        if (this.resolver) {
          this.url = await this.resolver()
        }

        if (gen !== this.gen) {
          return
        }

        await this.open(true, gen)
        this.loopGen = -1

        return
      } catch (caught) {
        error = String((caught as Error)?.message || caught)
      }
    }
  }

  private pause(ms: number) {
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)

        if (this.wake === done) {
          this.wake = null
        }

        resolve()
      }

      const timer = setTimeout(done, ms)
      this.wake = done
    })
  }

  /** Skip the wait and try right now (no-op if a try is already running or the link is fine). */
  retryNow() {
    this.wake?.()
  }

  /** Cheap "are we really still connected?" check — after sleep or a network change a socket can look open but be dead. */
  async probe() {
    const ws = this.ws

    if (this.state.get() === 'reconnecting') {
      this.retryNow()

      return
    }

    if (this.state.get() !== 'open' || !ws || Date.now() - this.lastFrameAt < 20_000) {
      return
    }

    try {
      await this.request('gateway.ping', {}, 6_000)
    } catch {
      this.kill(ws, 'probe failed')
    }
  }

  /** Close a socket that stopped answering; some never deliver `close`, so force the drop too. */
  private kill(ws: WebSocket, reason: string) {
    try {
      ws.close(4000, reason)
    } catch {
      /* already closed */
    }

    setTimeout(() => this.drop(ws, 4000), 2500)
  }

  private handleFrame(frame: any) {
    if (!frame || typeof frame !== 'object') {
      return
    }

    if (frame.method === 'event') {
      const event = frame.params as GatewayEvent

      if (typeof event?.seq === 'number') {
        this.lastSeq = Math.max(this.lastSeq, event.seq)
      }

      this.dispatch(event)

      return
    }

    if (typeof frame.method === 'string' && frame.id !== undefined && frame.id !== null) {
      void this.answerServerRequest(String(frame.id), frame.method, frame.params || {})

      return
    }

    if (frame.id !== undefined) {
      const entry = this.pending.get(String(frame.id))

      if (!entry) {
        return
      }

      this.pending.delete(String(frame.id))
      clearTimeout(entry.timer)

      if (frame.error) {
        entry.reject(new RpcError(String(frame.error.message || 'Request failed'), frame.error.code, frame.error.data))
      } else {
        entry.resolve(frame.result)
      }
    }
  }

  private async answerServerRequest(id: string, method: string, params: any) {
    // Bound to the socket that is live NOW: a card answered after a reconnect must reply on the
    // new connection, not the one it first arrived on.
    const send = (body: Record<string, unknown>) => this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, ...body }))

    if (!this.serverRequestHandler) {
      send({ error: { code: -32601, message: `no handler for ${method}` } })

      return
    }

    try {
      const result = await this.serverRequestHandler(method, params, id)
      send({ result })
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32000
      send({ error: { code, message: (error as Error).message || 'declined' } })
    }
  }

  /**
   * A question Hermes is still waiting on, re-delivered after a reconnect (`open_requests` from
   * `session.resume`). Handled exactly like the original frame; the handler dedupes by id.
   */
  redeliverServerRequest(id: string, method: string, params: any) {
    void this.answerServerRequest(id, method, params || {})
  }

  request<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const routed = this.router?.(method, params)

    if (routed) {
      const sent = routed.gw === this ? this.direct<T>(method, routed.params, timeoutMs) : routed.gw.request<T>(method, routed.params, timeoutMs)

      return routed.done ? sent.then(result => (routed.done!(result), result)) : sent
    }

    return this.direct<T>(method, params, timeoutMs)
  }

  private direct<T = any>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const ws = this.ws

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new RpcError(this.state.get() === 'reconnecting' ? 'Hermes is reconnecting — try again in a moment' : 'Not connected to Hermes')
      )
    }

    const id = `b${this.nextId++}`

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError(`${method} timed out`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer, method })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private failAll(error: Error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  private startPing() {
    this.stopPing()
    this.ping = setInterval(() => {
      if (Date.now() - this.lastFrameAt > 45_000) {
        if (this.ws) {
          this.kill(this.ws, 'heartbeat timeout')
        }

        return
      }

      void this.request('gateway.ping', {}, 15_000).catch(() => undefined)
    }, 15_000)
  }

  private stopPing() {
    if (this.ping) {
      clearInterval(this.ping)
      this.ping = null
    }
  }

  get seq() {
    return this.lastSeq
  }

  /**
   * This socket's generation: bumped by every `connect()`/`close()`, and identical while the same
   * socket is alive however many events flow over it. That is what "is this the same link as when I
   * proved this?" has to be keyed on — `seq` is the event high-water mark and moves constantly.
   */
  get connectionGen() {
    return this.gen
  }

  close() {
    this.gen += 1
    this.loopGen = -1
    this.stopPing()
    const ws = this.ws
    this.ws = null
    this.failAll(new RpcError('Connection closed'))
    this.wake?.()
    this.retrying.set(null)
    this.state.set('closed')

    try {
      ws?.close(1000, 'bye')
    } catch {
      /* already closed */
    }
  }
}

export const gateway = new Gateway()
