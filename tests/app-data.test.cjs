// The one-time move of the data folder from %APPDATA%\Hermes Bots to %APPDATA%\NexurBots. It must never
// lose data: when the folder can't be moved, the app keeps using the old one where it is.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { adoptOldDataFolder } = require('../electron/app-data.cjs')

function appData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-appdata-'))
  return { current: path.join(root, 'NexurBots'), old: path.join(root, 'Hermes Bots') }
}

function used(dir, settings = '{"connections":[]}') {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), settings)
  fs.writeFileSync(path.join(dir, 'hooks.json'), '{}')
}

test('moves the old folder, with everything in it, when the new one does not exist yet', () => {
  const { current, old } = appData()
  used(old, '{"user":{"name":"Sam"}}')

  assert.equal(adoptOldDataFolder(current, old), 'moved')
  assert.equal(fs.readFileSync(path.join(current, 'settings.json'), 'utf8'), '{"user":{"name":"Sam"}}')
  assert.equal(fs.existsSync(path.join(current, 'hooks.json')), true)
  assert.equal(fs.existsSync(old), false)
})

test('an empty new folder (made by Electron at startup) does not stop the move', () => {
  const { current, old } = appData()
  used(old)
  fs.mkdirSync(current)

  assert.equal(adoptOldDataFolder(current, old), 'moved')
  assert.equal(fs.existsSync(path.join(current, 'settings.json')), true)
})

test('a new folder that already has settings is left alone, and so is the old one', () => {
  const { current, old } = appData()
  used(current, '{"new":true}')
  used(old, '{"old":true}')

  assert.equal(adoptOldDataFolder(current, old), 'nothing')
  assert.equal(fs.readFileSync(path.join(current, 'settings.json'), 'utf8'), '{"new":true}')
  assert.equal(fs.readFileSync(path.join(old, 'settings.json'), 'utf8'), '{"old":true}')
})

test('a new folder with other files in it keeps the old folder in use, and nothing is deleted', () => {
  const { current, old } = appData()
  used(old)
  fs.mkdirSync(current)
  fs.writeFileSync(path.join(current, 'Local State'), 'x')

  assert.equal(adoptOldDataFolder(current, old), 'kept-old')
  assert.equal(fs.existsSync(path.join(old, 'settings.json')), true)
  assert.equal(fs.existsSync(path.join(current, 'Local State')), true)
})

test('nothing happens on a fresh install, or when both names are the same folder', () => {
  const { current, old } = appData()
  assert.equal(adoptOldDataFolder(current, old), 'nothing')

  used(old)
  assert.equal(adoptOldDataFolder(old, old), 'nothing')
  assert.equal(fs.existsSync(path.join(old, 'settings.json')), true)
})
