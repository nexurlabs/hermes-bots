// Waiting for the Hermes server this computer starts (`hermes serve`). It lives outside main.cjs so the
// wait can be tested without Electron.
const fs = require('node:fs')
const path = require('node:path')

// A plain start prints its ready line within seconds. Past this, something is wrong.
const START_WAIT_MS = 120 * 1000
// Hermes' first start after its code changed runs its setup in the foreground (dependency sync, runtime
// provisioning). That takes minutes, so while its update marker is held by a live process we keep waiting.
const UPDATE_WAIT_MS = 30 * 60 * 1000
const TICK_MS = 2000
const SLOW_AFTER_MS = 30 * 1000
const UPDATE_STEP = 'Hermes is finishing an update. The first start after an update can take several minutes.'
const SLOW_STEP = 'Still waiting for Hermes to start…'

const READY = /HERMES_DASHBOARD_READY\s+port=(\d+)/

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists, it is just not ours to signal.
    return error.code === 'EPERM'
  }
}

/** True while Hermes' update marker names a live process (the marker's first line is that pid). */
function updateInProgress(home, isAlive = pidAlive) {
  let pid = NaN

  try {
    pid = Number(fs.readFileSync(path.join(home, '.hermes-update-in-progress'), 'utf8').split(/\s/)[0])
  } catch {
    return false
  }

  return Number.isInteger(pid) && pid > 0 && isAlive(pid)
}

/**
 * Follows a spawned `hermes serve`. `ready` resolves with its port once it prints the ready line, and
 * rejects if it exits first. `output()` is the tail of what it printed, for error reports.
 */
function watchServe(child) {
  let buffer = ''
  const ready = new Promise((resolve, reject) => {
    const onData = chunk => {
      buffer += chunk.toString()
      const match = READY.exec(buffer)
      if (match) resolve(Number(match[1]))
      if (buffer.length > 200000) buffer = buffer.slice(-20000)
    }
    child.stdout && child.stdout.on('data', onData)
    child.stderr && child.stderr.on('data', onData)
    child.on('exit', code => reject(new Error(`Hermes exited (${code}). ${buffer.slice(-300)}`)))
    child.on('error', reject)
  })
  // Nobody may be waiting on it between two checks; an unobserved rejection is not an error here.
  ready.catch(() => {})
  return { ready, output: () => buffer.slice(-600) }
}

/**
 * Waits for a watched serve to become ready and resolves with its port. Rejects at once if it exits.
 * Otherwise it rejects with `timedOut` set after START_WAIT_MS, or after UPDATE_WAIT_MS while the update
 * marker says Hermes is still updating. While an update runs the limit slides, and it keeps a START_WAIT_MS
 * grace after the update ends. `onStep` gets plain-language progress text, once per change.
 */
async function waitForServe(
  serve,
  { home, onStep = () => {}, isAlive = pidAlive, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}
) {
  const started = now()
  let limit = started + START_WAIT_MS
  let said = ''
  const say = text => {
    if (text && text !== said) {
      said = text
      onStep(text)
    }
  }

  for (;;) {
    const port = await Promise.race([serve.ready, sleep(TICK_MS).then(() => null)])
    if (port !== null) return port

    const updating = updateInProgress(home, isAlive)

    if (updating) {
      limit = Math.min(started + UPDATE_WAIT_MS, Math.max(limit, now() + START_WAIT_MS))
      say(UPDATE_STEP)
    } else if (now() - started > SLOW_AFTER_MS) {
      say(SLOW_STEP)
    }

    if (now() >= limit) {
      const error = new Error(updating ? 'Hermes took too long to finish its update.' : 'Hermes took too long to start.')
      error.timedOut = true
      error.output = serve.output ? serve.output() : ''
      throw error
    }
  }
}

module.exports = { watchServe, waitForServe, updateInProgress, pidAlive, START_WAIT_MS, UPDATE_WAIT_MS, UPDATE_STEP }
