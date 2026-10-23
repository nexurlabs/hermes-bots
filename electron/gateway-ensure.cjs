// Keeping Hermes's scheduler alive. Routines are Hermes cron jobs, and only a running Hermes gateway
// fires them. A gateway that some other client auto-started runs with `--idle-exit` and ends itself
// after `gateway.unmanaged_idle_exit_seconds` (600s by default) — after which nothing fires. Hermes's
// `gateway ensure` (the call Hermes Desktop makes) starts an absent gateway WITHOUT the idle exit, so
// the app runs it whenever a bot has routines and Hermes says the scheduler isn't running.
const { execFile } = require('node:child_process')

const ENSURE_ARGS = ['gateway', 'ensure', '--json', '--timeout', '60']

/** Hermes prints one JSON line; exit 0 means ready. Anything else is reported, never thrown. */
function parseEnsure(stdout, code) {
  const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
  let payload = {}
  try {
    payload = JSON.parse(line)
  } catch {}
  const state = typeof payload.state === 'string' ? payload.state : code === 0 ? 'ready' : 'unknown'
  return { ok: code === 0 || state === 'ready', state, reason: typeof payload.reason_code === 'string' ? payload.reason_code : '' }
}

let inflight = null

/** Runs `hermes gateway ensure` once at a time; resolves { ok, state, reason }. */
function ensureGateway({ command, home, env = process.env, run = execFile } = {}) {
  if (inflight) return inflight
  inflight = new Promise(resolve => {
    try {
      run(
        command,
        ENSURE_ARGS,
        { env: { ...env, ...(home ? { HERMES_HOME: home } : {}) }, timeout: 90_000, windowsHide: true },
        (error, stdout) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
          resolve(parseEnsure(stdout, code))
        }
      )
    } catch (error) {
      resolve({ ok: false, state: 'spawn_failed', reason: String((error && error.message) || error) })
    }
  }).finally(() => {
    inflight = null
  })
  return inflight
}

module.exports = { ensureGateway, parseEnsure, ENSURE_ARGS }
