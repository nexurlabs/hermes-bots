import { afterEach, expect, test } from 'bun:test'
import { gateway } from '../src/lib/gateway'

const cache = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => cache.get(key) ?? null,
  setItem: (key: string, value: string) => cache.set(key, value),
  removeItem: (key: string) => cache.delete(key)
} })

let running = false
let lists = 0
const job = (over: Record<string, unknown> = {}) => ({ id: 'j1', name: 'Ping', enabled: true, state: 'scheduled', schedule_display: 'once', next_run_at: new Date(Date.now() + 60_000).toISOString(), ...over })
let jobs: any[] = [job()]
gateway.request = (async (method: string, params: any = {}) => {
  if (method === 'cron.manage' && params.action === 'list') {
    lists++
    return { success: true, jobs, gateway_running: running }
  }
  return {}
}) as typeof gateway.request

const r = await import('../src/lib/routines')

afterEach(() => {
  r.$routines.set({})
  r.setEnsureGatewayForTests(null)
  running = false
  lists = 0
  jobs = [job()]
})

test('a stopped scheduler with live routines is started (gateway ensure), and the note clears', async () => {
  let ensured = 0
  r.setEnsureGatewayForTests(async () => {
    ensured++
    running = true
    return { ok: true, state: 'running' }
  })
  await r.loadRoutines('alice', true)
  await new Promise(res => setTimeout(res, 10))
  expect(ensured).toBe(1)
  expect(r.$schedulerNote.get()).toBe('')
})

test('if it cannot be started the person gets plain copy, not the bot-directed warning', async () => {
  r.setEnsureGatewayForTests(async () => ({ ok: false, state: 'failed' }))
  await r.loadRoutines('alice', true)
  await new Promise(res => setTimeout(res, 10))
  expect(r.$schedulerNote.get()).toBe(r.SCHEDULER_DOWN_NOTE)
  expect(r.$schedulerNote.get()).not.toContain('Tell the user')
})

test('no routines that would fire: the scheduler is not started', async () => {
  let ensured = 0
  jobs = [job({ enabled: false, state: 'paused' })]
  r.setEnsureGatewayForTests(async () => {
    ensured++
    return { ok: true, state: 'running' }
  })
  await r.loadRoutines('alice', true)
  expect(ensured).toBe(0)
})

test('the keep-alive refreshes a card whose Next time has passed', () => {
  const past = Date.now() - 1000
  r.$routines.set({ alice: [{ id: 'j1', name: 'Ping', enabled: true, state: 'scheduled', nextRunAt: new Date(past).toISOString() } as any] })
  expect(r.routinesTick(Date.now())).toContain('alice')
})
