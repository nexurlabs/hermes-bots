/**
 * The status record as the app actually writes it: a real room turn and a real 1:1 turn, driven
 * through the same entry points the app uses. The gateway module runs untouched and only its
 * transport method is replaced, so rooms.ts and chat.ts are the real modules — which is the point:
 * these fail when the record is removed from the claim and release sites, and the store's own unit
 * tests would not notice.
 */
import { afterEach, describe, expect, test } from 'bun:test'

interface Call {
  method: string
  params: Record<string, any>
}

const calls: Call[] = []
let handlers: Record<string, (params: any) => any> = {}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    get length() {
      return 0
    }
  }
})

let epoch = 0

const { gateway } = await import('../src/lib/gateway')
const { native } = await import('../src/lib/native')
const identity = await import('../src/lib/bot-identity')

// The store reads the link state as it loads, so the gateway has to be open before anything else.
gateway.state.set('open')

// This suite is about turn status, not identity. A bridge exists here, so the gate is given its
// answer; the gate's own refusal behaviour is covered in bot-identity-gate.
native.groupsEnsureIdentity = async () => ({ ready: true })
identity.forgetBotIdentity()

gateway.request = (async (method: string, params: Record<string, any> = {}) => {
  calls.push({ method, params })

  if (handlers[method]) {
    return handlers[method](params)
  }

  // A fresh runtime id per resume is what production does, and it keeps one test's session from
  // leaking into the next.
  if (method === 'session.resume') {
    return { session_id: `rt${++epoch}:${params.profile}`, messages: [], running: false, inflight: null }
  }

  return {}
}) as typeof gateway.request

const emit = (session: string, frame: any) => gateway.dispatch({ session_id: session, ...frame } as any)

const store = await import('../src/lib/store')
const rooms = await import('../src/lib/rooms')
const chat = await import('../src/lib/chat')
const { liveLine } = await import('../src/lib/team')

// A bot on a machine that looks offline sits a room turn out before claiming it, so the harness says
// these bots are local — same as rooms-wake does.
const hosts = await import('../src/lib/hosts')

hosts.$machines.set([])
hosts.$defaultHost.set('')

store.$profiles.set([
  { name: 'default', is_default: true, ui_meta: {} },
  { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha', lead: true } } },
  { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } },
  { name: 'gamma', ui_meta: { 'hermes-bots': { title: 'Gamma' } } }
] as any)
store.$userName.set('You')

const flush = async (r = 12) => {
  for (let i = 0; i < r; i++) await new Promise(d => setTimeout(d, 0))
}

const statusOf = (bot: string) => store.$turnStatus.get()[bot]

let roomN = 0
const newRoom = (members: string[]) => rooms.createRoom(`Status ${roomN++}`, members, { reply: 'everyone' })

const runtimeOf = (profile: string) => {
  const submitted_for = [...calls].reverse().find(call => call.method === 'prompt.submit' && call.params.profile === profile)

  return String(submitted_for?.params.session_id || '')
}

afterEach(async () => {
  for (const room of Object.values(rooms.$rooms.get())) {
    await rooms.stopRoom(room.key)
    rooms.deleteRoom(room.key)
  }
  rooms.$rooms.set({})
  rooms.$roomTyping.set({})
  store.$turnStatus.set({})
  calls.length = 0
  handlers = {}
  // chat.ts keeps a module-level session cache for the life of the module, so one test's 1:1 session
  // would otherwise be reused by the next and end on a runtime the new test never submits to. The
  // real reconnect path is what clears it in the app.
  gateway.dispatch({ type: 'gateway.reconnect' } as any)
  await flush()
})

describe('the status of a room turn', () => {
  test('is recorded when the group turn is claimed', async () => {
    const room = newRoom(['alpha'])
    rooms.postToRoom(room.key, 'rebase the scheduler onto `cm2/status-line` please')

    await flush()

    expect(statusOf('alpha')?.ask).toContain('rebase the scheduler')
  })

  test('carries the branch the ask named', async () => {
    const room = newRoom(['alpha'])
    rooms.postToRoom(room.key, 'work on branch cm2/status-line')

    await flush()

    expect(statusOf('alpha')?.branch).toBe('cm2/status-line')
  })

  test('says whether that branch is on origin', async () => {
    const room = newRoom(['alpha'])
    rooms.postToRoom(room.key, 'work on branch cm2/status-line')

    await flush()

    expect(['yes', 'no', 'unknown']).toContain(statusOf('alpha')?.onOrigin)
  })

  test('is cleared when that group turn ends', async () => {
    const room = newRoom(['alpha'])
    rooms.postToRoom(room.key, 'rebase the scheduler')
    await flush()

    expect(statusOf('alpha')).toBeDefined()

    emit(runtimeOf('alpha'), { type: 'message.complete', payload: { text: 'done' } })
    await flush(20)

    expect(statusOf('alpha')).toBeUndefined()
  })
})

describe('the status of a 1:1 turn', () => {
  test('is recorded when the dm turn is claimed', async () => {
    await chat.sendToBot('beta', 'fix the parser on `cm2/status-line`', [])

    await flush()

    expect(statusOf('beta')?.ask).toContain('fix the parser')
    expect(statusOf('beta')?.branch).toBe('cm2/status-line')
  })

  test('is cleared when that dm turn ends', async () => {
    // A different member from the test above: chat.ts caches one session per member for the life of the
    // module, so reusing one would end this turn on the runtime the earlier test already closed.
    await chat.sendToBot('gamma', 'fix the other parser', [])

    await flush()

    expect(statusOf('gamma')).toBeDefined()

    emit(runtimeOf('gamma'), { type: 'message.complete', payload: { text: 'done' } })
    await flush(20)

    expect(statusOf('gamma')).toBeUndefined()
  })
})

describe('the status the team line reads', () => {
  test('shows the ask, the branch and whether it is on origin while a room turn runs', async () => {
    const room = newRoom(['alpha'])
    rooms.postToRoom(room.key, 'work on branch cm2/status-line')
    await flush()

    expect(statusOf('alpha')).toBeDefined()

    const line = liveLine({
      me: 'beta',
      bots: [
        { name: 'beta', display: 'Beta', meta: {} },
        { name: 'alpha', display: 'Alpha', meta: {} }
      ],
      rooms: [],
      busy: { alpha: true },
      status: store.$turnStatus.get(),
      online: true,
      machine: 'studio',
      user: 'You',
      facts: [],
      canRemember: true,
      memoryEdits: []
    } as any)

    expect(line).toContain('Busy right now')
    expect(line).toContain('Alpha')
    expect(line).toContain('work on branch cm2/status-line')
    expect(line).toMatch(/on origin|not on origin|unknown/i)
  })
})