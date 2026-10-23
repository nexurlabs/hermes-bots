import { afterEach, expect, test } from 'bun:test'
import { gateway } from '../src/lib/gateway'

const cache = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => cache.get(key) ?? null,
  setItem: (key: string, value: string) => cache.set(key, value),
  removeItem: (key: string) => cache.delete(key)
} })

const calls: { method: string; params: any }[] = []
gateway.request = (async (method: string, params: any = {}) => {
  calls.push({ method, params })
  return {}
}) as typeof gateway.request

const models = await import('../src/lib/session-model')
const pins = () => calls.filter(c => c.method === 'config.set' && c.params.key === 'model').map(c => `${c.params.session_id}:${c.params.value}`)

afterEach(() => {
  calls.length = 0
  models.$sessionModels.set({})
})

test('a new bot default is pinned on the running sessions right away (next turn uses it)', async () => {
  models.useLiveSessions(profile => (profile === 'alice' ? [{ key: 'bot:alice', runtime: 'rt-1' }, { key: 'room:r1:alice', runtime: 'rt-2' }] : []))
  const n = await models.applyDefaultToLiveSessions('alice', { provider: 'minimax', model: 'MiniMax-M2.7' })
  expect(n).toBe(2)
  expect(pins()).toEqual(['rt-1:MiniMax-M2.7 --provider minimax --session', 'rt-2:MiniMax-M2.7 --provider minimax --session'])
})

test('a chat with its own model pick keeps it', async () => {
  models.useLiveSessions(() => [{ key: 'bot:alice', runtime: 'rt-1' }])
  models.$sessionModels.set({ 'bot:alice': { provider: 'minimax', model: 'MiniMax-M3' } })
  expect(await models.applyDefaultToLiveSessions('alice', { provider: 'minimax', model: 'MiniMax-M2.7' })).toBe(0)
  expect(pins()).toEqual([])
})
