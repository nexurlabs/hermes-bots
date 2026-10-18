/**
 * A teammate working outside this app (a message_agent / kanban CLI worker) shows as working only
 * while the backend proves a live lease for it, and stops the moment the lease is gone. "No claim"
 * from the backend never clears the app's own DM or group claims.
 */
import { afterEach, expect, test } from 'bun:test'

const cache = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => (cache.has(k) ? cache.get(k) : null),
  setItem: (k: string, v: string) => void cache.set(k, String(v)),
  removeItem: (k: string) => void cache.delete(k),
  clear: () => cache.clear(),
  key: (i: number) => [...cache.keys()][i] ?? null,
  get length() { return cache.size }
} })

const { gateway } = await import('../src/lib/gateway')
let activity: any = { activity: [] }
let fail = false
gateway.request = (async (method: string) => {
  if (method === 'profiles.activity') {
    if (fail) throw new Error('backend down')
    return activity
  }
  return {}
}) as typeof gateway.request

const store = await import('../src/lib/store')
const { refreshExternalActivity } = await import('../src/lib/activity')

afterEach(() => {
  store.releaseBusy('scout', 'dm')
  store.releaseBusy('scout', 'external')
  activity = { activity: [] }
  fail = false
})

test('a backend-proven worker lease marks the teammate working', async () => {
  activity = { activity: [{ name: 'scout', running: true, source: 'lease', owner_id: 'L1' }] }
  await refreshExternalActivity()
  expect(store.$busy.get().scout).toBe(true)
})

test('the claim ends when the lease is no longer reported', async () => {
  activity = { activity: [{ name: 'scout', running: true, source: 'lease', owner_id: 'L1' }] }
  await refreshExternalActivity()
  activity = { activity: [] }
  await refreshExternalActivity()
  expect(store.$busy.get().scout).toBeUndefined()
})

test("losing the external lease never clears the app's own DM claim", async () => {
  store.claimBusy('scout', 'dm')
  activity = { activity: [{ name: 'scout', running: true, source: 'lease', owner_id: 'L1' }] }
  await refreshExternalActivity()
  activity = { activity: [] }
  await refreshExternalActivity()
  expect(store.$busy.get().scout).toBe(true)
})

test('an unreachable backend is not evidence of idle: existing external claims stay as they are', async () => {
  activity = { activity: [{ name: 'scout', running: true, source: 'lease', owner_id: 'L1' }] }
  await refreshExternalActivity()
  fail = true
  await refreshExternalActivity()
  expect(store.$busy.get().scout).toBe(true)
})

test('a timestamp-only or non-lease entry is never treated as working', async () => {
  activity = { activity: [{ name: 'scout', running: true, source: 'last_active' }, { name: 'x', running: false, source: 'lease' }] }
  await refreshExternalActivity()
  expect(store.$busy.get().scout).toBeUndefined()
  expect(store.$busy.get().x).toBeUndefined()
})

test("after the app's own turn ends, a lease that is gone stops showing within moments, not at the next poll", async () => {
  const { startExternalActivity, stopExternalActivity, refreshExternalSoon } = await import('../src/lib/activity')
  activity = { activity: [{ name: 'scout', running: true, source: 'lease', owner_id: 'L1' }] }
  startExternalActivity(60_000)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(store.$busy.get().scout).toBe(true)

  activity = { activity: [] }
  refreshExternalSoon(10)
  await new Promise(resolve => setTimeout(resolve, 60))
  expect(store.$busy.get().scout).toBeUndefined()
  stopExternalActivity()
})

test('refreshExternalSoon does nothing while the app is not polling', async () => {
  const { refreshExternalSoon } = await import('../src/lib/activity')
  let asked = 0
  const before = gateway.request
  gateway.request = (async () => { asked++; return { activity: [] } }) as typeof gateway.request
  refreshExternalSoon(5)
  await new Promise(resolve => setTimeout(resolve, 30))
  gateway.request = before
  expect(asked).toBe(0)
})
