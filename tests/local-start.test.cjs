'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { MISSING_AGENT, isMissingAgent, explainLocalStartError } = require('../electron/local-start.cjs')

test('a missing hermes binary becomes the MISSING_AGENT error, not raw ENOENT', () => {
  const raw = Object.assign(new Error('spawn hermes ENOENT'), { code: 'ENOENT', syscall: 'spawn hermes' })
  assert.equal(isMissingAgent(raw), true)
  const out = explainLocalStartError(raw)
  assert.equal(out.code, MISSING_AGENT)
  assert.match(out.message, /HERMES_AGENT_NOT_INSTALLED/)
  assert.match(out.message, /isn't installed on this computer/)
  assert.doesNotMatch(out.message, /ENOENT/)
})

test('unexecutable binary and Windows "not recognized" also count as missing', () => {
  assert.equal(isMissingAgent(Object.assign(new Error('spawn /x/hermes EACCES'), { code: 'EACCES' })), true)
  assert.equal(isMissingAgent(new Error("'hermes' is not recognized as an internal or external command")), true)
})

test('other failures pass through unchanged', () => {
  const slow = new Error('Hermes took too long to start')
  assert.equal(isMissingAgent(slow), false)
  assert.equal(explainLocalStartError(slow), slow)
  assert.equal(isMissingAgent(new Error('Hermes exited (1). Traceback ...')), false)
})

test('local:start routes spawn failures through explainLocalStartError', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  // A spawn that throws at once (launchLocalServe) and one that fails while Hermes starts (the
  // local:start handler, which waits for it) both reach the app as the plain explanation.
  const launch = src.slice(src.indexOf('function launchLocalServe('))
  const launchBody = launch.slice(0, launch.indexOf('\n}\n'))
  const start = src.slice(src.indexOf("ipcMain.handle('local:start'"))
  const body = start.slice(0, start.indexOf('\n})\n'))
  assert.match(launchBody, /throw explainLocalStartError\(error\)/)
  assert.match(body, /throw explainLocalStartError\(error\)/)
})
