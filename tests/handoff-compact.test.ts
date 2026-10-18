import { expect, test } from 'bun:test'
import { cardsForBot, compactInstruction } from '../src/lib/handoff'
import type { HelpCard } from '../src/lib/types'

const card = (owner?: string): HelpCard => ({
  id: `h-${owner ?? 'none'}`,
  at: 1,
  instruction: 'Sign in',
  doneLabel: 'Done',
  status: 'open',
  ...(owner ? { owner } : {})
})

test('a help card shows only in the chat of the bot that asked for it', () => {
  const cards = [card('homework'), card('default'), card()]

  expect(cardsForBot(cards, 'default').map(item => item.owner)).toEqual(['default', undefined])
  expect(cardsForBot(cards, 'homework').map(item => item.owner)).toEqual(['homework', undefined])
  expect(cardsForBot(cards, 'scout').map(item => item.owner)).toEqual([undefined])
})

test('the chat shows one short line and never the raw link', () => {
  const text = 'Open https://smoking-televisions-manually-mystery.trycloudflare.com/vnc.html?autoconnect=true  and   sign in'

  expect(compactInstruction(text)).toBe('Open and sign in')
})

test('a long instruction is cut at a word boundary with an ellipsis', () => {
  const long =
    'Sign in to your IITM Google account on the page that is already showing, click Next, and clear any 2FA yourself please'
  const out = compactInstruction(long)

  expect(out.endsWith('…')).toBe(true)
  expect(out.length).toBeLessThanOrEqual(111)
  expect(long.startsWith(out.slice(0, -1))).toBe(true)
  expect(out.slice(0, -1).endsWith(' ')).toBe(false)
})
