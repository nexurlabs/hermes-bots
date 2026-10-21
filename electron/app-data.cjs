// The app was called Hermes Bots until 1.8.6, and Electron keeps its data (settings, chats, window size,
// routines' webhooks) in a folder named after the app: %APPDATA%\Hermes Bots then, %APPDATA%\NexurBots now.
// It lives outside main.cjs so the move can be tested without Electron.
const fs = require('node:fs')
const path = require('node:path')

const OLD_NAME = 'Hermes Bots'

// A folder the app has really used has settings.json; Electron may create an empty one on its own.
const inUse = dir => fs.existsSync(path.join(dir, 'settings.json'))

/**
 * Moves the old data folder to `current` once, before anything reads it. Returns 'moved', 'nothing', or
 * 'kept-old' when it couldn't be moved (an older copy still running, say) and the caller should keep using
 * `old` as it is. Never deletes data: the only thing it removes is an empty `current` folder.
 */
function adoptOldDataFolder(current, old) {
  if (path.resolve(current) === path.resolve(old)) return 'nothing'
  if (inUse(current) || !inUse(old)) return 'nothing'
  try {
    if (fs.existsSync(current)) fs.rmdirSync(current)
    fs.renameSync(old, current)
    return 'moved'
  } catch {
    return 'kept-old'
  }
}

module.exports = { adoptOldDataFolder, OLD_NAME }
