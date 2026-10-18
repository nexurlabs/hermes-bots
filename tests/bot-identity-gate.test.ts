import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { $active } from '../src/lib/store'

/**
 * A bot's first turn is gated on that bot being its own bot, end to end.
 *
 * Two separate boundaries are exercised here, and both have to hold:
 *
 *  - Registration. `registerThisPc` writes the profile's groups entry and refuses to call the profile
 *    ready unless the entry it reads back names that profile's own route. Tested in
 *    tests/dm-identity-gate.test.cjs against the real Electron functions.
 *  - Turn gating. Before `sendToBot` submits anything, the renderer asks the main process to confirm
 *    that bot's identity (src/lib/bot-identity.ts). A refusal must stop the turn, must be visible to
 *    the user, and must never let a message be submitted to the wrong profile.
 *
 * The card and answer paths run through the real modules untouched; only the gateway transport and
 * the Electron identity IPC are fixtures, because those are the two boundaries that cross processes.
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

$active.set({ baseUrl: 'http://127.0.0.1:1', token: 'test-token', label: 'test' } as any)

let epoch = 0
const calls: { method: string; params: Record<string, any> }[] = []

const { gateway } = await import('../src/lib/gateway')
const { native } = await import('../src/lib/native')

gateway.state.set('open')

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
const sentTo = () => {
  const all = submits()

  return all.length ? String(all[all.length - 1].params.profile) : undefined
}

const ask = await import('../src/lib/ask')
const chat = await import('../src/lib/chat')
const askActions = await import('../src/lib/ask-actions')
const secretActions = await import('../src/lib/secret-actions')
const handoffActions = await import('../src/lib/handoff-actions')
const secrets = await import('../src/lib/secrets')
const handoff = await import('../src/lib/handoff')
const identity = await import('../src/lib/bot-identity')
const hosts = await import('../src/lib/hosts')

/** The socket of the machine the added-machine cases adopt, once one exists. */
let remote: any = null

/** The settings `hosts` reads and writes while a machine is being adopted. */
let machineSettings: any = { connections: [], machines: [] }

/**
 * Adds a real machine through `hosts.addMachine()` and returns its host id.
 *
 * The machine is never reachable from a test — there is no second Hermes to talk to — so the connect
 * that follows the adoption fails and `addMachine` rethrows. The adoption itself is already done by
 * then: that is what registers the machine's Gateway and endpoint, which is the whole point of these
 * cases. So the id is read back rather than the throw treated as a failure to set up.
 */
const adoptMachine = async () => {
  try {
    return await hosts.addMachine({ id: 'second', kind: 'remote', label: 'Second', baseUrl: 'http://second-machine.test:8642' } as any)
  } catch {
    return machineSettings.machines[machineSettings.machines.length - 1].id
  }
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) await new Promise(done => setTimeout(done, 0))
}

/** What the main process is being asked, per bot. This is the identity gate's whole surface. */
type Verdict = { ready: boolean; error?: string }
const asked: Record<string, Verdict[]> = {}

/** Every answer goes through here, so `asked` counts IPC calls whichever way a test replies. */
const answerAs = (reply: (who: string) => Verdict | Promise<Verdict>) => {
  ;(native as any).groupsEnsureIdentity = async (who: string) => {
    const result = await reply(who)

    ;(asked[who] = asked[who] || []).push(result)

    return result
  }
}

const setIdentity = (verdict: Verdict | ((who: string) => Verdict)) =>
  answerAs(async who => (typeof verdict === 'function' ? verdict(who) : verdict))

const clearIdentity = () => {
  delete (native as any).groupsEnsureIdentity

  for (const who of Object.keys(asked)) delete asked[who]
}

const errorText = (who: string) =>
  chat.$chats
    .get()[who]
    ?.messages.filter((m: any) => m.role === 'error')
    .map((m: any) => m.text)
    .join(' | ') || ''

/** A promise plus the hand that settles it, so a test can hold an IPC answer open. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

/** A verdict per call, in order; the last one repeats once the list runs out. */
const askSequence = (...verdicts: Verdict[]) => {
  let at = 0

  answerAs(async () => verdicts[Math.min(at++, verdicts.length - 1)])
}

/** The newest thing a given bot was told, and how many times it was asked. */
const asksFor = (who: string) => asked[who]?.length || 0
const ipcCalls = () => Object.values(asked).reduce((all, list) => all + list.length, 0)

beforeEach(() => {
  calls.length = 0
  cache.clear()
  epoch = 0
  // A test may move the address to check that a proof dies with it; the next test starts at the
  // same place this suite has always used.
  $active.set({ baseUrl: 'http://127.0.0.1:1', token: 'test-token', label: 'test' } as any)
  ask.$askCards.set({})
  secrets.$secretCards.set({})
  handoff.$helpCards.set({})
  identity.forgetBotIdentity()
  clearIdentity()
  setIdentity({ ready: true })
})

afterEach(() => {
  calls.length = 0
  clearIdentity()
})

describe('the gate lets a confirmed bot talk', () => {
  test('a confirmed profile\'s message is submitted to that profile', async () => {
    await chat.sendToBot('x-manager', 'hello')
    await flush()

    expect(sentTo()).toBe('x-manager')
    // The gate was actually consulted, not skipped.
    expect(asked['x-manager']?.length).toBe(1)
  })

  test('the gate is asked once for a proven bot, not on every message', async () => {
    await chat.sendToBot('x-manager', 'first')
    await flush()
    await chat.sendToBot('x-manager', 'second')
    await flush()

    expect(asked['x-manager']?.length).toBe(1)
    expect(submits().length).toBe(2)
  })

  test('a refused profile\'s message is not submitted anywhere', async () => {
    setIdentity({ ready: false, error: 'x-manager could not be confirmed as its own bot on this Hermes.' })

    await chat.sendToBot('x-manager', 'this must not be sent')
    await flush()

    expect(submits().length).toBe(0)
  })

  test('the refusal is shown to the user rather than swallowed', async () => {
    setIdentity({ ready: false, error: 'x-manager could not be confirmed as its own bot on this Hermes.' })

    await chat.sendToBot('x-manager', 'hello')
    await flush()

    expect(errorText('x-manager')).toContain('x-manager')
  })

  test('a refusal for one bot does not block another', async () => {
    setIdentity(who => (who === 'x-manager' ? { ready: false, error: 'not yours' } : { ready: true }))

    await chat.sendToBot('x-manager', 'blocked')
    await chat.sendToBot('default', 'allowed')
    await flush()

    expect(sentTo()).toBe('default')
    expect(submits().filter(c => String(c.params.profile) === 'x-manager').length).toBe(0)
  })

  test('an error from the gate is treated as unproven, not as permission', async () => {
    ;(native as any).groupsEnsureIdentity = async () => {
      throw new Error('the check itself failed')
    }

    await chat.sendToBot('x-manager', 'hello')
    await flush()

    // A failed check proves nothing, so it is a refusal.
    expect(submits().length).toBe(0)
  })

  test('a preview with no Electron bridge is not blocked', async () => {
    clearIdentity()

    await chat.sendToBot('x-manager', 'hello in the preview')
    await flush()

    // No bridge means nothing to prove, not a refusal.
    expect(sentTo()).toBe('x-manager')
  })

  test('concurrent messages to a fresh bot share one check', async () => {
    let inFlight = 0
    let peak = 0
    ;(native as any).groupsEnsureIdentity = async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(done => setTimeout(done, 1))
      inFlight -= 1

      return { ready: true }
    }

    await Promise.all([chat.sendToBot('x-manager', 'a'), chat.sendToBot('x-manager', 'b')])
    await flush()

    expect(peak).toBe(1)
  })
})

describe('A -> B -> A through the real gate', () => {
  test('each bot asks about itself and its own message reaches it', async () => {
    await chat.sendToBot('default', 'from A')
    await chat.sendToBot('x-manager', 'from B')
    await chat.sendToBot('default', 'from A again')
    await flush()

    expect(asked.default?.length).toBeGreaterThan(0)
    expect(asked['x-manager']?.length).toBeGreaterThan(0)
    expect(submits().map(c => String(c.params.profile))).toEqual(['default', 'x-manager', 'default'])
    expect(sentTo()).toBe('default')
  })

  test('A blocked mid-sequence never leaks into B', async () => {
    await chat.sendToBot('default', 'from A')
    setIdentity(who => (who === 'x-manager' ? { ready: false, error: 'refused' } : { ready: true }))
    await chat.sendToBot('x-manager', 'from B')
    await chat.sendToBot('default', 'from A again')
    await flush()

    // The refused turn leaves no trace in the wire: default's two messages are still the only submits.
    expect(submits().map(c => String(c.params.profile))).toEqual(['default', 'default'])
    // B's text never went out.
    expect(submits().every(c => c.params.text?.includes('from B') === false)).toBe(true)
  })
})

describe('a proof belongs to the connection it was made on', () => {
  test('a reconnect at an unchanged event sequence asks Hermes again', async () => {
    askSequence({ ready: true })

    const first = await identity.ensureBotIdentity('x-manager')

    // A reconnect replaces the socket; `gateway.seq` is the event high-water mark and does not
    // move, so a cache keyed on it would hand this turn the answer from the dead connection.
    answerAs(async () => ({ ready: false, error: 'the replacement connection says no' }))
    gateway.emitReconnect()
    const afterReconnect = await identity.ensureBotIdentity('x-manager')

    expect(first.ready).toBe(true)
    expect(afterReconnect.ready).toBe(false)
    expect(asksFor('x-manager')).toBe(2)
  })

  test('ordinary events advancing the sequence are not a reconnect', async () => {
    askSequence({ ready: true })

    await identity.ensureBotIdentity('x-manager')
    // Real frames, on the same socket: `handleFrame` bumps `lastSeq` and dispatches.
    gateway.dispatch({ type: 'sessions.changed' })
    ;(gateway as any).handleFrame({ method: 'event', params: { type: 'turn.end', seq: 4096 } })
    const afterFrames = await identity.ensureBotIdentity('x-manager')

    // Every check costs a DELETE/POST/read-back/test in Electron, so event movement must never
    // be a reason to delete and re-register a profile's MCP entries.
    expect(afterFrames.ready).toBe(true)
    expect(asksFor('x-manager')).toBe(1)
  })

  test('reconnecting on one machine leaves another machine\'s proof alone', async () => {
    askSequence({ ready: true })

    await identity.ensureBotIdentity('x-manager@hb7k2q9x')
    gateway.emitReconnect()
    const remote = await identity.ensureBotIdentity('x-manager@hb7k2q9x')

    // The main socket said nothing about the added machine, so its proof stands.
    expect(remote.ready).toBe(true)
    expect(asksFor('x-manager@hb7k2q9x')).toBe(1)
  })
})

describe('a proof belongs to the Hermes it was made against', () => {
  test('the same profile name on two machines is two proofs', async () => {
    answerAs(async (who: string) =>
      who === 'forge@hbbbbbbb' ? { ready: false, error: 'not registered on that machine' } : { ready: true })

    const main = await identity.ensureBotIdentity('forge')
    const remote = await identity.ensureBotIdentity('forge@hbbbbbbb')

    expect(main.ready).toBe(true)
    expect(remote.ready).toBe(false)
    expect(asksFor('forge')).toBe(1)
    expect(asksFor('forge@hbbbbbbb')).toBe(1)
  })

  test('a suffixed profile asks about the machine it is addressed to, not the main one', async () => {
    const seen: string[] = []
    answerAs(async (who: string) => {
      seen.push(who)

      return { ready: true }
    })

    await identity.ensureBotIdentity('forge@hbbbbbbb')

    // The main gateway's connection state says nothing about another Hermes, so a proof that only
    // watched the main socket would let an unproven remote profile send its first turn.
    expect(seen).toEqual(['forge@hbbbbbbb'])
  })

  test('a different address for the same profile invalidates its proof', async () => {
    askSequence({ ready: true })

    await identity.ensureBotIdentity('x-manager')
    $active.set({ ...$active.get()!, baseUrl: 'http://elsewhere.test:8642' })
    answerAs(async () => ({ ready: false, error: 'a different Hermes' }))
    const afterMove = await identity.ensureBotIdentity('x-manager')

    expect(afterMove.ready).toBe(false)
    expect(asksFor('x-manager')).toBe(2)
  })

  test('each profile keeps its own proof', async () => {
    askSequence({ ready: true })

    await identity.ensureBotIdentity('x-manager')
    $active.set({ ...$active.get()!, baseUrl: 'http://elsewhere.test:8642' })
    await identity.ensureBotIdentity('y-recruiter')
    $active.set({ ...$active.get()!, baseUrl: 'http://third.test:8642' })
    await identity.ensureBotIdentity('z-coder')

    // Three Hermeses, three bots, one check each — proving one says nothing about the others.
    expect(asksFor('x-manager')).toBe(1)
    expect(asksFor('y-recruiter')).toBe(1)
    expect(asksFor('z-coder')).toBe(1)
  })
})

describe('a discarded proof can neither answer nor overwrite', () => {
  test('a late affirmative from a forgotten check does not authorize a new turn', async () => {
    const stale = deferred<Verdict>()
    let first = true
    answerAs(async () => {
      if (first) {
        first = false

        return stale.promise
      }

      return { ready: false, error: 'the fresh check refused' }
    })

    const abandoned = identity.ensureBotIdentity('x-manager')
    identity.forgetBotIdentity('x-manager')
    const fresh = identity.ensureBotIdentity('x-manager')

    // The abandoned check answers affirmatively after the fact; that answer belongs to a proof
    // nobody holds any more, so it must not let this turn through.
    stale.resolve({ ready: true })
    await abandoned
    const verdict = await fresh

    expect(verdict.ready).toBe(false)
    expect(asksFor('x-manager')).toBe(2)
  })

  test('a late affirmative from a forgotten check does not repopulate the cache', async () => {
    const stale = deferred<Verdict>()
    let first = true
    answerAs(async () => {
      if (first) {
        first = false

        return stale.promise
      }

      return { ready: false, error: 'the fresh check refused' }
    })

    const abandoned = identity.ensureBotIdentity('x-manager')
    identity.forgetBotIdentity('x-manager')
    const fresh = identity.ensureBotIdentity('x-manager')
    stale.resolve({ ready: true })
    await Promise.all([abandoned, fresh])

    // The next turn has to ask again: the late answer must not have left a proof behind.
    answerAs(async () => ({ ready: false, error: 'still not proven' }))
    const next = await identity.ensureBotIdentity('x-manager')

    expect(next.ready).toBe(false)
    expect(asksFor('x-manager')).toBe(3)
  })

  test('a late refusal from a forgotten check does not spoil the newer check', async () => {
    const stale = deferred<Verdict>()
    let first = true
    answerAs(async () => {
      if (first) {
        first = false

        return stale.promise
      }

      return { ready: true }
    })

    const abandoned = identity.ensureBotIdentity('x-manager')
    identity.forgetBotIdentity('x-manager')
    const fresh = identity.ensureBotIdentity('x-manager')
    stale.resolve({ ready: false, error: 'the abandoned check refused' })
    await Promise.all([abandoned, fresh])

    expect((await fresh).ready).toBe(true)
    // And the proof the newer check earned is still worth something.
    answerAs(async () => ({ ready: false, error: 'must not be asked' }))
    expect((await identity.ensureBotIdentity('x-manager')).ready).toBe(true)
    expect(asksFor('x-manager')).toBe(2)
  })

  test('old cleanup does not delete a newer pending check', async () => {
    const slow = deferred<Verdict>()
    let first = true
    answerAs(async () => {
      if (first) {
        first = false

        return slow.promise
      }

      return { ready: true }
    })

    const abandoned = identity.ensureBotIdentity('x-manager')
    identity.forgetBotIdentity('x-manager')
    // The replacement starts while the discarded one is still open, so both are in flight at once.
    const fresh = identity.ensureBotIdentity('x-manager')
    slow.resolve({ ready: true })
    await Promise.all([abandoned, fresh])

    // The newer check is still the one waiting in the map: the old cleanup must not have removed it
    // and let a third turn start a second one beside it.
    answerAs(async () => ({ ready: false, error: 'must not be asked' }))
    const joined = await identity.ensureBotIdentity('x-manager')

    expect(joined.ready).toBe(true)
    expect(asksFor('x-manager')).toBe(2)
    expect((await fresh).ready).toBe(true)
  })

  test('a reconnect mid-check fences that check', async () => {
    const slow = deferred<Verdict>()
    answerAs(async () => slow.promise)

    const interrupted = identity.ensureBotIdentity('x-manager')
    gateway.emitReconnect()
    answerAs(async () => ({ ready: false, error: 'the replacement connection refused' }))
    const fresh = identity.ensureBotIdentity('x-manager')
    slow.resolve({ ready: true })
    await Promise.all([interrupted, fresh])
    const verdict = await fresh

    expect(verdict.ready).toBe(false)
    expect(asksFor('x-manager')).toBe(2)
  })
})

describe('an added machine\'s own link carries its own proofs', () => {
  /**
   * These adopt a real machine through `hosts.addMachine()`, so `gatewayForHost()` resolves to that
   * machine's own Gateway and endpoint instead of falling back to the host id alone. Without a real
   * adoption the `extras` branch of `scopeOf()` is never taken and a suffixed bot's proof silently
   * rides on nothing — which is how a remote reconnect could go unnoticed for a whole suite.
   *
   * The machine is left unconnected on purpose: `wsUrlOf` yields '', so `connect()` fails fast and no
   * socket is opened. What matters here is the socket a proof was made on, not a live connection.
   */
  let machine = ''

  beforeEach(async () => {
    machineSettings = { connections: [], machines: [] }
    const settings = machineSettings

    ;(native as any).getSettings = async () => settings
    ;(native as any).setSettings = async (patch: any) => {
      Object.assign(settings, patch)

      return true
    }
    ;(native as any).computerSyncProfiles = async () => ({ ok: true, done: [] })
    hosts.useEndpointResolver(async () => ({ baseUrl: 'http://second-machine.test:8642', token: 'remote' }), () => '')
    machine = await adoptMachine()
    remote = hosts.gatewayForHost(machine)!.gw
  })

  afterEach(async () => {
    await hosts.removeMachine(machine)
    remote = null
  })

  test('an added machine is reachable by its own host id, not the null fallback', () => {
    const target = hosts.gatewayForHost(machine)

    // The scope of `forge@<this>` is built from this socket's generation and this address. If it
    // resolved to null there is nothing here to tell one remote link from another.
    expect(target).not.toBeNull()
    expect(target!.gw).toBe(remote)
    expect(target!.endpoint?.baseUrl).toBe('http://second-machine.test:8642')
  })

  test('a suffixed bot\'s proof is answered by its own machine, not the main one', async () => {
    askSequence({ ready: true })

    const first = await identity.ensureBotIdentity(`forge@${machine}`)

    // Re-dialling the same Hermes leaves the scope string byte-identical, because the generation is
    // bumped only by connect()/close(). Only the reconnect itself can retire the proof, so a bot
    // whose socket died must not keep answering from the affirmative made on it.
    answerAs(async () => ({ ready: false, error: 'the replacement remote link is unproven' }))
    remote!.emitReconnect()
    const afterReconnect = await identity.ensureBotIdentity(`forge@${machine}`)

    expect(first.ready).toBe(true)
    expect(afterReconnect.ready).toBe(false)
    expect(asksFor(`forge@${machine}`)).toBe(2)
  })

  test('a reconnect on the added machine fences a check that was in flight on it', async () => {
    const slow = deferred<Verdict>()

    // Nothing proven yet, so this ask really is in flight rather than answered from the cache.
    answerAs(async () => slow.promise)
    const interrupted = identity.ensureBotIdentity(`forge@${machine}`)
    remote!.emitReconnect()
    answerAs(async () => ({ ready: false, error: 'the fresh remote check refused' }))
    const fresh = identity.ensureBotIdentity(`forge@${machine}`)
    slow.resolve({ ready: true })
    await Promise.all([interrupted, fresh])

    // The late affirmative came from the dead socket. Letting it through would authorize a turn on a
    // link this app has not proven any more, so the replacement check is the one that has to answer.
    expect((await fresh).ready).toBe(false)
    expect(asksFor(`forge@${machine}`)).toBe(2)
  })

  test('an unchanged remote link still caches one affirmative answer', async () => {
    askSequence({ ready: true })

    await identity.ensureBotIdentity(`forge@${machine}`)
    // Real frames and a moved sequence on the same socket. Every check costs a DELETE/POST/read-back
    // /test in Electron, so event movement must never be a reason to re-ask a remote bot either.
    remote!.dispatch({ type: 'sessions.changed' })
    ;(remote as any).handleFrame({ method: 'event', params: { type: 'turn.end', seq: 4096 } })
    const afterFrames = await identity.ensureBotIdentity(`forge@${machine}`)

    expect(afterFrames.ready).toBe(true)
    expect(asksFor(`forge@${machine}`)).toBe(1)
  })

  test('the main machine\'s reconnect leaves the added machine\'s proof alone', async () => {
    askSequence({ ready: true })

    await identity.ensureBotIdentity(`forge@${machine}`)
    gateway.emitReconnect()
    const remote = await identity.ensureBotIdentity(`forge@${machine}`)

    // Two different Hermeses: the main socket says nothing about the other one's registration.
    expect(remote.ready).toBe(true)
    expect(asksFor(`forge@${machine}`)).toBe(1)
  })

  test('one added machine\'s reconnect leaves another machine\'s proof alone', async () => {
    // A second machine, adopted the same way, so "one machine's link died" is not the only reading
    // of the same event.
    machineSettings = { connections: [], machines: [] }
    ;(native as any).getSettings = async () => machineSettings
    ;(native as any).setSettings = async (patch: any) => {
      Object.assign(machineSettings, patch)

      return true
    }
    const otherMachine = await adoptMachine()

    askSequence({ ready: true })
    await identity.ensureBotIdentity(`forge@${otherMachine}`)

    // The first machine re-dialled; the second is a different Hermes and did not.
    remote!.emitReconnect()
    const still = await identity.ensureBotIdentity(`forge@${otherMachine}`)

    // Two Hermeses: the machine that re-dialled says nothing about whether the other one still has
    // this profile registered, so its affirmative stands and costs no re-registration.
    expect(still.ready).toBe(true)
    expect(asksFor(`forge@${otherMachine}`)).toBe(1)
    // While the machine that actually lost its link does have to ask again.
    expect(asksFor(`forge@${machine}`)).toBe(0)

    await hosts.removeMachine(otherMachine)
  })

  test('the same profile name on the main and the added machine stays two proofs', async () => {
    let first = true

    answerAs(async () => {
      if (first) {
        first = false

        return { ready: true }
      }

      return { ready: false, error: 'not registered on the second machine' }
    })

    const main = await identity.ensureBotIdentity('forge')
    const second = await identity.ensureBotIdentity(`forge@${machine}`)

    expect(main.ready).toBe(true)
    expect(second.ready).toBe(false)
    expect(asksFor('forge')).toBe(1)
    expect(asksFor(`forge@${machine}`)).toBe(1)
  })

  test('a remote proof still stands after an unrelated bot\'s check is forgotten', async () => {
    askSequence({ ready: true })

    await identity.ensureBotIdentity(`forge@${machine}`)
    identity.forgetBotIdentity('someone-else')
    const again = await identity.ensureBotIdentity(`forge@${machine}`)

    // Forgetting one bot says nothing about another, on any machine.
    expect(again.ready).toBe(true)
    expect(asksFor(`forge@${machine}`)).toBe(1)
  })
})

describe('cards and answers stay with the profile that asked', () => {
  test('a card asked by B is filed under B only', async () => {
    askActions.botAsk('x-manager', { prompt: 'mine?', options: [{ label: 'ok' }] })

    expect(ask.chatCards('bot:x-manager').length).toBe(1)
    expect(ask.chatCards('bot:default').length).toBe(0)
  })

  test('B\'s question is answered to B while A is the visible chat', async () => {
    askActions.botAsk('x-manager', { prompt: 'mine?', options: [{ label: 'ok' }] })
    const card = ask.chatCards('bot:x-manager').slice(-1)[0]

    // The view is A's chat — the answer must still go to the profile that asked.
    askActions.userAnswer({ kind: 'bot', name: 'default' }, card, ['ok'], '')
    await flush()

    expect(sentTo()).toBe('x-manager')
  })

  test('A cannot answer B\'s card by passing its own view', async () => {
    askActions.botAsk('x-manager', { prompt: 'mine?', options: [{ label: 'ok' }] })
    const card = ask.chatCards('bot:x-manager').slice(-1)[0]

    askActions.userAnswer({ kind: 'bot', name: 'default' }, { ...card, owner: 'default' }, ['ok'], '')
    await flush()

    // B's stored card is still open: A's forged owner did not close it.
    expect(ask.chatCards('bot:x-manager').filter(c => c.status === 'open').length).toBe(1)
  })

  test('an unproven profile cannot answer, because the answer is a turn', async () => {
    askActions.botAsk('x-manager', { prompt: 'mine?', options: [{ label: 'ok' }] })
    const card = ask.chatCards('bot:x-manager').slice(-1)[0]
    setIdentity({ ready: false, error: 'refused' })

    askActions.userAnswer({ kind: 'bot', name: 'x-manager' }, card, ['ok'], '')
    await flush()

    expect(submits().length).toBe(0)
  })

  test('secret and help controls keep the asking profile when the view differs', async () => {
    secretActions.botRequestSecret('x-manager', { prompt: 'a key', name: 'OPENAI_API_KEY' })
    const [secret] = secrets.chatSecretCards('bot:x-manager')

    expect(secret.owner).toBe('x-manager')
    // Saved as if the user was looking at default's chat: it must still go to x-manager.
    await secretActions.userSaveSecret('default', secret, 'sk-test').catch(() => undefined)
    await flush()
    expect(secrets.chatSecretCards('bot:default').filter(c => c.status === 'saved').length).toBe(0)

    handoffActions.botRequestHelp('x-manager', { instruction: 'sign in and approve the 2FA prompt' })
    const [help] = handoff.chatHelpCards('bot:x-manager')
    handoffActions.openHandoff('default', help)

    expect((handoff.$handoff.get() as any)?.bot).toBe('x-manager')
  })
})

describe('inbound user text goes to the addressed agent', () => {
  test('a typed message is submitted to the bot it was addressed to', async () => {
    await chat.sendToBot('x-manager', 'this is for you')
    await flush()

    const all = submits()

    expect(all.length).toBe(1)
    expect(all[0].params.profile).toBe('x-manager')
    expect(all[0].params.session_id).toContain('x-manager')
    expect(all[0].params.text).toContain('this is for you')
  })

  test('the same text to a different bot lands on that different bot', async () => {
    const text = 'a question with no owner of its own'

    await chat.sendToBot('x-manager', text)
    await chat.sendToBot('default', text)
    await flush()

    expect(submits().map(c => String(c.params.profile))).toEqual(['x-manager', 'default'])
    // Separate sessions: the routing is not just the profile field on one reused session.
    expect(submits()[0].params.session_id).not.toBe(submits()[1].params.session_id)
  })

  test('a bot that is not confirmed receives no user text at all', async () => {
    setIdentity({ ready: false, error: 'refused' })

    await chat.sendToBot('x-manager', 'private text')
    await flush()

    const bodies = JSON.stringify(calls)
    // Unconfirmed means the text is not transmitted.
    expect(bodies.includes('private text')).toBe(false)
  })
})