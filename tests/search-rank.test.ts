import { expect, test } from 'bun:test'

const cache = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => cache.get(key) ?? null,
  setItem: (key: string, value: string) => cache.set(key, value),
  removeItem: (key: string) => cache.delete(key)
} })

const { searchDocs } = await import('../src/lib/search')
import type { SearchDoc } from '../src/lib/search'

const doc = (id: string, text: string, at: number): SearchDoc => ({ scope: 'bot:kacy', target: { kind: 'bot', id: 'kacy' }, id, text, at, fromMe: false, kind: 'message' })
const all = { scope: '', who: 'all' as const }
const order = (docs: SearchDoc[], query: string) => searchDocs(docs, query, all).map(hit => hit.doc.id)

test('the message that says what was searched comes before newer ones that only contain the letters', () => {
  const docs = [
    doc('exact', 'hi! what are we working on today? 👋', 1_000),
    doc('scattered', 'whatever, there are weeks of networking done on the holiday today', 9_000),
    doc('words', 'today we are working on what matters', 5_000)
  ]

  expect(order(docs, 'what are we working on today')).toEqual(['exact', 'words', 'scattered'])
})

test('a whole-word match beats the same letters inside another word, and newer wins within a tier', () => {
  const docs = [doc('inside', 'it is done now', 9_000), doc('old', 'turn it on', 1_000), doc('new', 'switch on please', 5_000)]

  expect(order(docs, 'on')).toEqual(['new', 'old', 'inside'])
})

test('regex characters in a query are matched as text', () => {
  const docs = [doc('a', 'cost is $5 (approx)', 1_000), doc('b', 'nothing here', 2_000)]

  expect(order(docs, '$5 (approx)')).toEqual(['a'])
})
