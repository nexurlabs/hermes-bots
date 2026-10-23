import { afterEach, expect, test } from 'bun:test'
import { gateway } from '../src/lib/gateway'

const cache = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => cache.get(key) ?? null,
  setItem: (key: string, value: string) => cache.set(key, value),
  removeItem: (key: string) => cache.delete(key)
} })

let effective: unknown = 'smart'
let raw: unknown = 'smart'
gateway.request = (async (method: string, params: any = {}) => {
  if (method === 'profiles.describe') return { model: { provider: 'minimax', default: 'MiniMax-M2.7' } }
  if (method === 'config.get' && params.key === 'approvals.mode') return { value: effective }
  if (method === 'config.get') return { config: { approvals: { mode: raw } } }
  if (method === 'config.set' && params.key === 'approvals.mode') {
    effective = params.value
    raw = params.value
    return {}
  }
  return {}
}) as typeof gateway.request

const bc = await import('../src/lib/botconfig')

afterEach(() => bc.$botConfig.set({}))

test('Hermes values are read faithfully, never defaulted to Ask me', () => {
  expect(bc.normalizeApprovals('smart')).toBe('smart')
  expect(bc.normalizeApprovals('off')).toBe('off')
  expect(bc.normalizeApprovals(false)).toBe('off') // YAML bare `off`
  expect(bc.normalizeApprovals('manual')).toBe('manual')
  expect(bc.normalizeApprovals(undefined)).toBe('manual') // Hermes's own default
  expect(bc.normalizeApprovals('yolo')).toBe('unknown')
  expect(bc.approvalLabel('unknown' as any)).toBe('Unknown')
})

test('the panel shows Smart when Hermes has approvals.mode: smart', async () => {
  effective = 'smart'
  raw = 'smart'
  await bc.loadBotConfig('alice', true)
  expect((bc.$botConfig.get() as any).alice.approvals).toBe('smart')
})

test('an unknown Hermes value shows as unknown, not Ask me', async () => {
  effective = 'yolo'
  await bc.loadBotConfig('alice', true)
  expect((bc.$botConfig.get() as any).alice.approvals).toBe('unknown')
  expect((bc.$botConfig.get() as any).alice.approvalsRaw).toBe('yolo')
})

test('setApprovals writes the value and re-reads what Hermes kept', async () => {
  effective = 'manual'
  await bc.loadBotConfig('alice', true)
  await bc.setApprovals('alice', 'off')
  expect(effective).toBe('off')
  expect((bc.$botConfig.get() as any).alice.approvals).toBe('off')
})
