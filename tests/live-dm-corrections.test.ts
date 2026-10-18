import { afterEach, expect, test } from 'bun:test'
import { gateway } from '../src/lib/gateway'
import { $profiles } from '../src/lib/store'

const cache = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => cache.get(key) ?? null,
  setItem: (key: string, value: string) => cache.set(key, value),
  removeItem: (key: string) => cache.delete(key)
} })
$profiles.set([{ name: 'alpha', ui_meta: {} }] as any)
gateway.state.set('open')
const calls: { method: string; params: any }[] = []
let failure = false
let delivery = 'active_turn'
gateway.request = (async (method: string, params: any = {}) => {
  calls.push({ method, params })
  if (method === 'session.list') return { sessions: [{ id: 'stored-alpha', title: 'Bot Chat' }] }
  if (method === 'session.resume') return { session_id: 'rt-alpha', messages: [], running: false }
  if (method === 'session.steer' || method === 'session.steer_media') {
    if (failure) throw new Error('fixture steering transport failed')
    return { status: 'queued', delivery }
  }
  return {}
}) as typeof gateway.request
const { native } = await import('../src/lib/native')
;(native as any).groupsEnsureIdentity = async () => ({ ready: true })
const chat = await import('../src/lib/chat')
const image = () => ({ id: 'picture', kind: 'image' as const, name: 'correction.png', mime: 'image/png', size: 3,
  file: new File([new Uint8Array([1, 2, 3])], 'correction.png', { type: 'image/png' }) })
afterEach(() => {
  gateway.dispatch({ session_id: 'rt-alpha', type: 'message.complete', payload: { text: 'finished' } } as any)
  chat.$chats.set({})
  calls.length = 0
  failure = false
  delivery = 'active_turn'
})

test('a failed live text correction is reported, never submitted to the after-reply queue', async () => {
  await chat.sendToBot('alpha', 'start work')
  expect(chat.$chats.get().alpha.messages.filter(message => message.role === 'error')).toEqual([])
  expect(chat.$chats.get().alpha.running).toBe(true)
  calls.length = 0
  failure = true
  await chat.sendToBot('alpha', 'use the corrected requirement')
  expect(calls.some(call => call.method === 'prompt.submit')).toBe(false)
  expect(chat.$chats.get().alpha.messages.some(message => message.role === 'error' && /steering transport failed/.test(message.text))).toBe(true)
})

test('a live image correction sends image bytes to the addressed active session, not an attachment buffer', async () => {
  await chat.sendToBot('alpha', 'start work')
  expect(chat.$chats.get().alpha.messages.filter(message => message.role === 'error')).toEqual([])
  expect(chat.$chats.get().alpha.running).toBe(true)
  calls.length = 0
  await chat.sendToBot('alpha', 'inspect this correction', [image()])
  const sent = calls.find(call => call.method === 'session.steer_media')
  expect(sent?.params).toMatchObject({ session_id: 'rt-alpha', profile: 'alpha', text: 'inspect this correction', images: [{ filename: 'correction.png', content_base64: 'AQID' }] })
  expect(calls.some(call => call.method === 'prompt.submit' || /\.attach/.test(call.method))).toBe(false)
})

test('a compression-demoted correction is labelled deferred and not queued a second time', async () => {
  await chat.sendToBot('alpha', 'start work')
  expect(chat.$chats.get().alpha.messages.filter(message => message.role === 'error')).toEqual([])
  expect(chat.$chats.get().alpha.running).toBe(true)
  calls.length = 0
  delivery = 'next_turn'
  await chat.sendToBot('alpha', 'correction during compression')
  expect(calls.some(call => call.method === 'prompt.submit')).toBe(false)
  expect(chat.$chats.get().alpha.messages.some(message => message.role === 'error' && /next turn|deferred/i.test(message.text))).toBe(true)
})
