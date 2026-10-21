'use strict'
/**
 * Launches the built app (app/) under Electron with HERMES_BOTS_SMOKE=1 and waits for it to report
 * that main, preload and renderer all loaded. Fails on a crash, a missing module or a timeout.
 * On Linux CI run it under xvfb-run. Set SMOKE_EXE to test a packaged/installed executable instead.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')

// SMOKE_EXE=<path to the packaged/installed app exe> smoke-tests the PACKAGED app (release.yml and
// check.yml's windows-packaged job) instead of app/ under the dev Electron.
const packaged = process.env.SMOKE_EXE
const electron = packaged || require('electron')
const appDir = path.join(__dirname, '..', '..', 'app')
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 60000)
const args = packaged ? [] : [appDir]
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu')
if (packaged) console.log(`smoke: packaged app ${packaged}`)

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
