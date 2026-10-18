import { expect, test } from 'bun:test'
const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => memory.set(k, v), removeItem: (k: string) => memory.delete(k) }, configurable: true })
const { native } = await import('../src/lib/native')
const { $active } = await import('../src/lib/store')
const identity = await import('../src/lib/bot-identity')

test('an endpoint change fences an in-flight identity proof before another caller arrives', async () => {
  identity.forgetBotIdentity()
  $active.set({ baseUrl: 'http://old.test', token: 'fixture' } as any)
  let finish!: (value: any) => void
  native.groupsEnsureIdentity = () => new Promise(resolve => { finish = resolve })
  const old = identity.ensureBotIdentity('endpoint-race')
  $active.set({ baseUrl: 'http://replacement.test', token: 'fixture' } as any)
  finish({ ready: true })
  expect((await old).ready).toBe(false)
})

test('a caller on a replacement endpoint cannot join the previous endpoint check', async () => {
  identity.forgetBotIdentity()
  $active.set({ baseUrl: 'http://old.test', token: 'fixture' } as any)
  let finish!: (value: any) => void
  let calls = 0
  native.groupsEnsureIdentity = async () => {
    calls++
    if (calls === 1) return new Promise(resolve => { finish = resolve })
    return { ready: false, error: 'replacement refused' }
  }
  const old = identity.ensureBotIdentity('pending-race')
  $active.set({ baseUrl: 'http://replacement.test', token: 'fixture' } as any)
  const current = identity.ensureBotIdentity('pending-race')
  finish({ ready: true })
  expect((await current).ready).toBe(false)
  expect((await old).ready).toBe(false)
  expect(calls).toBe(2)
})
