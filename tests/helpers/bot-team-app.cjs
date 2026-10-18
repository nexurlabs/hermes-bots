'use strict'
/**
 * Loads the app's real modules (TypeScript, ESM) inside the CommonJS `node --test`
 * runner and drives them without a browser or a Hermes socket.
 *
 * The renderer imports with extensionless specifiers (`./botconfig`), which Node's
 * CommonJS resolver cannot follow, so this registers a resolve hook that retries a
 * relative specifier with `.ts`. `localStorage` has to exist before any module is
 * loaded (approvals.ts reads it at module scope).
 *
 * Nothing here is app-specific plumbing for the tests to reach into: the tests call
 * the same exported functions the UI calls, and assert on what the app actually
 * dispatched or stored.
 */
const { registerHooks } = require('node:module')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context)
      } catch {
        return nextResolve(specifier, context)
      }
    }

    return nextResolve(specifier, context)
  }
})

const store = new Map()

const localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key),
  clear: () => store.clear(),
  keys: () => [...store.keys()]
}

globalThis.localStorage = localStorage

const root = `${__dirname}/../..`
const load = name => require(`${root}/src/lib/${name}.ts`)

const gateway = load('gateway').gateway
const store$ = load('store')
const rooms = load('rooms')
const team = load('team')

/**
 * Rooms are synced on a debounce, so a save can land after a test tore its fake down. The app's
 * real `request` would then reject "Not connected to Hermes" and log a sync error long after the
 * suite finished, so once a test has run, requests resolve harmlessly for the rest of the
 * process: no socket is ever dialled, and a late storage sync is simply a no-op.
 */
const quietRequest = async () => ({})
const seal = () => {
  gateway.request = quietRequest
}

/** A Hermes profile row the app turns into a bot. */
function profile(name, display, { lead = false, label = '', description = '' } = {}) {
  return {
    name,
    display_name: display,
    ui_meta: {
      'hermes-bots': {
        title: display,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        ...(lead ? { lead: true } : {})
      }
    }
  }
}

/**
 * A fake gateway that records every request and lets a test choose each member's
 * reply. A reply of 'KEEP' leaves that turn open, so the test can decide when it
 * ends (used to line several members up before any of them replies).
 */
function fakeGateway({ replies = [] } = {}) {
  const pending = []
  const seen = { submits: [], methods: [], requests: [] }
  const original = gateway.request
  // The main machine counts as online only while the link is open, as in the app.
  const priorState = gateway.state.get()
  gateway.state.set('open')

  gateway.request = async (method, params = {}) => {
    seen.methods.push(method)
    seen.requests.push({ method, params })

    if (method === 'session.create' || method === 'session.resume') {
      return { session_id: runtimeOf(params.profile), stored_session_id: `stored:${params.profile}`, messages: [], running: false }
    }

    if (method === 'prompt.submit') {
      seen.submits.push({ profile: params.profile, text: params.text, session: params.session_id })

      const reply = replies.length ? replies.shift() : '(pass)'

      if (reply !== 'KEEP') {
        queueMicrotask(() => completeTurn(runtimeOf(params.profile), reply))
      }

      return { queued: true }
    }

    return {}
  }

  const completeTurn = (runtime, text) => {
    for (const event of [
      { type: 'message.start' },
      { type: 'message.delta', payload: { text } },
      { type: 'message.complete', payload: { text } }
    ]) {
      for (const listener of [...gateway.listeners]) listener({ ...event, session_id: runtime })
    }
  }

  /** Ends the turn `profile` was left open on (a 'KEEP' reply). */
  const release = (profile, text) => completeTurn(runtimeOf(profile), text)

  gateway.listenersAccessible = seen
  gateway.restore = () => {
    gateway.request = original
    gateway.state.set(priorState)
  }

  const runtimeOf = profile => `runtime:${profile}`

  /**
   * Hands the process back a harmless no-op instead of the real gateway: a room save still on
   * its debounce would otherwise reject "Not connected to Hermes" and print a sync error after
   * the suite, and each test installs its own fake anyway.
   */
  return { seen, release, restore: seal }
}

/** The bots a test wants the roster to hold, and puts them there. */
function roster(rows) {
  store$.$profiles.set(rows)
  store$.$userName.set('You')

  return rows
}

const bots = {
  kacy: profile('default', 'Kacy', { lead: true, label: 'Lead', description: 'Keeps the team moving.' }),
  scout: profile('scout', 'Scout', { label: 'Researcher', description: 'Reads and checks things.' })
}

/** A directory block for one bot, built exactly as the app builds it. */
function directory(me, overrides = {}) {
  return team.directoryText({
    me,
    bots: store$.$allBots.get(),
    rooms: team.allRooms(),
    busy: {},
    online: true,
    machine: 'Hermes server',
    user: 'You',
    facts: [],
    canRemember: true,
    memoryEdits: [],
    canSchedule: false,
    appTools: false,
    sharedFolder: '',
    ...overrides
  })
}

/**
 * Drops what each session was last sent, so a test sees the full directory again (the app
 * only resends it when it changes). Without this a later test would see only the one-line
 * "now" status and could not assert on the directory at all.
 */
function forgetDirectory() {
  for (const key of localStorage.keys().filter(key => key.startsWith('team:'))) {
    localStorage.removeItem(key)
  }
}

/** Waits for the room's scheduling loop to settle (or gives up). */
async function settle(ms = 750) {
  const started = Date.now()

  while (Date.now() - started < ms) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

module.exports = { gateway, store: store$, rooms, team, profile, fakeGateway, roster, bots, directory, settle, forgetDirectory }