// The wait for the Hermes server this computer starts. A plain start gets two minutes; a start that
// is still inside Hermes' own update gets up to thirty, because its setup runs in the foreground.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const localServe = require('../electron/local-serve.cjs')

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

// Time the test moves by hand: a sleep advances the clock instead of waiting.
function fakeClock(onTick = () => {}) {
  let t = 0
  return {
    now: () => t,
    sleep: async ms => {
      t += ms
      onTick(t)
    }
  }
}

function homeWith(marker) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-serve-'))
  if (marker !== undefined) fs.writeFileSync(path.join(home, '.hermes-update-in-progress'), marker)
  return home
}

test('the update marker counts only while the process it names is alive', () => {
  const isAlive = pid => pid === 4321

  assert.equal(localServe.updateInProgress(homeWith('4321\n1792413501\n'), isAlive), true)
  assert.equal(localServe.updateInProgress(homeWith('999\n'), isAlive), false)
  assert.equal(localServe.updateInProgress(homeWith('not a pid'), isAlive), false)
  assert.equal(localServe.updateInProgress(homeWith(undefined), isAlive), false)
})

test('a serve that prints its ready line is waited for, port and all', async () => {
  const child = fakeChild()
  const serve = localServe.watchServe(child)
  setTimeout(() => child.stdout.emit('data', Buffer.from('starting\nHERMES_DASHBOARD_READY port=45678\n')), 5)

  const port = await localServe.waitForServe(serve, { home: homeWith(), sleep: () => new Promise(resolve => setTimeout(resolve, 1)) })
  assert.equal(port, 45678)
})

test('a serve that never becomes ready times out after two minutes, with its output', async () => {
  const clock = fakeClock()
  const serve = { ready: new Promise(() => {}), output: () => 'loading models' }

  await assert.rejects(localServe.waitForServe(serve, { home: homeWith(), ...clock }), error => {
    assert.equal(error.timedOut, true)
    assert.equal(error.message, 'Hermes took too long to start.')
    assert.equal(error.output, 'loading models')
    return true
  })
  assert.ok(clock.now() >= localServe.START_WAIT_MS && clock.now() < localServe.START_WAIT_MS + 2000)
})

test('keeps waiting past two minutes while Hermes is updating itself, and says so', async () => {
  // The update ends at five minutes; Hermes then prints its ready line thirty seconds later.
  let resolveReady
  const serve = { ready: new Promise(resolve => (resolveReady = resolve)), output: () => '' }
  const clock = fakeClock(t => {
    if (t >= 330000) resolveReady(7000)
  })
  const steps = []

  const port = await localServe.waitForServe(serve, {
    home: homeWith('4321\n'),
    isAlive: () => clock.now() < 300000,
    onStep: text => steps.push(text),
    ...clock
  })

  assert.equal(port, 7000)
  assert.equal(steps[0], localServe.UPDATE_STEP)
  assert.equal(steps.filter(text => text === localServe.UPDATE_STEP).length, 1)
})

test('gives up when an update never finishes, after thirty minutes', async () => {
  const clock = fakeClock()
  const serve = { ready: new Promise(() => {}), output: () => '' }

  await assert.rejects(
    localServe.waitForServe(serve, { home: homeWith('4321\n'), isAlive: () => true, ...clock }),
    error => error.timedOut === true && /update/.test(error.message)
  )
  assert.ok(clock.now() >= localServe.UPDATE_WAIT_MS && clock.now() < localServe.UPDATE_WAIT_MS + 2000)
})

test('a serve that exits while starting fails at once, with what it printed', async () => {
  const child = fakeChild()
  const serve = localServe.watchServe(child)
  setTimeout(() => {
    child.stderr.emit('data', Buffer.from('ModuleNotFoundError: no module named yaml'))
    child.emit('exit', 1)
  }, 5)

  await assert.rejects(
    localServe.waitForServe(serve, { home: homeWith(), sleep: () => new Promise(resolve => setTimeout(resolve, 1)) }),
    /exited \(1\)[\s\S]*no module named yaml/
  )
})

test('after a timeout, the same serve is still waited for rather than replaced', async () => {
  const child = fakeChild()
  const serve = localServe.watchServe(child)
  const clock = fakeClock()

  await assert.rejects(localServe.waitForServe(serve, { home: homeWith(), ...clock }), error => error.timedOut === true)

  setTimeout(() => child.stdout.emit('data', Buffer.from('HERMES_DASHBOARD_READY port=9100')), 5)
  const port = await localServe.waitForServe(serve, { home: homeWith(), sleep: () => new Promise(resolve => setTimeout(resolve, 1)) })
  assert.equal(port, 9100)
})

test('cancelling a serve that is still starting stops it, and its wait fails without a port', async () => {
  const child = fakeChild()
  let killed = 0
  child.kill = () => {
    killed += 1
    child.emit('exit', null)
  }
  const serve = localServe.watchServe(child)
  const pending = { child, serve, token: 't' }

  const waiting = localServe.waitForServe(serve, { home: homeWith(), sleep: () => new Promise(resolve => setTimeout(resolve, 1)) })
  localServe.cancelServe(pending)

  await assert.rejects(waiting, error => !error.timedOut && /exited/.test(error.message))
  assert.equal(pending.cancelled, true)
  assert.equal(killed, 1)
})

test('cancelling tolerates a child that is already gone', () => {
  const child = fakeChild()
  child.kill = () => {
    throw new Error('ESRCH')
  }
  const pending = { child, serve: localServe.watchServe(child), token: 't' }
  assert.doesNotThrow(() => localServe.cancelServe(pending))
  assert.equal(pending.cancelled, true)
})
