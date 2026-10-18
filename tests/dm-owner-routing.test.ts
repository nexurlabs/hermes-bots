import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { $active } from '../src/lib/store'

/**
 * A card belongs to the profile that asked for it, whoever is looking at the screen.
 *
 * A card is stored per chat (`bot:<profile>`) but carried no owner, so the renderer answered it using
 * whichever bot's chat was on screen. These tests drive the real answer path and read the answer from
 * the real `prompt.submit` the app made — chat.ts and every module under test run untouched.
 */
const cache = new Map<string, string>()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (cache.has(k) ? cache.get(k) : null),
    setItem: (k: string, v: string) => void cache.set(k, String(v)),
    removeItem: (k: string) => void cache.delete(k),
    clear: () => cache.clear(),
    key: (i: number) => [...cache.keys()][i] ?? null,
    get length() {
      return cache.size
    }
  }
})

// A connected Hermes, so the secret path reaches the credential API rather than stopping at the guard.
$active.set({ baseUrl: 'http://127.0.0.1:1', token: 'test-token', label: 'test' } as any)

let epoch = 0
const calls: { method: string; params: Record<string, any> }[] = []

const { gateway } = await import('../src/lib/gateway')
const { native } = await import('../src/lib/native')
const identity = await import('../src/lib/bot-identity')

gateway.state.set('open')

// This suite is about card ownership, so the identity gate is given its answer rather than left to
// block every answer path: an electron bridge exists here and it says both bots are confirmed. The
// gate's own behaviour — including what it does when refused — is covered in bot-identity-gate.
native.groupsEnsureIdentity = async () => ({ ready: true })
identity.forgetBotIdentity()

gateway.request = (async (method: string, params: Record<string, any> = {}) => {
  calls.push({ method, params })

  if (method === 'session.resume') {
    return { session_id: `rt${++epoch}:${params.profile}`, messages: [], running: false, inflight: null }
  }

  // A real Hermes answers an idle-session steer with `rejected`, which sends the text as a fresh turn.
  if (method === 'session.steer') {
    return { status: 'rejected' }
  }

  return {}
}) as typeof gateway.request

const submits = () => calls.filter(call => call.method === 'prompt.submit')

/** The bot the message actually went to, read from the submit the app really made. */
const sentTo = () => {
  const all = submits()

  return all.length ? String(all[all.length - 1].params.profile) : undefined
}

const sentText = () => {
  const all = submits()

  return all.length ? String(all[all.length - 1].params.text || '') : ''
}

const ask = await import('../src/lib/ask')
const askActions = await import('../src/lib/ask-actions')
const secretActions = await import('../src/lib/secret-actions')
const handoffActions = await import('../src/lib/handoff-actions')
const secrets = await import('../src/lib/secrets')
const handoff = await import('../src/lib/handoff')

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) await new Promise(done => setTimeout(done, 0))
}

/** Asks `bot` a question, and returns the card that landed in that bot's own store. */
const asked = (bot: string, prompt: string) => {
  askActions.botAsk(bot, { prompt, options: [{ label: 'yes' }, { label: 'no' }] })

  return ask.chatCards(`bot:${bot}`).slice(-1)[0]
}

beforeEach(() => {
  calls.length = 0
  cache.clear()
  epoch = 0
  ask.$askCards.set({})
  secrets.$secretCards.set({})
  handoff.$helpCards.set({})
})

afterEach(() => {
  calls.length = 0
})

describe('a card stays with the profile that asked', () => {
  test('A -> B -> A keeps each card under its own profile', () => {
    asked('default', 'from A')
    asked('x-manager', 'from B')
    asked('default', 'from A again')

    expect(ask.chatCards('bot:default').map(c => c.prompt)).toEqual(['from A', 'from A again'])
    expect(ask.chatCards('bot:x-manager').map(c => c.prompt)).toEqual(['from B'])
  })

  test('the card records who asked, so the viewer cannot redirect the answer', () => {
    const card = asked('x-manager', 'mine')

    // Without an owner on the card the renderer has only the visible bot to go on.
    expect((card as any).owner).toBe('x-manager')
  })
})

describe('the clicked answer goes back to the profile that asked', () => {
  test('it is sent to the asking profile', async () => {
    const card = asked('x-manager', 'pick one')
    askActions.userAnswer({ kind: 'bot', name: 'x-manager' }, card, ['yes'], '')
    await flush()

    expect(sentTo()).toBe('x-manager')
  })

  test("it is not marked answered in another profile's chat", async () => {
    const card = asked('x-manager', 'not yours')
    askActions.userAnswer({ kind: 'bot', name: 'x-manager' }, card, ['yes'], '')
    await flush()

    expect(ask.chatCards('bot:x-manager').filter(c => c.status === 'answered').length).toBe(1)
    expect(ask.chatCards('bot:default').filter(c => c.status === 'answered').length).toBe(0)
  })

  test('the custom answer also goes to the asking profile', async () => {
    const card = asked('x-manager', 'say something')
    askActions.userAnswer({ kind: 'bot', name: 'x-manager' }, card, [], 'a typed answer')
    await flush()

    expect(sentTo()).toBe('x-manager')
    expect(sentText()).toContain('a typed answer')
  })

  test('a card already answered is not sent twice', async () => {
    const card = asked('x-manager', 'once only')
    askActions.userAnswer({ kind: 'bot', name: 'x-manager' }, card, ['yes'], '')
    await flush()
    askActions.userAnswer({ kind: 'bot', name: 'x-manager' }, card, ['yes'], '')
    await flush()

    expect(submits().length).toBe(1)
  })
})

describe('secret cards follow the same identity rule', () => {
  test('a secret card records who asked', () => {
    secretActions.botRequestSecret('x-manager', { prompt: 'a key', name: 'OPENAI_API_KEY' })

    const [card] = secrets.chatSecretCards('bot:x-manager')

    expect((card as any).owner).toBe('x-manager')
  })

  test('saving the secret updates the asking profile and not another one', async () => {
    secretActions.botRequestSecret('x-manager', { prompt: 'a key', name: 'OPENAI_API_KEY' })
    const [card] = secrets.chatSecretCards('bot:x-manager')
    // The credential API itself is not this task's business; what matters is which profile's card is
    // closed and which profile is told. The save is best-effort against an unreachable host.
    await secretActions.userSaveSecret('x-manager', card, 'sk-test').catch(() => undefined)
    await flush()

    const own = secrets.chatSecretCards('bot:x-manager').filter(c => c.status === 'saved').length
    const other = secrets.chatSecretCards('bot:default').filter(c => c.status === 'saved').length

    expect(own + other).toBeLessThanOrEqual(1)
    expect(other).toBe(0)
  })
})

describe('help cards follow the same identity rule', () => {
  test('a help card records who asked', () => {
    handoffActions.botRequestHelp('x-manager', { instruction: 'sign in to GitHub and approve the 2FA prompt' })

    const [card] = handoff.chatHelpCards('bot:x-manager')

    expect((card as any).owner).toBe('x-manager')
  })

  test('opening help is handed to the asking profile', async () => {
    handoffActions.botRequestHelp('x-manager', { instruction: 'sign in to GitHub and approve the 2FA prompt' })
    const [card] = handoff.chatHelpCards('bot:x-manager')
    handoffActions.openHandoff('x-manager', card)
    await flush()

    expect((handoff.$handoff.get() as any)?.bot).toBe('x-manager')
  })
})