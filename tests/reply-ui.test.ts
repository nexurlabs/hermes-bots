import { afterEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Bot } from '../src/lib/types'

const window = new Window({ url: 'http://localhost' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : (window as any)[key] })
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const { Composer, Thread, $quote } = await import('../src/ui/thread')
const { ContextMenuHost, closeContextMenu } = await import('../src/ui/context-menu')
const { $busy } = await import('../src/lib/store')
const { Avatar } = await import('../src/ui/avatar')
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
const bot = { name: 'scout', display: 'Same Name', handle: 'scout', row: { name: 'scout' }, meta: {}, lead: false, preview: '', lastActive: 0 } as Bot
const other = { ...bot, name: 'default', handle: 'kacy' }
const scope = 'room:reply-test'

async function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const sends: any[][] = []
  await act(async () => root!.render(createElement('div', {},
    createElement(Thread, { messages: [{ id: 'reply', role: 'assistant', text: 'original answer', at: 1, from: 'scout' }], botFor: () => bot, group: true, scope }),
    createElement(Composer, { placeholder: 'Message room', scope, mentionables: [other, bot], onSend: (...args: any[]) => sends.push(args) } as any),
    createElement(ContextMenuHost)
  )))
  return sends
}
async function click(selector: string) {
  await act(async () => (host.querySelector(selector) as HTMLElement).click())
}
async function type(value: string) {
  const input = host.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
afterEach(async () => {
  await act(async () => { root?.unmount(); $quote.set(null); closeContextMenu() })
  host?.remove()
})

describe('group reply ownership', () => {
  test('right-click reply keeps the same stable recipient as the reply button', async () => {
    const sends = await mount()
    await act(async () => host.querySelector('.msg.bot .bubble')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })))
    const menuReply = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Reply')!
    await act(async () => menuReply.click())
    await type('menu follow up')
    await click('button[aria-label="Send"]')
    expect(sends[0][2]).toMatchObject({ answerTo: 'scout' })
  })
  test('clicking reply retains the profile identifier, not the display name', async () => {
    await mount()
    await click('button[aria-label="Reply"]')
    expect($quote.get()).toMatchObject({ member: 'scout', scope })
  })
  test('sending edited text passes only the clicked author as a separate recipient', async () => {
    const sends = await mount()
    await click('button[aria-label="Reply"]')
    await type('follow up without any tag')
    await click('button[aria-label="Send"]')
    expect(sends).toHaveLength(1)
    expect(sends[0][0]).toContain('follow up without any tag')
    expect(sends[0][2]).toMatchObject({ answerTo: 'scout' })
  })
  test('cancel reply clears the recipient before a normal send', async () => {
    const sends = await mount()
    await click('button[aria-label="Reply"]')
    await click('button[aria-label="Cancel reply"]')
    await type('normal message')
    await click('button[aria-label="Send"]')
    expect(sends[0][2].answerTo).toBeUndefined()
  })
  test('a quote from another room does not route this room send to that author', async () => {
    const sends = await mount()
    await act(async () => $quote.set({ who: 'Same Name', text: 'foreign answer', member: 'scout', scope: 'room:other' } as any))
    await type('this room message')
    await click('button[aria-label="Send"]')
    expect(sends[0][2].answerTo).toBeUndefined()
    expect(sends[0][0]).not.toContain('foreign answer')
  })
})

describe('working avatars', () => {
  test('decorative avatars stay still while the main status avatar opts into working', async () => {
    await mount()
    await act(async () => {
      $busy.set({ scout: true })
      root!.render(createElement('div', {}, createElement(Avatar, { bot }), createElement(Avatar, { bot, activity: 'global' })))
    })
    expect(host.querySelectorAll('.avatar[data-working]')).toHaveLength(1)
    expect(host.querySelector('.avatar')!.hasAttribute('data-working')).toBe(false)
    await act(async () => $busy.set({}))
  })
  test('only the streaming message animates, never the historical message avatar', async () => {
    await mount()
    await act(async () => {
      $busy.set({ scout: true })
      root!.render(createElement(Thread, {
        messages: [
          { id: 'old', role: 'assistant', text: 'old answer', at: 1, from: 'scout' },
          { id: 'u', role: 'user', text: 'new question', at: 2 },
          { id: 'live', role: 'assistant', text: 'current answer', at: 3, from: 'scout', streaming: true }
        ], botFor: () => bot, group: true
      }))
    })
    expect(host.querySelectorAll('.msg-face .avatar')).toHaveLength(2)
    expect(host.querySelectorAll('.msg-face .avatar[data-working]')).toHaveLength(1)
    expect(host.querySelector('.msg.bot .avatar')!.hasAttribute('data-working')).toBe(false)
    await act(async () => $busy.set({}))
  })
  test('a left-list face gets the working circle only when that bot is opted in', async () => {
    const { AvatarStack } = await import('../src/ui/avatar')
    const css = await Bun.file(new URL('../static/styles.css', import.meta.url)).text()
    await mount()
    await act(async () => {
      $busy.set({ scout: true, default: true })
      root!.render(createElement('div', {},
        createElement(Avatar, { bot, activity: true }),
        createElement(Avatar, { bot: other }),
        createElement(AvatarStack, { bots: [bot, other], activityFor: (item: Bot) => item.name === 'scout' })
      ))
    })
    const faces = [...host.querySelectorAll('.avatar')]
    expect(faces.filter(face => face.hasAttribute('data-working')).length).toBe(2)
    expect(faces[1].hasAttribute('data-working')).toBe(false)
    expect(css).toContain('.avatar[data-working]::after')
    expect(css).toContain('.avatar[data-working] .avatar-star svg { animation: twinkle')
    expect(css).toContain('.avatar-star svg { animation: none; }')
    await act(async () => $busy.set({}))
  })
})
