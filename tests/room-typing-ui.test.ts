import { afterEach, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatMsg, Room, RoomEntry } from '../src/lib/types'

const { RoomView } = await import('../src/ui/views')
const { $roomRunning, $roomTyping, $rooms } = await import('../src/lib/rooms')
const { $openThread } = await import('../src/lib/threads')
const { $profiles } = await import('../src/lib/store')

const key = 'id:parallel-typing-ui'
const room: Room = {
  key,
  name: 'Parallel typing',
  roomId: 'parallel-typing-ui',
  members: [{ name: 'alpha', handle: 'alpha' }, { name: 'beta', handle: 'beta' }],
  log: []
}

afterEach(() => {
  $roomTyping.set({})
  $roomRunning.set({})
  $rooms.set({})
  $openThread.set(null)
  $profiles.set([])
})

describe('room typing UI', () => {
  test('renders a separate live reply for every concurrently typing bot', () => {
    $profiles.set([
      { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha' } } },
      { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
    ] as any)
    $rooms.set({ [key]: room })

    const alpha: ChatMsg = { id: 'alpha-stream', role: 'assistant', text: 'alpha partial answer', at: 1, from: 'alpha', streaming: true }
    const beta: ChatMsg = { id: 'beta-stream', role: 'assistant', text: 'beta partial answer', at: 2, from: 'beta', streaming: true }
    $roomTyping.set({
      [key]: {
        alpha: { member: 'alpha', messages: [alpha] },
        beta: { member: 'beta', messages: [beta] }
      }
    })

    const html = renderToStaticMarkup(createElement(RoomView, { room }))

    expect(html).toContain('alpha partial answer')
    expect(html).toContain('beta partial answer')
    expect((html.match(/class="msg bot"/g) || []).length).toBe(2)
  })

  test('shows an empty typing bubble for one bot without hiding another bot\'s partial reply', () => {
    $profiles.set([
      { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha' } } },
      { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
    ] as any)
    $rooms.set({ [key]: room })

    const beta: ChatMsg = { id: 'beta-stream', role: 'assistant', text: 'beta partial answer', at: 2, from: 'beta', streaming: true }
    $roomTyping.set({
      [key]: {
        alpha: { member: 'alpha', messages: [] },
        beta: { member: 'beta', messages: [beta] }
      }
    })

    const html = renderToStaticMarkup(createElement(RoomView, { room }))

    expect(html).toContain('class="bubble typing"')
    expect(html).toContain('beta partial answer')
    expect((html.match(/class="msg bot"/g) || []).length).toBe(2)
  })

  test('keeps concurrent live replies inside their open thread', () => {
    $profiles.set([
      { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha' } } },
      { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
    ] as any)
    const root: RoomEntry = { id: 'thread-root', at: 1, from: { kind: 'member', name: 'alpha' }, text: 'thread topic' }
    const threadedRoom = { ...room, log: [root] }
    $rooms.set({ [key]: threadedRoom })
    $openThread.set({ scope: `room:${room.roomId}`, root: root.id })

    const alpha: ChatMsg = { id: 'alpha-thread-stream', role: 'assistant', text: 'alpha thread reply', at: 2, from: 'alpha', streaming: true }
    const beta: ChatMsg = { id: 'beta-thread-stream', role: 'assistant', text: 'beta thread reply', at: 3, from: 'beta', streaming: true }
    $roomTyping.set({
      [key]: {
        alpha: { member: 'alpha', messages: [alpha], thread: root.id },
        beta: { member: 'beta', messages: [beta], thread: root.id }
      }
    })

    const html = renderToStaticMarkup(createElement(RoomView, { room: threadedRoom }))

    expect(html).toContain('alpha thread reply')
    expect(html).toContain('beta thread reply')
    expect(html).toContain('thread topic')
  })

  test('keeps an empty typing bubble in a thread alongside another member\'s partial reply', () => {
    $profiles.set([
      { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha' } } },
      { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
    ] as any)
    const root: RoomEntry = { id: 'thread-root', at: 1, from: { kind: 'member', name: 'alpha' }, text: 'thread topic' }
    const threadedRoom = { ...room, log: [root] }
    $rooms.set({ [key]: threadedRoom })
    $openThread.set({ scope: `room:${room.roomId}`, root: root.id })

    const beta: ChatMsg = { id: 'beta-thread-stream', role: 'assistant', text: 'beta thread reply', at: 3, from: 'beta', streaming: true }
    $roomTyping.set({
      [key]: {
        alpha: { member: 'alpha', messages: [], thread: root.id },
        beta: { member: 'beta', messages: [beta], thread: root.id }
      }
    })

    const html = renderToStaticMarkup(createElement(RoomView, { room: threadedRoom }))

    expect(html).toContain('class="bubble typing"')
    expect(html).toContain('beta thread reply')
  })

  test('keeps the remaining live reply visible when one member finishes', () => {
    $profiles.set([
      { name: 'alpha', ui_meta: { 'hermes-bots': { title: 'Alpha' } } },
      { name: 'beta', ui_meta: { 'hermes-bots': { title: 'Beta' } } }
    ] as any)
    $rooms.set({ [key]: room })

    const alpha: ChatMsg = { id: 'alpha-stream', role: 'assistant', text: 'alpha finished', at: 1, from: 'alpha', streaming: true }
    const beta: ChatMsg = { id: 'beta-stream', role: 'assistant', text: 'beta still streaming', at: 2, from: 'beta', streaming: true }
    $roomTyping.set({
      [key]: {
        alpha: { member: 'alpha', messages: [alpha] },
        beta: { member: 'beta', messages: [beta] }
      }
    })

    // Simulate alpha's live turn being removed after completion; beta must remain in the room state.
    $roomTyping.set({ [key]: { beta: { member: 'beta', messages: [beta] } } })
    const html = renderToStaticMarkup(createElement(RoomView, { room }))

    expect(html).not.toContain('alpha finished')
    expect(html).toContain('beta still streaming')
    expect((html.match(/class="msg bot"/g) || []).length).toBe(1)
  })
})
