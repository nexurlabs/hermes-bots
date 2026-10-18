import { afterEach, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Approval, Bot, ChatMsg } from '../src/lib/types'

const window = new Window({ url: 'http://localhost' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : (window as any)[key] })
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).CSS ??= (window as any).CSS ?? { escape: (value: string) => value }
const { createRoot } = await import('react-dom/client')
const { Thread } = await import('../src/ui/thread')
const { $jumpTo } = await import('../src/lib/search')
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
const bot = { name: 'scout', display: 'Scout', handle: 'scout', row: { name: 'scout' }, meta: {}, lead: false, preview: '', lastActive: 0 } as Bot

const chat = (count: number): ChatMsg[] =>
  Array.from({ length: count }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `message ${i}`, at: 1_000 + i, from: i % 2 ? 'scout' : undefined }) as ChatMsg)
const approval = (id: string, at: number, status: Approval['status']) =>
  ({ id, requestId: id, sessionId: 'rt', bot: 'scout', scope: 'bot:scout', kind: 'command', command: `cmd ${id}`, description: '', choices: ['once', 'deny'], status, at }) as Approval

async function mount(messages: ChatMsg[], approvals: Approval[] = [], scope = 'bot:scout') {
  if (!host) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => root!.render(createElement(Thread, { messages, approvals, botFor: () => bot, scope })))
}
const drawn = () => host.querySelectorAll('.thread .msg').length
const more = () => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Show earlier messages')

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined as any
  $jumpTo.set(null)
})

test('a short chat is drawn whole, with no "Show earlier messages"', async () => {
  await mount(chat(40))
  expect(drawn()).toBe(40)
  expect(more()).toBeUndefined()
})

test('a long chat draws its latest messages, and "Show earlier messages" adds more', async () => {
  await mount(chat(400))
  expect(drawn()).toBe(150)
  expect(host.textContent).toContain('message 399')
  expect(host.textContent).not.toContain('message 249')

  await act(async () => more()!.click())
  expect(drawn()).toBe(300)
  await act(async () => more()!.click())
  expect(drawn()).toBe(400)
  expect(more()).toBeUndefined()
})

test('switching to another chat starts again from its latest messages', async () => {
  await mount(chat(400))
  await act(async () => more()!.click())
  expect(drawn()).toBe(300)

  await mount(chat(400), [], 'bot:other')
  expect(drawn()).toBe(150)
})

test('an open approval older than the drawn messages still shows; an answered one stays out', async () => {
  await mount(chat(400), [approval('old-open', 1_010, 'pending'), approval('old-done', 1_011, 'once')])
  expect(host.textContent).toContain('cmd old-open')
  expect(host.textContent).not.toContain('cmd old-done')
})

const msgTexts = () => [...host.querySelectorAll('.thread .msg')].map(e => e.textContent?.trim())
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)

test('a search result far back draws the messages around it, not everything after it', async () => {
  $jumpTo.set({ scope: 'bot:scout', id: 'm20', at: 1_020 })
  await mount(chat(400))
  expect($jumpTo.get()).toBeNull()
  expect(host.textContent).toContain('message 20')
  expect(drawn()).toBe(150)
  expect(msgTexts()[0]).toBe('message 10')
  expect(host.textContent).not.toContain('message 399')
  expect(button('Show newer messages')).toBeDefined()
  expect(button('Jump to latest')).toBeDefined()
})

test('"Show newer messages" draws further, and reaching the end is back to the latest', async () => {
  $jumpTo.set({ scope: 'bot:scout', id: 'm20', at: 1_020 })
  await mount(chat(400))

  await act(async () => button('Show newer messages')!.click())
  expect(drawn()).toBe(300)
  await act(async () => button('Show newer messages')!.click())
  expect(host.textContent).toContain('message 399')
  expect(button('Show newer messages')).toBeUndefined()

  // Back at the latest, new messages show up as they come.
  await mount([...chat(400), { id: 'new', role: 'assistant', text: 'brand new', at: 9_999, from: 'scout' } as ChatMsg])
  expect(host.textContent).toContain('brand new')
})

test('"Jump to latest" goes back to the newest messages', async () => {
  $jumpTo.set({ scope: 'bot:scout', id: 'm20', at: 1_020 })
  await mount(chat(400))

  await act(async () => button('Jump to latest')!.click())
  expect(drawn()).toBe(150)
  expect(host.textContent).toContain('message 399')
  expect(msgTexts()).not.toContain('message 20')
})

test('sending while reading older messages goes back to the latest, where the message is', async () => {
  $jumpTo.set({ scope: 'bot:scout', id: 'm20', at: 1_020 })
  const old = chat(400)
  await mount(old)
  expect(host.textContent).not.toContain('message 399')

  await mount([...old, { id: 'sent', role: 'user', text: 'my new message', at: 9_999 } as ChatMsg])
  expect(host.textContent).toContain('my new message')
  expect(host.textContent).toContain('message 399')
})

test('"Show earlier messages" keeps what you were reading in place', async () => {
  await mount(chat(400))
  const thread = host.querySelector('.thread') as HTMLElement
  // happy-dom has no layout: give each drawn message a height of 100px.
  Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => thread.querySelectorAll('.msg').length * 100 })
  thread.scrollTop = 0

  await act(async () => more()!.click())
  // 300 drawn, and the reader is still on the message that was at the top before: 150 * 100px down.
  expect(drawn()).toBe(300)
  expect(thread.scrollTop).toBe(15_000)
})
