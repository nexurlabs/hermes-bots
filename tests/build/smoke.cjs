'use strict'
/**
 * Launches the built app (app/) under Electron with HERMES_BOTS_SMOKE=1 and waits for it to report
 * that main, preload and renderer all loaded. Fails on a crash, a missing module or a timeout.
 * On Linux CI run it under xvfb-run.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')

const electron = require('electron')
const appDir = path.join(__dirname, '..', '..', 'app')
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 60000)
const args = [appDir]
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu')

const child = spawn(electron, args, { env: { ...process.env, HERMES_BOTS_SMOKE: '1', ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
const collect = chunk => {
  out += chunk
  process.stdout.write(chunk)
  // A missing module never recovers: fail now instead of waiting for the timeout.
  if (/Cannot find module|HERMES_BOTS_SMOKE_FAIL/.test(out)) child.kill('SIGKILL')
}
child.stdout.on('data', collect)
child.stderr.on('data', collect)

const timer = setTimeout(() => {
  console.error(`smoke: timed out after ${timeoutMs}ms`)
  child.kill('SIGKILL')
  process.exit(1)
}, timeoutMs)

child.on('exit', code => {
  clearTimeout(timer)
  if (/Cannot find module|HERMES_BOTS_SMOKE_FAIL/.test(out)) {
    console.error('smoke: the app reported a load failure')
    process.exit(1)
  }
  if (code !== 0 || !out.includes('HERMES_BOTS_SMOKE_OK')) {
    console.error(`smoke: app exited with ${code} without reporting HERMES_BOTS_SMOKE_OK`)
    process.exit(1)
  }
  console.log('smoke: ok')
})
