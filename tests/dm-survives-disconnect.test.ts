import { afterEach, expect, test } from 'bun:test'
import { gateway } from '../src/lib/gateway'
import { $profiles } from '../src/lib/store'

// A 1:1 DM turn must survive the app going away: the VM keeps working, so when the
// socket comes back the answer has to be pulled across rather than lost. The group
// path already proves this shape in rooms.ts; this pins the DM path to the same rule.

const cache = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key)
  }
})

$profiles.set([{ name: 'alpha', ui_meta: {} }] as any)

const calls: { method: string; params: any }[] = []
let transcript: any[] = []
let stillRunning = false

gateway.request = (async (method: string, params: any = {}) => {
  if (gateway.state.get() !== 'open') throw new Error('Hermes is reconnecting — try again in a moment')
  calls.push({ method, params })
  if (method === 'session.list') return { sessions: [{ id: `stored-${params.profile}`, title: 'Bot Chat' }] }
  if (method === 'session.resume')
    return {
      session_id: `rt-${params.profile}`,
      messages: transcript,
      running: stillRunning,
      ...(stillRunning ? { inflight: { assistant: 'half a thought' } } : {})
    }

  return {}
}) as typeof gateway.request

const { native } = await import('../src/lib/native')
;(native as any).groupsEnsureIdentity = async () => ({ ready: true })
const chat = await import('../src/lib/chat')
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

afterEach(async () => {
  chat.$outbox.set({})
  gateway.state.set('open')
  stillRunning = false
  chat.$chats.set({})
  calls.length = 0
  transcript = []
  cache.clear()
})

test('a DM turn that finishes while the socket is down still shows up after reconnect', async () => {
  await chat.sendToBot('alpha', 'do the thing')
  await settle()

  // The app is closing: the socket goes away mid-turn.
  gateway.state.set('reconnecting')

  // The VM kept working and finished the turn while we could not hear it.
  transcript = [
    { role: 'user', text: 'do the thing' },
    { role: 'assistant', text: 'finished on the VM' }
  ]
  stillRunning = false

  // The app comes back and reconnects.
  gateway.state.set('open')
  await chat.loadBotChat('alpha', true)
  await settle()

  const shown = chat.$chats.get().alpha?.messages ?? []
  expect(shown.some(msg => msg.text?.includes('finished on the VM'))).toBe(true)
})

test('a DM turn still running on the VM comes back marked as running, not as idle', async () => {
  await chat.sendToBot('alpha', 'long job')
  await settle()

  gateway.state.set('reconnecting')

  // Reconnect while the VM is still mid-turn.
  transcript = [{ role: 'user', text: 'long job' }]
  stillRunning = true

  gateway.state.set('open')
  await chat.loadBotChat('alpha', true)
  await settle()

  expect(chat.$chats.get().alpha?.running).toBe(true)
})