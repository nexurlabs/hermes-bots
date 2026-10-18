'use strict'
/**
 * A profile's MCP entry must be that profile's own before its first turn.
 *
 * `profile_cmd --clone` copies config.yaml, so a freshly cloned profile can arrive already carrying
 * default's groups URL *and* default's bearer together. registerMcp deletes then posts the correct
 * pair, but a POST that fails is only logged — the inherited pair is left in place and nothing
 * reports it. These tests pin the missing half: the registration has to be verified, and a profile
 * whose entry cannot be corrected must not be treated as ready.
 *
 * Only the HTTP boundary is faked; the registration function under test is the real one, extracted so
 * it can be driven without booting Electron.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')

/** A whole top-level function from the real source, brace-matched so the slice is always complete. */
const sliceFunction = (source, name) => {
  const at = source.indexOf(`function ${name}(`)
  assert.notEqual(at, -1, `${name} must exist in electron/main.cjs`)

  // Keep a leading `async`, or the slice stops being the function the app runs.
  const start = source.slice(Math.max(0, at - 6), at) === 'async ' ? at - 6 : at
  const open = source.indexOf('{', at)
  let depth = 0
  let end = -1

  for (let at = open; at < source.length; at++) {
    const ch = source[at]

    if (ch === '{') depth++
    else if (ch === '}') {
      depth--

      if (depth === 0) {
        end = at + 1
        break
      }
    }
  }

  assert.notEqual(end, -1, `${name} must close`)

  return source.slice(start, end)
}

/**
 * The real registration logic, in a form that can be driven without an Electron app around it.
 * `confirmMcpEntry` is loaded alongside `registerMcp` because the caller really does call it — a
 * test that replaced it with a stub would be testing a different function than the app runs.
 */
const loadRegistration = source =>
  // eslint-disable-next-line no-new-func
  new Function(
    'fetch',
    'dbg',
    `${sliceFunction(source, 'confirmMcpEntry')}\n${sliceFunction(source, 'registerMcp')}\nreturn registerMcp`
  )

const MAIN = require('node:fs').readFileSync(require.resolve('../electron/main.cjs'), 'utf8')

const GROUPS_URL = 'http://127.0.0.1:9999/groups/x-manager'

/**
 * A fake Hermes that records what it was asked to do. `stored` is the entry Hermes reports back on
 * GET, which is the whole point: a clone's entry is readable and still wrong.
 */
function harness(behaviour = {}) {
  const seen = { deleted: [], posted: [], verified: [], listed: [] }
  const storedUrl = behaviour.storedUrl === undefined ? 'http://127.0.0.1:9999/groups/x-manager' : behaviour.storedUrl
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const method = init.method || 'GET'

    if (method === 'DELETE') {
      seen.deleted.push(u)

      return new Response('', { status: 204 })
    }

    // Reading the profile's own entry back: GET /api/mcp/servers?profile=<name> lists that
    // profile's servers, which is how the app confirms what landed without holding any secret.
    if (method === 'GET' && /api\/mcp\/servers/.test(u)) {
      seen.listed.push(u)

      if (behaviour.listStatus !== undefined && behaviour.listStatus !== 200) {
        return new Response('{}', { status: behaviour.listStatus })
      }

      const servers =
        behaviour.servers === undefined
          ? [{ name: 'hermes-bots-groups', transport: 'http', url: storedUrl, auth: 'header', enabled: true, source: 'config' }]
          : behaviour.servers

      return new Response(JSON.stringify({ servers }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    // Hermes confirms a registration with a per-server test POST: .../mcp/servers/<name>/test.
    if (method === 'POST' && /api\/mcp\/servers\/[^/?]+\/test/.test(u)) {
      seen.verified.push(u)

      if (behaviour.testThrows) {
        throw new Error('connection refused')
      }

      if (behaviour.testBody !== undefined) {
        return new Response(behaviour.testBody, { status: behaviour.testStatus || 200 })
      }

      return new Response(JSON.stringify(behaviour.test || { ok: true, tools: [] }), {
        status: behaviour.testStatus || 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    if (method === 'POST' && /api\/mcp\/servers/.test(u)) {
      seen.posted.push({ url: u, body: JSON.parse(String(init.body || '{}')) })

      const status = behaviour.postStatus === undefined ? 200 : behaviour.postStatus

      return new Response(behaviour.postBody || '{"ok":true}', { status })
    }

    return new Response('{}', { status: 404 })
  }

  return { seen, fetchImpl, registerMcp: loadRegistration(MAIN)(fetchImpl, () => undefined, () => undefined) }
}

const link = { baseUrl: 'http://127.0.0.1:9999/', hermesToken: 'root', mcpUrl: 'http://127.0.0.1:9999/mcp', mcpToken: 'pc' }
const groups = (h, profile = 'x-manager', url = GROUPS_URL, bearer = 'bearer-for-x') =>
  h.registerMcp(link, profile, 'hermes-bots-groups', url, bearer)

test('registerMcp writes the profile\'s own url and bearer, not an inherited pair', async () => {
  const h = harness()
  await h.registerMcp(link, 'x-manager', 'hermes-bots-groups', 'http://127.0.0.1:9999/groups/x-manager', 'bearer-for-x')

  assert.equal(h.seen.posted.length, 1)
  assert.equal(h.seen.posted[0].body.url, 'http://127.0.0.1:9999/groups/x-manager')
  assert.equal(h.seen.posted[0].body.bearer_token, 'bearer-for-x')
  assert.match(h.seen.posted[0].url, /profile=x-manager/)
})

test('a successful registration is verified afterwards', async () => {
  const h = harness()
  await h.registerMcp(link, 'x-manager', 'hermes-bots-groups', 'http://127.0.0.1:9999/groups/x-manager', 'bearer-for-x')

  // Writing is not the same as landing: the app has to confirm the profile's own entry is what the
  // profile will actually use, so a clone that kept default's pair is caught rather than assumed away.
  assert.equal(h.seen.verified.length, 1, 'the registration must be verified after it is written')
})

test('a registration that does not land is reported as a failure', async () => {
  const h = harness({ postStatus: 500 })
  const ok = await h.registerMcp(link, 'x-manager', 'hermes-bots-groups', 'http://127.0.0.1:9999/groups/x-manager', 'bearer-for-x')

  assert.equal(ok, false, 'a failed registration must not report success')
})

test('a write that succeeds but does not verify is not reported as ready', async () => {
  const h = harness({ test: { ok: false, error: 'url and bearer do not match' } })
  const ok = await h.registerMcp(link, 'x-manager', 'hermes-bots-groups', 'http://127.0.0.1:9999/groups/x-manager', 'bearer-for-x')

  assert.equal(ok, false, 'an unverified entry must not be reported as ready')
})

test('the inherited pair is deleted before the profile\'s own is written', async () => {
  const h = harness()
  await h.registerMcp(link, 'x-manager', 'hermes-bots-groups', 'http://127.0.0.1:9999/groups/x-manager', 'bearer-for-x')

  assert.equal(h.seen.deleted.length, 1, 'the cloned entry must be removed first')
  assert.match(h.seen.deleted[0], /hermes-bots-groups/)
  assert.match(h.seen.deleted[0], /profile=x-manager/)
})

test('the default profile is not scoped, and is verified like any other', async () => {
  const h = harness({ storedUrl: 'http://127.0.0.1:9999/groups/default' })
  await h.registerMcp(link, 'default', 'hermes-bots-groups', 'http://127.0.0.1:9999/groups/default', 'bearer-for-default')

  assert.doesNotMatch(h.seen.posted[0].url, /profile=/)
  assert.equal(h.seen.listed.length, 1)
  assert.doesNotMatch(h.seen.listed[0], /profile=/, 'default is read back unscoped, like it is written')
  assert.equal(h.seen.verified.length, 1)
})

// ── Fail closed ─────────────────────────────────────────────────────────────
// Everything below is a registration that cannot be called proven. Reporting any of them as ready
// is the defect: the profile would go on to use an entry nobody checked.

test('control: a verified entry with the profile\'s own pair is ready', async () => {
  const h = harness()

  assert.equal(await groups(h), true, 'the known-good case must pass, or nothing below means anything')
})

test('a verification answered with HTTP 500 is not ready', async () => {
  const h = harness({ testStatus: 500, testBody: '{}' })

  assert.equal(await groups(h), false, 'a 500 leaves the entry unproven')
})

test('a verification whose body is not JSON is not ready', async () => {
  const h = harness({ testStatus: 200, testBody: 'not-json' })

  assert.equal(await groups(h), false, 'unparseable JSON must not fall through to ready')
})

test('a verification that returns no affirmative ok is not ready', async () => {
  const h = harness({ testStatus: 200, testBody: '{"tools":[]}' })

  assert.equal(await groups(h), false, 'absent ok is absent proof, not success')
})

test('control: an explicit refusal is not ready', async () => {
  const h = harness({ test: { ok: false, error: 'url and bearer do not match' } })

  assert.equal(await groups(h), false)
})

test('a verification Hermes could not answer at all is not ready', async () => {
  const h = harness({ testThrows: true })

  assert.equal(await groups(h), false, 'unavailable is unproven, not broken and not ready')
})

test('an entry still pointing at the inherited route is not ready', async () => {
  // The clone's case: the POST was accepted but the profile kept default's URL, so a connection
  // test succeeds — as default — and says nothing about who this profile will be.
  const h = harness({ storedUrl: 'http://127.0.0.1:9999/groups/default' })

  assert.equal(await groups(h), false, "the profile's own route must be confirmed, not assumed")
})

test('a profile whose entry cannot be read back is not ready', async () => {
  const h = harness({ listStatus: 500 })

  assert.equal(await groups(h), false, 'an unreadable entry cannot be confirmed')
})

test('a profile whose entry is missing entirely is not ready', async () => {
  const h = harness({ servers: [] })

  assert.equal(await groups(h), false, 'a deleted entry is not a working entry')
})

test('a disabled entry is not ready', async () => {
  const h = harness({ servers: [{ name: 'hermes-bots-groups', url: GROUPS_URL, enabled: false }] })

  assert.equal(await groups(h), false, 'a disabled entry will never be called')
})

test('the entry is confirmed against the profile that was written, not another', async () => {
  const h = harness()

  await groups(h, 'x-manager')

  assert.equal(h.seen.listed.length, 1, "the profile's own entry must be read back")
  assert.match(h.seen.listed[0], /profile=x-manager/)
})