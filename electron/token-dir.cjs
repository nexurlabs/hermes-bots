'use strict'

const path = require('path')

/**
 * Where the backup copy of the This PC token lives, outside the app's data folder. The copy is
 * sealed with Windows DPAPI (token-store.cjs runs PowerShell), so it only exists on Windows: every
 * other platform gets '' (no copy), instead of a Windows-style ~/AppData/Local path that then
 * logged "this-pc token copy outside the data folder: could not save" on every Linux/macOS launch.
 */
function tokenCopyDirFor({ platform, env, home, name, smoke }) {
  if (smoke || platform !== 'win32') return ''

  return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), name)
}

module.exports = { tokenCopyDirFor }
