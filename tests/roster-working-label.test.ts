import { afterEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatMsg, Room } from '../src/lib/types'

const { Roster } = await import('../src/ui/roster')
const { $roomRunning, $roomTyping, $rooms } = await import('../src/lib/rooms')
const { $busy, $profiles } = await import('../src/lib/store')
const { $chats } = await import('../src/lib/chat')
const { $approvals } = await import('../src/lib/approvals')

const key = 'id:roster-working-label'
const room: Room = {
  key,
  name: 'Typing room',
  roomId: 'roster-working-label',
  members: [{ name: 'alpha' }, { name: 'beta' }],
  log: []
}
const window = new Window()

function seed() {
  $profiles.set([
    { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha', lead: true } } },
    { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
  ])
  $rooms.set({ [key]: room })
}

function rowText(name: string) {
  const root = window.document.createElement('div')
  root.innerHTML = renderToStaticMarkup(createElement(Roster))
  const row = [...root.querySelectorAll('.row')].find(candidate => candidate.querySelector('.row-name')?.textContent?.trim() === name)

  expect(row).toBeDefined()
  return row?.textContent || ''
}

function assistant(text: string, streaming = true): ChatMsg {
  return { id: 'reply', role: 'assistant', text, at: 1, from: 'beta', streaming }
}

afterEach(() => {
  $approvals.set([])
  $busy.set({})
  $chats.set({})
  $profiles.set([])
  $roomRunning.set({})
  $roomTyping.set({})
  $rooms.set({})
  window.document.body.innerHTML = ''
})

describe('roster working and streaming labels', () => {
  test('a busy room with an empty live bubble does not say typing', () => {
    seed()
    $roomRunning.set({ [key]: true })
    $roomTyping.set({ [key]: { beta: { member: 'beta', messages: [assistant('   ')] } } })

    const text = rowText(room.name)

    expect(text).toContain('working')
    expect(text).not.toContain('typing')
  })

  test('a busy bot with an empty live bubble does not say typing', () => {
    seed()
    $busy.set({ beta: true })
    $chats.set({ beta: { loading: false, running: true, messages: [assistant('')] } })

    const text = rowText('Beta')

    expect(text).toContain('working')
    expect(text).not.toContain('typing')
  })

  test('a room with visible non-pass reply text says typing', () => {
    seed()
    $roomRunning.set({ [key]: true })
    $roomTyping.set({ [key]: { beta: { member: 'beta', messages: [assistant('  partial room reply  ')] } } })

    expect(rowText(room.name)).toContain('typing…')
  })

  test('a bot with visible text in its streaming message says typing', () => {
    seed()
    $busy.set({ beta: true })
    $chats.set({ beta: { loading: false, running: true, messages: [assistant('partial 1:1 reply')] } })

    expect(rowText('Beta')).toContain('typing…')
  })

  test('a pass-only room segment remains working, not typing', () => {
    seed()
    $roomRunning.set({ [key]: true })
    $roomTyping.set({ [key]: { beta: { member: 'beta', messages: [assistant('(pass)')] } } })

    const text = rowText(room.name)

    expect(text).toContain('working')
    expect(text).not.toContain('typing')
  })

  test('a pass-only 1:1 segment remains working, not typing', () => {
    seed()
    $busy.set({ beta: true })
    $chats.set({ beta: { loading: false, running: true, messages: [assistant('[pass].')] } })

    const text = rowText('Beta')

    expect(text).toContain('working')
    expect(text).not.toContain('typing')
  })

  test('a running room with no stream shows working', () => {
    seed()
    $roomRunning.set({ [key]: true })

    const text = rowText(room.name)

    expect(text).toContain('working')
    expect(text).not.toContain('typing')
  })

  test('needs your OK remains above streaming labels', () => {
    seed()
    $roomRunning.set({ [key]: true })
    $roomTyping.set({ [key]: { beta: { member: 'beta', messages: [assistant('visible room reply')] } } })
    $busy.set({ beta: true })
    $chats.set({ beta: { loading: false, running: true, messages: [assistant('visible 1:1 reply')] } })
    $approvals.set([
      { id: 'room-ask', scope: `room:${room.roomId}`, bot: 'beta', status: 'pending' },
      { id: 'bot-ask', scope: 'bot:beta', bot: 'beta', status: 'pending' }
    ] as any)

    expect(rowText(room.name)).toContain('Beta needs your OK')
    expect(rowText('Beta')).toContain('Needs your OK')
  })
})
