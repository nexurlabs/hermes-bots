'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { checkKeyFile, explainKeyError } = require('../electron/ssh-key.cjs')

const errFs = code => ({ openSync() { throw Object.assign(new Error(code), { code }) } })
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-key-'))

test('a .pub path is a public key; points at the name without .pub', () => {
  const msg = checkKeyFile('C:\\Users\\me\\.ssh\\id_ed25519.pub')
  assert.match(msg, /is a public key/)
  assert.match(msg, /id_ed25519, the same name without \.pub/)
})

test('a file whose content starts with ssh- is a public key', () => {
  const f = path.join(dir, 'mykey')
  fs.writeFileSync(f, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample me@pc\n')
  assert.match(checkKeyFile(f), /is a public key/)
})

test('a private key passes', () => {
  const f = path.join(dir, 'id_ok')
  fs.writeFileSync(f, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n')
  assert.equal(checkKeyFile(f), null)
})

test('ENOENT says not found; EACCES/EPERM say not readable by this Windows account', () => {
  assert.match(checkKeyFile('k', errFs('ENOENT')), /was not found/)
  for (const code of ['EACCES', 'EPERM']) {
    const msg = checkKeyFile('k', errFs(code))
    assert.match(msg, /isn't readable by this Windows account/)
    assert.doesNotMatch(msg, /not found/)
  }
})

test('ssh bad-permissions output mentions other users and the owner', () => {
  const msg = explainKeyError('WARNING: UNPROTECTED PRIVATE KEY FILE!\nbad permissions', 'C:\\k')
  assert.match(msg, /readable by other users/)
  assert.match(msg, /owner must be your own account/)
})

test('ssh "Load key: Permission denied" is unreadable, not not-found', () => {
  assert.match(explainKeyError('Load key "C:\\\\k": Permission denied', 'C:\\k'), /isn't readable by this Windows account/)
})

test('unrelated ssh output is not a key error', () => {
  assert.equal(explainKeyError('Connection refused', 'C:\\k'), null)
})
