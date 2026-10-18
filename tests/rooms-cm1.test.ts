/**
 * coding manager 1 — two jobs scout assigned:
 *
 * 1. A "(pass)" must never leak into a rendered reply. A bot that says real things and then
 *    passes was shipping its message with a literal "(pass)" hanging off the end, because
 *    replyText() joined every assistant segment and the whole-text PASS filter saw the real
 *    content and let the whole string (pass included) through.
 *
 * 2. The five-minute TURN_IDLE_MS clock must pause while the app-to-Hermes link is down, and
 *    the answer must be recovered on reconnect — not a "stopped responding" interrupt or a
 *    "Lost the link" error.
 *
 * Only the transport is mocked; src/lib/rooms.ts and src/lib/chat.ts are the real modules, so the
 * reducer, the wake/turn scheduler and the reconnect handler under test are production code.
 */
import { afterEach, describe, expect, test } from 'bun:test'

// ── harness ────────────────────────────────────────────────────────────────
interface Call {
  method: string
  params: Record<string, any>
}

const calls: Call[] = []
let handlers: Record<string, (params: any) => any> = {}
let resumeCounter = 0
const lastResume = new Map<string, string>()

const of = (method: string) => calls.filter(call => call.method === method)
const last = (method: string) => [...calls].reverse().find(call => call.method === method)

/** The live runtime a member is on right now. A reconnect resumes a NEW session, so after one
 * the current runtime is the last resume's returned id, not the original prompt's. */
const runtimeOf = (member: string) => lastResume.get(member)

const { gateway } = await import('../src/lib/gateway')

gateway.request = (async (method: string, params: Record<string, any> = {}) => {
  calls.push({ method, params })

  if (handlers[method]) {
    return handlers[method](params)
  }

  // A real gateway issues a fresh runtime id per resume. Fresh ids keep one turn's session from
  // leaking into the next, and let a reconnect hand back a genuinely new session to attach to.
  if (method === 'session.resume') {
    const id = `rt${++resumeCounter}:${params.profile}`
    lastResume.set(params.profile, id)

    return { session_id: id, messages: handlers.__resumeMessages?.[params.profile] || [], running: false, inflight: null }
  }

  if (method === 'session.steer') {
    return { status: 'steered' }
  }

  // Reconnect refreshes the roster. An empty mock response removed Alpha,
  // so later tests never started a turn and could not exercise Stop.
  if (method === 'profiles.list') {
    return { profiles: store.$profiles.get() }
  }

  return {}
}) as typeof gateway.request

gateway.state.set('open')

// The app runs in an Electron renderer, so localStorage is always there; Bun has no such global.
const cache = new Map<string, string>()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => (cache.has(key) ? cache.get(key) : null),
    setItem: (key: string, value: string) => void cache.set(key, String(value)),
    removeItem: (key: string) => void cache.delete(key),
    clear: () => void cache.clear(),
    key: (index: number) => [...cache.keys()][index] ?? null,
    get length() {
      return cache.size
    }
  }
})

const hosts = await import('../src/lib/hosts')

hosts.$machines.set([])
hosts.$defaultHost.set('')

const store = await import('../src/lib/store')

store.$profiles.set([
  { name: 'default', is_default: true, ui_meta: {} },
  { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha', lead: true } } },
  { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
] as any)

store.$userName.set('You')

const rooms = await import('../src/lib/rooms')

// ── helpers ────────────────────────────────────────────────────────────────
const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise(done => setTimeout(done, 0))
  }
}

const wait = (ms: number) => new Promise(done => setTimeout(done, ms))

const emit = (runtime: string, frame: any) => gateway.dispatch({ session_id: runtime, ...frame } as any)

const log = (room: { key: string }) => (rooms.$rooms.get()[room.key]?.log || []).map(entry => entry.text)

let roomN = 0
const newRoom = (members: string[], settings?: any) => rooms.createRoom(`CM1 ${roomN++}`, members, settings)

afterEach(async () => {
  for (const room of Object.values(rooms.$rooms.get())) {
    await rooms.stopRoom(room.key)
    rooms.deleteRoom(room.key)
  }

  rooms.$rooms.set({})
  calls.length = 0
  cache.clear()
  handlers = {}
  resumeCounter = 0
  lastResume.clear()
  rooms.setTurnIdleMs(5 * 60_000)
  gateway.state.set('open')
})

// ── job 1: a "(pass)" never renders ────────────────────────────────────────
describe('a pass never leaks into a reply', () => {
  test('an assistant message that is only a pass is dropped, real segments kept', () => {
    const out = (rooms as any).replyText(
      [
        { role: 'assistant', text: 'both logs are on disk' },
        { role: 'assistant', text: '(pass)' }
      ],
      'Alpha'
    )

    expect(out).toBe('both logs are on disk')
    expect(out.toLowerCase()).not.toContain('pass')
  })

  test('a pass marker tucked onto the end of a longer reply is stripped', () => {
    const out = (rooms as any).replyText([{ role: 'assistant', text: 'both logs are on disk\n\n(pass)' }], 'Alpha')

    expect(out).toBe('both logs are on disk')
  })

  test('a reply that is only a pass renders nothing', () => {
    const out = (rooms as any).replyText([{ role: 'assistant', text: '[pass]' }], 'Alpha')

    expect(out).toBe('')
  })

  test('the room log entry a member publishes has no "(pass)" on it', async () => {
    const room = newRoom(['alpha'], { reply: 'everyone' })

    rooms.postToRoom(room.key, '@alpha check the logs')
    await flush()

    // Stream the real answer and a trailing pass marker in the same message.
    emit(runtimeOf('alpha')!, { type: 'message.start', payload: {} })
    emit(runtimeOf('alpha')!, { type: 'message.complete', payload: { text: 'both logs are on disk\n\n(pass)' } })
    await flush(20)

    const texts = log(room)

    expect(texts.some(text => text.includes('both logs are on disk'))).toBe(true)
    expect(texts.some(text => /pass/i.test(text))).toBe(false)
  })
})

// ── job 2: the idle clock pauses while the link is down, and the answer is
//     recovered on reconnect ────────────────────────────────────────────────
describe('a dropped link never interrupts a working turn', () => {
  test('with the link down past the idle window, no interrupt and no stopped message', async () => {
    rooms.setTurnIdleMs(60)
    const room = newRoom(['alpha'], { reply: 'everyone' })

    rooms.postToRoom(room.key, '@alpha do the thing')
    await flush()
    expect(runtimeOf('alpha')).toBeTruthy()

    // Link drops while alpha's turn is live.
    gateway.state.set('reconnecting')
    await wait(250)

    // The idle clock re-arms instead of firing: no interrupt, no "stopped responding" in the log.
    expect(of('session.interrupt').length).toBe(0)
    expect(log(room).some(text => /stopped responding/i.test(text))).toBe(false)
  })

  test('on reconnect the session is resumed and the answer still publishes', async () => {
    rooms.setTurnIdleMs(60)
    const room = newRoom(['alpha'], { reply: 'everyone' })

    rooms.postToRoom(room.key, '@alpha do the thing')
    await flush()
    const before = runtimeOf('alpha')!
    expect(before).toBeTruthy()

    // Link down, then back: the reconnect fires the recovery handler.
    gateway.state.set('reconnecting')
    await wait(80)
    gateway.emitReconnect()
    await flush(20)

    // The recovery handler resumed a fresh session for the room key, on top of the original.
    expect(of('session.resume').length).toBeGreaterThanOrEqual(2)
    const resumed = runtimeOf('alpha')!

    expect(resumed).toBeTruthy()
    expect(resumed).not.toBe(before)

    // Link restored, the turn can finish and publish on the new session — nothing was lost.
    gateway.state.set('open')
    emit(resumed, { type: 'message.complete', payload: { text: 'recovered: done' } })
    await flush(20)

    expect(log(room).some(text => text.includes('recovered: done'))).toBe(true)
    expect(log(room).some(text => /stopped responding|lost the link/i.test(text))).toBe(false)
    expect(of('session.interrupt').length).toBe(0)
  })
})

// ── job 3: stop/delete disposes the turn owner's idle timer and reconnect
//     handler, so a room nobody owns can't be revived on the next reconnect ──
describe('a stopped or deleted room never revives its turn on reconnect', () => {
  // The private Set the gateway keeps; the test can reach it through the instance.
  const listenerSize = () => (gateway as any).reconnectListeners.size

  test('stopRoom and deleteRoom dispose the turn owner without a terminal frame', async () => {
    // Pin the production 5-minute idle default so the owner stays live through stop/delete.
    // (Earlier suites override the module-global to 60ms and never restore it; without this the
    // owner settles on its own and the leak under test is masked.)
    rooms.setTurnIdleMs(5 * 60_000)
    const before = listenerSize()
    const room = newRoom(['alpha'], { reply: 'everyone' })

    rooms.postToRoom(room.key, '@alpha do the thing')
    await flush()
    emit(runtimeOf('alpha')!, { type: 'message.start', payload: {} })
    await flush()

    // No terminal frame ever arrives: stop, then delete, with the owner still mid-turn.
    await rooms.stopRoom(room.key)
    rooms.deleteRoom(room.key)

    expect(listenerSize()).toBe(before)
  })

  test('a stopped and deleted room resumes nothing and interrupts nothing on reconnect', async () => {
    rooms.setTurnIdleMs(5 * 60_000)
    const before = listenerSize()
    const room = newRoom(['alpha'], { reply: 'everyone' })

    rooms.postToRoom(room.key, '@alpha do the thing')
    await flush()
    emit(runtimeOf('alpha')!, { type: 'message.start', payload: {} })
    await flush()

    await rooms.stopRoom(room.key)
    rooms.deleteRoom(room.key)

    // The owner's reconnect handler is gone too, not just its timer and frame listener.
    expect(listenerSize()).toBe(before)

    calls.length = 0
    rooms.setTurnIdleMs(60)
    gateway.emitReconnect()
    await flush(20)
    await wait(120)

    expect(of('session.resume').length).toBe(0)
    expect(of('session.interrupt').length).toBe(0)
  })

  test('stopRoom sends exactly one interrupt, and the reconnect sends none more', async () => {
    rooms.setTurnIdleMs(5 * 60_000)
    const room = newRoom(['alpha'], { reply: 'everyone' })

    rooms.postToRoom(room.key, '@alpha do the thing')
    await flush()
    emit(runtimeOf('alpha')!, { type: 'message.start', payload: {} })
    await flush()

    calls.length = 0
    await rooms.stopRoom(room.key)
    expect(of('session.interrupt').length).toBe(1)

    rooms.deleteRoom(room.key)
    rooms.setTurnIdleMs(60)
    gateway.emitReconnect()
    await flush(20)
    await wait(120)

    expect(of('session.interrupt').length).toBe(1)
  })
})
