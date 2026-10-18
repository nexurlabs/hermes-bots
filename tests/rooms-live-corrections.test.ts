/**
 * A directly addressed correction to a member that is already working in a group goes into that
 * member's running turn: text by session.steer, pictures by session.steer_media as real bytes.
 * A failed steer is shown in the room, never silently dropped.
 */
import { afterEach, expect, test } from 'bun:test'

const calls: { method: string; params: Record<string, any> }[] = []
let steerFails = false
let resumeN = 0
const lastResume = new Map<string, string>()

const { gateway } = await import('../src/lib/gateway')
const cache = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => (cache.has(k) ? cache.get(k) : null),
  setItem: (k: string, v: string) => void cache.set(k, String(v)),
  removeItem: (k: string) => void cache.delete(k),
  clear: () => cache.clear(),
  key: (i: number) => [...cache.keys()][i] ?? null,
  get length() { return cache.size }
} })
const hosts = await import('../src/lib/hosts')
hosts.$machines.set([])
hosts.$defaultHost.set('')
const store = await import('../src/lib/store')
store.$profiles.set([
  { name: 'default', is_default: true, ui_meta: {} },
  { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha', lead: true } } }
] as any)
store.$userName.set('You')

gateway.request = (async (method: string, params: Record<string, any> = {}) => {
  calls.push({ method, params })
  if (method === 'session.resume') {
    const id = `rt${++resumeN}:${params.profile}`
    lastResume.set(params.profile, id)
    return { session_id: id, messages: [], running: false, inflight: null }
  }
  if (method === 'profiles.list') return { profiles: store.$profiles.get() }
  if (method === 'session.steer' || method === 'session.steer_media') {
    if (steerFails) throw new Error('fixture steer transport down')
    return { status: 'queued', delivery: 'active_turn' }
  }
  return {}
}) as typeof gateway.request
gateway.state.set('open')

const rooms = await import('../src/lib/rooms')
const flush = async (n = 15) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const log = (key: string) => (rooms.$rooms.get()[key]?.log || []).map(e => e.text)
const png = () => ({ id: 'p1', kind: 'image' as const, name: 'fix.png', mime: 'image/png', size: 3,
  file: new File([new Uint8Array([1, 2, 3])], 'fix.png', { type: 'image/png' }) })

afterEach(async () => {
  for (const room of Object.values(rooms.$rooms.get())) {
    await rooms.stopRoom(room.key)
    await rooms.deleteRoom(room.key)
  }
  rooms.$rooms.set({})
  calls.length = 0
  steerFails = false
})

async function busyAlpha() {
  const room = rooms.createRoom(`live ${Math.random()}`, ['alpha'], { reply: 'everyone' })
  rooms.postToRoom(room.key, '@alpha start the job')
  await flush()
  gateway.dispatch({ session_id: lastResume.get('alpha'), type: 'message.start', payload: {} } as any)
  await flush()
  calls.length = 0
  return room
}

test('an @mention with a picture steers the image bytes into the working member', async () => {
  const room = await busyAlpha()
  rooms.postToRoom(room.key, '@alpha use this screenshot', [png()] as any)
  await flush(30)
  const sent = calls.find(c => c.method === 'session.steer_media')
  expect(sent?.params).toMatchObject({ profile: 'alpha', images: [{ filename: 'fix.png', content_base64: 'AQID' }] })
  expect(calls.some(c => c.method === 'prompt.submit')).toBe(false)
})

test('a failed steer to a working member is shown in the room', async () => {
  const room = await busyAlpha()
  steerFails = true
  rooms.postToRoom(room.key, '@alpha switch to plan b')
  await flush(30)
  expect(log(room.key).some(t => /not delivered/i.test(t) && /steer transport down/.test(t))).toBe(true)
})
