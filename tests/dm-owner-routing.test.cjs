'use strict'
/**
 * A card belongs to the profile that asked for it, whoever is looking at the screen.
 *
 * A card is stored per chat (`bot:<profile>`) but the AskCard carried no owner, so the renderer
 * answered it using the name of whichever bot's chat was on screen. These tests drive the real
 * authenticated groups HTTP route with real per-profile tokens — no stubbed route, no mocked
 * handler — so a card's owner is decided by the bearer the call presented, exactly as in the app.
 */
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const childProcess = require('node:child_process')
const { test } = require('node:test')

function fakePowerShell(command, args) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.stdin = {
    writable: true,
    write(data) {
      if (args.includes('-Command')) {
        queueMicrotask(() => child.emit('exit', 1))
        return true
      }
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('@@R@@{"ok":true}\n')))
      return true
    },
    end() { this.writable = false }
  }
  child.kill = () => { child.killed = true; child.emit('exit', 0) }
  assert.equal(command, 'powershell.exe')
  return child
}

/**
 * Starts the real groups server. `setAppToolHandler` stands in for the renderer: it records which
 * profile each call arrived as, which is what the renderer would go on to use.
 */
async function fixture(t, spawnImpl = fakePowerShell) {
  t.mock.method(childProcess, 'spawn', spawnImpl)
  const modulePath = require.resolve('../electron/local-computer.cjs')
  delete require.cache[modulePath]
  const bridge = require(modulePath)
  const { port, token } = await bridge.startServer()
  t.after(() => { bridge.stopServer(); delete require.cache[modulePath] })

  const seen = []
  bridge.setAppToolHandler(async (profile, name, args) => {
    seen.push({ profile, name, args })
    return { ok: true, text: `asked as ${profile}` }
  })

  /** Calls the groups route AS `profile`, using that profile's own token — the identity under test. */
  const askAs = async (profile, tool, args) => {
    const response = await fetch(`http://127.0.0.1:${port}/groups/${encodeURIComponent(profile)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridge.groupToken(profile)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } })
    })
    return { status: response.status, body: await response.json() }
  }

  const bare = async (path, auth, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }

  return { bridge, token, askAs, bare, seen }
}

const askCall = (args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_user', arguments: args } })

test('a card asked by one profile is never stored under another', async t => {
  const { askAs, seen } = await fixture(t)

  // A -> B -> A: default asks, then x-manager asks, then default asks again.
  await askAs('default', 'ask_user', { prompt: 'from A', options: [{ label: 'ok' }] })
  await askAs('x-manager', 'ask_user', { prompt: 'from B', options: [{ label: 'ok' }] })
  await askAs('default', 'ask_user', { prompt: 'from A again', options: [{ label: 'ok' }] })

  // Every call must reach the renderer as the profile that presented that profile's token.
  assert.deepEqual(seen.map(call => call.profile), ['default', 'x-manager', 'default'])
  assert.deepEqual(seen.map(call => call.args.prompt), ['from A', 'from B', 'from A again'])
})

test("one profile's token is refused on another profile's route", async t => {
  const { token, bare } = await fixture(t)

  // This is the shape a cloned config.yaml takes: default's bearer on another profile's route.
  const crossed = await bare('/groups/x-manager', token, askCall({ prompt: 'should not be allowed', options: [{ label: 'ok' }] }))

  assert.equal(crossed.status, 401)
  assert.equal(crossed.body.error, 'unauthorized')
})

test('each profile gets its own token, so a route cannot be answered with the wrong identity', async t => {
  const { bridge } = await fixture(t)

  assert.notEqual(bridge.groupToken('default'), bridge.groupToken('x-manager'))
  assert.notEqual(bridge.groupToken('default'), bridge.groupToken('a'))
})

test('a card carries the profile that asked, so a viewer cannot answer it for another bot', async t => {
  // The route hands the renderer a profile. That profile has to travel with the card, or the
  // renderer falls back to whichever chat happens to be on screen.
  const { askAs, seen } = await fixture(t)

  await askAs('x-manager', 'ask_user', { prompt: 'x only', options: [{ label: 'ok' }] })

  assert.equal(seen.length, 1)
  assert.equal(seen[0].profile, 'x-manager')
  // The profile is the caller's authenticated identity and nothing else may override it.
  assert.equal(seen[0].args.profile, undefined)
})

test('a first turn cannot be answered as default before the profile has its own route', async t => {
  const { askAs, token, bridge, bare } = await fixture(t)

  // Before x-manager is registered, default can still use its OWN route with its OWN groups token.
  // What must never happen is default's token being accepted on x-manager's route, which is the
  // shape a cloned config.yaml takes.
  const asDefault = await bare('/groups/default', bridge.groupToken('default'), askCall({ prompt: 'too early', options: [{ label: 'ok' }] }))
  assert.equal(asDefault.status, 200)

  const crossed = await bare('/groups/x-manager', bridge.groupToken('default'), askCall({ prompt: 'too early', options: [{ label: 'ok' }] }))
  assert.equal(crossed.status, 401)

  // The This PC token is a different secret again and must not open any groups route.
  const withPcToken = await bare('/groups/default', token, askCall({ prompt: 'nope', options: [{ label: 'ok' }] }))
  assert.equal(withPcToken.status, 401)

  // Once x-manager is registered it can use its own route, and its card is its own.
  const own = await askAs('x-manager', 'ask_user', { prompt: 'now it is mine', options: [{ label: 'ok' }] })

  assert.equal(own.status, 200)
})

test('secret, help and approval controls follow the same identity rule', async t => {
  const { askAs, seen } = await fixture(t)

  for (const [tool, args] of [
    ['request_secret', { prompt: 'a key' }],
    ['request_user_help', { prompt: 'a login step' }]
  ]) {
    seen.length = 0
    const res = await askAs('x-manager', tool, args)

    assert.equal(res.status, 200, `${tool} should be served on its own route`)
    assert.equal(seen.length, 1, `${tool} should reach the renderer once`)
    assert.equal(seen[0].profile, 'x-manager', `${tool} must arrive as the caller`)
  }
})