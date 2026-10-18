import { expect, test } from 'bun:test'

const cache = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => cache.get(key) ?? null,
  setItem: (key: string, value: string) => cache.set(key, value),
  removeItem: (key: string) => cache.delete(key)
} })

const { chatGrantFor, pcAction } = await import('../src/lib/approvals')
const THIS_PC = 'hermes-bots-this-pc'

test('a This PC command is never granted for a whole chat', () => {
  expect(pcAction('mcp__hermes_bots_this_pc__computer_terminal')).toBe('terminal')
  expect(chatGrantFor(THIS_PC, 'terminal')).toBe(false)
})

test('clicks and typing on This PC can still be granted for a chat', () => {
  for (const action of ['click', 'type', 'key', 'move', 'drag', 'scroll']) {
    expect(chatGrantFor(THIS_PC, action)).toBe(true)
  }
})

test('other untrusted MCP servers keep "Allow for this chat" as before', () => {
  expect(chatGrantFor('some-other-server', 'terminal')).toBe(true)
  expect(chatGrantFor(undefined, undefined)).toBe(true)
})
