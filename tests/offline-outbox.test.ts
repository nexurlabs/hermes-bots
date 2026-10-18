import { afterEach, expect, test } from 'bun:test'
import { gateway } from '../src/lib/gateway'
import { $profiles } from '../src/lib/store'

const cache = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => cache.get(key) ?? null,
  setItem: (key: string, value: string) => cache.set(key, value),
  removeItem: (key: string) => cache.delete(key)
} })
$profiles.set([{ name: 'alpha', ui_meta: {} }, { name: 'beta', ui_meta: {} }] as any)
const calls: { method: string; params: any }[] = []
let transcript: any[] = []
gateway.request = (async (method: string, params: any = {}) => {
  // The real client refuses before anything leaves the machine while the socket is down.
  if (gateway.state.get() !== 'open') throw new Error('Hermes is reconnecting — try again in a moment')
  calls.push({ method, params })
  if (method === 'session.list') return { sessions: [{ id: `stored-${params.profile}`, title: 'Bot Chat' }] }
  if (method === 'session.resume') return { session_id: `rt-${params.profile}`, messages: transcript, running: false }
  return {}
}) as typeof gateway.request
const { native } = await import('../src/lib/native')
;(native as any).groupsEnsureIdentity = async () => ({ ready: true })
const chat = await import('../src/lib/chat')
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

afterEach(async () => {
  chat.$outbox.set({})
  gateway.state.set('open')
  for (const name of ['alpha', 'beta']) gateway.dispatch({ session_id: `rt-${name}`, type: 'message.complete', payload: { text: 'done' } } as any)
  await settle()
  chat.$chats.set({})
  calls.length = 0
  transcript = []
  cache.clear()
})

test('a message typed while disconnected waits visibly instead of failing', async () => {
  gateway.state.set('reconnecting')
  await chat.sendToBot('alpha', 'hello while offline')
  expect(calls.some(call => call.method === 'prompt.submit')).toBe(false)
  expect(chat.$chats.get().alpha?.messages.some(msg => msg.role === 'error') ?? false).toBe(false)
  expect(chat.$outbox.get().alpha.map(item => item.text)).toEqual(['hello while offline'])
})

test('waiting messages go out in order once the connection is back, exactly once', async () => {
  gateway.state.set('reconnecting')
  await chat.sendToBot('alpha', 'first')
  await chat.sendToBot('alpha', 'second')
  gateway.state.set('open')
  await settle()
  const sent = calls.filter(call => call.method === 'prompt.submit').map(call => call.params.text)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('first')
  // The second waits for the first turn instead of being steered into it or dropped.
  gateway.dispatch({ session_id: 'rt-alpha', type: 'message.complete', payload: { text: 'ok' } } as any)
  await settle()
  const after = calls.filter(call => call.method === 'prompt.submit').map(call => call.params.text)
  expect(after.length).toBe(2)
  expect(after[1]).toContain('second')
  expect(chat.$outbox.get().alpha ?? []).toEqual([])
})

test('a connection that drops again before flushing keeps the message waiting', async () => {
  gateway.state.set('reconnecting')
  await chat.sendToBot('beta', 'still here')
  gateway.state.set('open')
  gateway.state.set('reconnecting')
  await settle()
  expect(chat.$outbox.get().beta.map(item => item.text)).toEqual(['still here'])
})

test('a chat that has not loaded its history yet shows nothing saved on this device', () => {
  // Cards and approvals are device-local; drawn before history arrives they flash an old screen.
  expect(chat.chatShowsHistory(undefined)).toBe(false)
  expect(chat.chatShowsHistory({ messages: [], loading: true, running: false })).toBe(false)
  expect(chat.chatShowsHistory({ messages: [], loading: false, running: false })).toBe(true)
  // A reconnect refresh keeps what is already on screen.
  expect(chat.chatShowsHistory({ messages: [{ id: 'm', role: 'user', text: 'hi', at: 1 }], loading: true, running: false })).toBe(true)
})

test('a waiting message shows in the chat marked as waiting', async () => {
  gateway.state.set('reconnecting')
  await chat.sendToBot('alpha', 'visible please')
  const shown = chat.outboxMessages('alpha')
  expect(shown.map(msg => [msg.role, msg.text, msg.waiting])).toEqual([['user', 'visible please', true]])
})
