'use strict'
/**
 * A malformed webhook signature is a 401, never a crash. A header whose string length matches the
 * expected `sha256=<64 hex>` but whose byte length doesn't (multi-byte characters) used to reach
 * crypto.timingSafeEqual with unequal buffers, which throws a RangeError inside req.on('end') and
 * takes the Electron main process down. The real hooks.cjs runs here with Electron faked out.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')

const hooks = require('../electron/hooks.cjs')

const freePort = () =>
  new Promise(resolve => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

const post = (port, token, headers, body) =>
  new Promise((resolve, reject) => {
    const raw = Buffer.from(body)
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/hooks/${token}`, headers: { 'Content-Length': raw.length, ...headers } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(raw)
  })

test('signatureOk never throws and only accepts the exact signature', () => {
  const want = 'sha256=' + 'a'.repeat(64)
  assert.equal(hooks.signatureOk(want, want), true)
  assert.equal(hooks.signatureOk('sha256=' + 'é'.repeat(64), want), false)
  assert.equal(hooks.signatureOk('', want), false)
  assert.equal(hooks.signatureOk(undefined, want), false)
  assert.equal(hooks.signatureOk('sha256=short', want), false)
})

test('a malformed signature gets 401 and the listener keeps serving', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'))
  const port = await freePort()
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ port, lan: false, hooks: {} }))

  const handlers = {}
  const uncaught = []
  const onUncaught = err => uncaught.push(err)
  process.on('uncaughtException', onUncaught)

  const listener = hooks.init({
    app: { getPath: () => dir, whenReady: () => new Promise(() => {}) },
    ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
    BrowserWindow: { getAllWindows: () => [] },
    seal: s => s,
    unseal: s => s
  })

  const secret = 'top-secret'
  const { token } = await handlers['hooks:put']({}, { bot: 'alpha', routineId: 'r1', kind: 'webhook', secret })
  t.after(async () => {
    process.off('uncaughtException', onUncaught)
    await handlers['hooks:remove']({}, token)
    await listener.stop()
  })

  const body = '{"hello":"world"}'
  const good = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  // Same string length as a real signature, different byte length.
  const multibyte = 'sha256=' + 'é'.repeat(64)
  assert.equal(multibyte.length, good.length)

  for (const sig of [multibyte, 'sha256=nothex', '', 'x'.repeat(5000), good.toUpperCase()]) {
    const res = await post(port, token, { 'Content-Type': 'application/json', ...(sig ? { 'X-Hub-Signature-256': sig } : {}) }, body)
    assert.equal(res.code, 401, `signature ${JSON.stringify(sig.slice(0, 20))} must be rejected`)
  }

  // Still alive: a correctly signed request reaches the (windowless) app.
  const ok = await post(port, token, { 'Content-Type': 'application/json', 'X-Hub-Signature-256': good }, body)
  assert.equal(ok.code, 503)
  assert.deepEqual(uncaught, [])
})
