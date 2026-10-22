// A copy of the This PC token outside the app's data folder, so wiping that folder doesn't change it.
// Hermes processes that are already running (a bot's platform gateway, say) keep the bearer they were
// registered with, so a new token leaves their tool calls refused until they restart.
//
// The copy is encrypted with Windows' per-user DPAPI through PowerShell, not Electron's safeStorage:
// safeStorage keeps its key in the data folder, so its copy would be unreadable after the same wipe.
// The token goes to PowerShell on stdin, never on a command line other programs can read.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const FILE = 'this-pc-token.json'

const PROTECT =
  'Add-Type -AssemblyName System.Security; $t = [Console]::In.ReadToEnd().Trim(); ' +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($t), $null, 'CurrentUser'))"
const UNPROTECT =
  'Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
  "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'))"

// Lets a reader tell whether the copy matches a token without decrypting it.
const fingerprint = token => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex').slice(0, 16)

function runPowerShell(script, input) {
  if (process.platform !== 'win32') return Promise.reject(new Error('DPAPI is Windows only'))
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('PowerShell took too long'))
    }, 20_000)
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (err += chunk))
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(`PowerShell exited ${code}: ${err.trim().slice(0, 200)}`))
    })
    child.stdin.end(input)
  })
}

function readCopy(dir) {
  try {
    const copy = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
    return copy && typeof copy.dpapi === 'string' && typeof copy.fingerprint === 'string' ? copy : null
  } catch {
    return null
  }
}

/** True when the copy holds this token (no decrypting needed). */
function copyMatches(dir, token) {
  const copy = readCopy(dir)
  return !!copy && copy.fingerprint === fingerprint(token)
}

/** The token from the copy, or '' when there is none or it can't be read back as written. */
async function loadToken(dir, run = runPowerShell) {
  const copy = readCopy(dir)
  if (!copy) return ''
  try {
    const token = await run(UNPROTECT, copy.dpapi)
    return token && fingerprint(token) === copy.fingerprint ? token : ''
  } catch {
    return ''
  }
}

/** Writes the copy (replacing any old one). Returns false when it couldn't. */
async function saveToken(dir, token, run = runPowerShell) {
  try {
    const dpapi = await run(PROTECT, token)
    if (!dpapi) return false
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `${FILE}.${process.pid}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify({ fingerprint: fingerprint(token), dpapi }))
    fs.renameSync(tmp, path.join(dir, FILE))
    return true
  } catch {
    return false
  }
}

module.exports = { loadToken, saveToken, copyMatches, fingerprint, FILE, PROTECT, UNPROTECT }
