'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { ensureGateway, parseEnsure, ENSURE_ARGS } = require('../electron/gateway-ensure.cjs')

test('ensure starts a gateway without --idle-exit', () => {
  assert.deepStrictEqual(ENSURE_ARGS.slice(0, 2), ['gateway', 'ensure'])
  assert.ok(!ENSURE_ARGS.some(a => /idle/.test(a)))
})
test('parseEnsure: exit 0 is ready', () => {
  assert.strictEqual(parseEnsure('{"state":"running"}', 0).ok, true)
  assert.strictEqual(parseEnsure('garbage', 1).ok, false)
})
test('ensureGateway runs hermes with HERMES_HOME and is single-flight', async () => {
  let calls = 0
  const run = (cmd, args, opts, cb) => { calls++; assert.strictEqual(opts.env.HERMES_HOME, '/h'); setTimeout(() => cb(null, '{"state":"running"}', ''), 10) }
  const [a, b] = await Promise.all([ensureGateway({ command: 'hermes', home: '/h', env: {}, run }), ensureGateway({ command: 'hermes', home: '/h', env: {}, run })])
  assert.strictEqual(a.ok, true); assert.strictEqual(b.ok, true); assert.strictEqual(calls, 1)
})
