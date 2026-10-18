import { afterEach, expect, test } from 'bun:test'

const cache = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => cache.get(key) ?? null,
  setItem: (key: string, value: string) => cache.set(key, value),
  removeItem: (key: string) => cache.delete(key)
} })

const { reloadAppToolsOnce } = await import('../src/lib/tool-reload')

let calls: string[] = []
let answer: () => Promise<any> = async () => ({ status: 'reloaded' })
const gw = { request: (async (method: string) => { calls.push(method); return answer() }) as any }

afterEach(() => {
  calls = []
  cache.clear()
  answer = async () => ({ status: 'reloaded' })
})

test('the first launch with new app tools reloads Hermes tools once; later launches do not', async () => {
  await reloadAppToolsOnce(gw, 'https://vm', 'rev1')
  await reloadAppToolsOnce(gw, 'https://vm', 'rev1')
  expect(calls).toEqual(['reload.mcp'])
})

test('a change to the tools reloads again, and each machine is reloaded on its own', async () => {
  await reloadAppToolsOnce(gw, 'https://vm', 'rev1')
  await reloadAppToolsOnce(gw, 'https://vm', 'rev2')
  await reloadAppToolsOnce(gw, 'https://other', 'rev2')
  expect(calls).toEqual(['reload.mcp', 'reload.mcp', 'reload.mcp'])
})

test('two asks at once make one reload', async () => {
  await Promise.all([reloadAppToolsOnce(gw, 'https://vm', 'rev1'), reloadAppToolsOnce(gw, 'https://vm', 'rev1')])
  expect(calls).toEqual(['reload.mcp'])
})

test('a failed or unconfirmed reload is tried again next time', async () => {
  answer = async () => { throw new Error('socket closed') }
  await reloadAppToolsOnce(gw, 'https://vm', 'rev1')
  answer = async () => ({ status: 'confirm_required' })
  await reloadAppToolsOnce(gw, 'https://vm', 'rev1')
  answer = async () => ({ status: 'reloaded' })
  await reloadAppToolsOnce(gw, 'https://vm', 'rev1')
  await reloadAppToolsOnce(gw, 'https://vm', 'rev1')
  expect(calls.length).toBe(3)
})

test('nothing happens without a revision or a machine', async () => {
  await reloadAppToolsOnce(gw, 'https://vm', undefined)
  await reloadAppToolsOnce(gw, '', 'rev1')
  expect(calls).toEqual([])
})
