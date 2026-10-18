/**
 * A question a bot is waiting on (clarify/approval/secret) survives a reconnect or an app reload:
 * Hermes returns still-open requests as `open_requests` on `session.resume`, and the app must put
 * those cards back, answerable, exactly once. A card Hermes already withdrew while we were away is
 * removed instead of being left to answer into nothing.
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
const sent: any[] = []
;(gateway as any).ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) }
let open: any[] = []
gateway.request = (async (method: string, params: Record<string, any> = {}) => {
  if (method === 'session.resume') return { session_id: 'rt-alpha', messages: [], running: true, inflight: null, open_requests: open }
  if (method === 'session.create') return { session_id: 'stored-alpha' }
  return {}
}) as typeof gateway.request

const { native } = await import('../src/lib/native')
;(native as any).groupsEnsureIdentity = async () => ({ ready: true })
const store = await import('../src/lib/store')
store.$profiles.set([{ name: 'default', is_default: true, ui_meta: {} }, { name: 'alpha', ui_meta: {} }] as any)
const chat = await import('../src/lib/chat')

const clarify = (id: string) => ({ id, method: 'clarify', params: { session_id: 'rt-alpha', question: 'which branch?', choices: ['main', 'dev'] } })

afterEach(() => {
  chat.$prompts.set([])
  sent.length = 0
  open = []
})

test('a question still open after a reconnect is shown again and can be answered', async () => {
  open = [clarify('srq-aaa')]
  await chat.resumeSession('bot:alpha', 'alpha', {})
  const cards = chat.$prompts.get()
  expect(cards.map(p => [p.id, p.method, p.sessionId])).toEqual([['srq-aaa', 'clarify', 'rt-alpha']])
  cards[0].resolve({ answer: 'dev' })
  await new Promise(r => setTimeout(r, 0))
  expect(sent).toContainEqual({ jsonrpc: '2.0', id: 'srq-aaa', result: { answer: 'dev' } })
  expect(chat.$prompts.get()).toEqual([])
})

test('resuming twice does not duplicate the card', async () => {
  open = [clarify('srq-bbb')]
  await chat.resumeSession('bot:alpha', 'alpha', {})
  await chat.resumeSession('bot:alpha', 'alpha', {})
  expect(chat.$prompts.get().map(p => p.id)).toEqual(['srq-bbb'])
})

test('a card Hermes withdrew while the app was away is removed on resume', async () => {
  open = [clarify('srq-old')]
  await chat.resumeSession('bot:alpha', 'alpha', {})
  open = []
  await chat.resumeSession('bot:alpha', 'alpha', {})
  expect(chat.$prompts.get()).toEqual([])
})

test("another session's open card is left alone", async () => {
  open = [clarify('srq-mine')]
  await chat.resumeSession('bot:alpha', 'alpha', {})
  chat.$prompts.set([...chat.$prompts.get(), { id: 'srq-other', method: 'clarify', sessionId: 'rt-beta', params: {}, resolve() {}, reject() {}, rebind() {} }])
  open = []
  await chat.resumeSession('bot:alpha', 'alpha', {})
  expect(chat.$prompts.get().map(p => p.id)).toEqual(['srq-other'])
})
