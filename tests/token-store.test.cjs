// The copy of the This PC token outside the data folder (electron/token-store.cjs): written encrypted,
// read back only when it is what was written, and the token never on a command line.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const store = require('../electron/token-store.cjs')

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-token-'))
const TOKEN = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(16)

// Stands in for DPAPI: reversible, and nothing like the plain token.
function fakeRun(calls = []) {
  return async (script, input) => {
    calls.push({ script, input })
    if (script === store.PROTECT) return Buffer.from([...input].reverse().join('')).toString('base64')
    if (script === store.UNPROTECT) return [...Buffer.from(input, 'base64').toString()].reverse().join('')
    throw new Error('unexpected script')
  }
}

test('a saved copy reads back as the same token, and the file never holds it in plain text', async () => {
  const where = dir()
  assert.equal(await store.saveToken(where, TOKEN, fakeRun()), true)
  const raw = fs.readFileSync(path.join(where, store.FILE), 'utf8')
  assert.equal(raw.includes(TOKEN), false)
  assert.equal(await store.loadToken(where, fakeRun()), TOKEN)
})

test('the token goes to PowerShell on stdin, not in the command', async () => {
  const calls = []
  await store.saveToken(dir(), TOKEN, fakeRun(calls))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input, TOKEN)
  assert.equal(calls[0].script.includes(TOKEN), false)
})

test('copyMatches tells a current copy from a stale one without decrypting', async () => {
  const where = dir()
  const calls = []
  await store.saveToken(where, TOKEN, fakeRun(calls))
  assert.equal(store.copyMatches(where, TOKEN), true)
  assert.equal(store.copyMatches(where, 'z'.repeat(48)), false)
  assert.equal(store.copyMatches(dir(), TOKEN), false)
  assert.equal(calls.length, 1)
})

test('a missing, tampered or unreadable copy gives no token', async () => {
  assert.equal(await store.loadToken(dir(), fakeRun()), '')

  const where = dir()
  await store.saveToken(where, TOKEN, fakeRun())
  const file = path.join(where, store.FILE)
  const copy = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...copy, fingerprint: '0'.repeat(16) }))
  assert.equal(await store.loadToken(where, fakeRun()), '')

  fs.writeFileSync(file, 'not json')
  assert.equal(await store.loadToken(where, fakeRun()), '')
})

test('when encryption fails, saving reports it and reading gives no token', async () => {
  const failing = async () => {
    throw new Error('no DPAPI here')
  }
  const where = dir()
  assert.equal(await store.saveToken(where, TOKEN, failing), false)
  assert.equal(fs.existsSync(path.join(where, store.FILE)), false)
  await store.saveToken(where, TOKEN, fakeRun())
  assert.equal(await store.loadToken(where, failing), '')
})

test('real DPAPI round trip through PowerShell', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const where = dir()
  assert.equal(await store.saveToken(where, TOKEN), true)
  assert.equal(fs.readFileSync(path.join(where, store.FILE), 'utf8').includes(TOKEN), false)
  assert.equal(await store.loadToken(where), TOKEN)
})
