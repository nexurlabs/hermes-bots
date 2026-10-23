'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { tokenCopyDirFor } = require('../electron/token-dir.cjs')

test('Windows keeps the token copy under LOCALAPPDATA', () => {
  assert.strictEqual(tokenCopyDirFor({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\sam\\AppData\\Local' }, home: 'C:\\Users\\sam', name: 'NexurBots' }), 'C:\\Users\\sam\\AppData\\Local\\NexurBots')
})
test('Linux and macOS have no DPAPI copy, so no Windows-style fallback path', () => {
  for (const platform of ['linux', 'darwin']) assert.strictEqual(tokenCopyDirFor({ platform, env: {}, home: '/home/sam', name: 'NexurBots' }), '')
})
test('smoke test never keeps a copy', () => {
  assert.strictEqual(tokenCopyDirFor({ platform: 'win32', env: {}, home: 'C:\\x', name: 'N', smoke: true }), '')
})
