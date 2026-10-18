'use strict'
// Requirement #6: a bot on a native vision model must be able to SEE the screen while it
// works, with no separate "analyze the image" step. That only holds if the screenshot
// comes back over MCP as a real `image` content block. If it ever degrades to a text
// block carrying a path or a base64 string, the model can no longer look at the screen
// mid-turn â€” it would have to call a second tool to read the picture. These tests pin
// the wire format so that downgrade fails loudly.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const childProcess = require('node:child_process')
const { test } = require('node:test')

function fakePowerShell() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.stdin = { writable: true, write: () => true, end() {} }
  child.kill = () => { child.killed = true; child.emit('exit', 0) }
  return child
}

async function fixture(t) {
  const spawn = t.mock.method(childProcess, 'spawn', fakePowerShell)
  const modulePath = require.resolve('../electron/local-computer.cjs')
  delete require.cache[modulePath]
  const bridge = require(modulePath)
  const { port, token } = await bridge.startServer()
  t.after(() => {
    bridge.setCapture()
    bridge.stopServer()
    delete require.cache[modulePath]
  })
  const call = async (name, arguments_ = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } })
    })
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  return { bridge, spawn, call }
}

const PIXELS = 'AQIDBAUGBwgJCg=='

test('a screenshot reaches the bot as a real image block, so a native vision model sees it directly', async t => {
  const { bridge, call } = await fixture(t)
  bridge.setGranted(true)
  bridge.setCapture(async () => ({ ok: true, base64: PIXELS, width: 1280, height: 800, realWidth: 1920, realHeight: 1080 }))

  const result = await call('computer_screenshot')
  const image = result.content.find(part => part.type === 'image')

  assert.ok(image, 'the screenshot must carry an image content block, not only text')
  assert.equal(image.mimeType, 'image/jpeg')
  assert.equal(image.data, PIXELS)
  // The bytes must be the image itself, never a path or a note telling the model to go read one.
  assert.doesNotMatch(String(image.data), /\.png|\.jpg|file:|C:\\/)
})

test('the screenshot tells the bot which pixel space to click in, without a second lookup', async t => {
  const { bridge, call } = await fixture(t)
  bridge.setGranted(true)
  bridge.setCapture(async () => ({ ok: true, base64: PIXELS, width: 1280, height: 800, realWidth: 1920, realHeight: 1080 }))

  const result = await call('computer_screenshot')
  const note = result.content.find(part => part.type === 'text')

  assert.ok(note, 'the coordinate note is what stops the bot converting coordinates itself')
  assert.match(note.text, /1280x800/)
  assert.match(note.text, /1920x1080/)
})

test('the last screenshot is kept for the UI preview even though it also went to the bot', async t => {
  const { bridge, call } = await fixture(t)
  bridge.setGranted(true)
  bridge.setCapture(async () => ({ ok: true, base64: PIXELS, width: 1280, height: 800, realWidth: 1920, realHeight: 1080 }))

  await call('computer_screenshot')
  const shot = bridge.getLastShot()

  assert.ok(shot, 'the Computer tab previews the most recent shot')
  assert.equal(shot.dataUrl, `data:image/jpeg;base64,${PIXELS}`)
  assert.ok(shot.at > 0)
})

test('a failed capture still reports an error instead of an empty image block', async t => {
  const { bridge, call } = await fixture(t)
  bridge.setGranted(true)
  bridge.setCapture(async () => ({ ok: false, error: 'no display available' }))

  const result = await call('computer_screenshot')

  assert.equal(result.isError, true)
  assert.equal(result.content.some(part => part.type === 'image'), false)
  assert.match(result.content[0].text, /no display available/)
})