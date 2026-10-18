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
  if (method === 'profiles.describe') return { model: { provider: 'anthropic', default: 'claude-haiku-5-5' } }
  if (method === 'config.get') return { config: {} }
  return {}
}) as typeof gateway.request

const { $botConfig } = await import('../src/lib/botconfig')
const models = await import('../src/lib/session-model')
const pins = () => calls.filter(c => c.method === 'config.set' && c.params.key === 'model').map(c => c.params.value)

afterEach(() => {
  calls.length = 0
  models.$sessionModels.set({})
  $botConfig.set({})
})

test('a group session Hermes kept on an old model goes back to the bot default', async () => {
  await models.reapplySessionModel('room:r1:kacy', 'rt-1', 'kacy', { model: 'gpt-6.1-sol' })

  expect(pins()).toEqual(['claude-haiku-5-5 --provider anthropic --session'])
})

test('a session already on the bot default is left alone', async () => {
  await models.reapplySessionModel('room:r1:kacy', 'rt-1', 'kacy', { model: 'anthropic/claude-haiku-5-5' })

  expect(pins()).toEqual([])
})

test('a pick for this chat is pinned again, whatever the session ran before', async () => {
  models.$sessionModels.set({ 'room:r1:kacy': { provider: 'openrouter', model: 'qwen-4' } })
  await models.reapplySessionModel('room:r1:kacy', 'rt-1', 'kacy', { model: 'claude-haiku-5-5' })

  expect(pins()).toEqual(['qwen-4 --provider openrouter --session'])
})

test('no model reported for the session: nothing is pinned', async () => {
  await models.reapplySessionModel('bot:kacy', 'rt-2', 'kacy')

  expect(pins()).toEqual([])
  expect(calls).toEqual([])
})
