'use strict'
/**
 * Plain-language checks for the "Over SSH" key file, before and after running ssh.
 * - a public key (.pub, or content starting with "ssh-…") → pick the private key instead
 * - EACCES/EPERM → the file exists but this Windows account can't read it
 * - ENOENT → not found (the only case that says "not found")
 */
const fs = require('node:fs')

const PUBLIC_KEY_RE = /^\s*(ssh-(rsa|dss|ed25519)|ecdsa-sha2-[\w-]+|sk-(ssh-ed25519|ecdsa-sha2-[\w-]+)@openssh\.com)\s+AAAA/
const looksLikePublicKey = text => PUBLIC_KEY_RE.test(String(text || '')) || /^\s*ssh-[\w-]+\s/.test(String(text || '')) || /^---- BEGIN SSH2 PUBLIC KEY/.test(String(text || ''))

function publicKeyMessage(key) {
  const priv = /\.pub$/i.test(key) ? key.replace(/\.pub$/i, '') : null
  return `${key} is a public key. Pick the private key file instead${priv ? ` (${priv}, the same name without .pub)` : ' (usually the same name without .pub)'}.`
}

const unreadableMessage = key =>
  `The key file ${key} exists but isn't readable by this Windows account. Right-click it → Properties → Security, make your own account the owner and give it Read access.`

const notFoundMessage = key => `The key file ${key} was not found on this PC.`

/** Returns a message if the key file can't be used, or null when it looks fine. */
function checkKeyFile(key, fsImpl = fs) {
  if (!key) return null
  if (/\.pub$/i.test(key)) return publicKeyMessage(key)
  let head
  try {
    const fd = fsImpl.openSync(key, 'r')
    try {
      const buf = Buffer.alloc(256)
      const n = fsImpl.readSync(fd, buf, 0, buf.length, 0)
      head = buf.subarray(0, n).toString('utf8')
    } finally {
      fsImpl.closeSync(fd)
    }
  } catch (error) {
    const code = error && error.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return notFoundMessage(key)
    if (code === 'EACCES' || code === 'EPERM') return unreadableMessage(key)
    if (code === 'EISDIR') return `${key} is a folder. Pick the private key file inside it (for example id_ed25519).`
    return `Couldn't read the key file ${key} (${code || (error && error.message) || 'unknown error'}).`
  }
  if (looksLikePublicKey(head)) return publicKeyMessage(key)
  return null
}

/** Maps ssh's own key-related output to a message, or null if it isn't about the key file. */
function explainKeyError(text, key) {
  const s = String(text || '')
  if (/UNPROTECTED PRIVATE KEY|bad permissions/i.test(s))
    return `Windows says the key file is readable by other users (${key}). Right-click it → Properties → Security: the owner must be your own account, and leave only your own account (remove other users and groups).`
  if (!key) return null
  if (/\.pub$/i.test(key)) return publicKeyMessage(key)
  if (/Permission denied/i.test(s) && /load key|identity file|Identity file/i.test(s)) return unreadableMessage(key)
  if (/load key|invalid format|error in libcrypto/i.test(s)) {
    const problem = checkKeyFile(key)
    if (problem) return problem
  }
  if (/no such file|not accessible|Identity file/i.test(s) && /identity|key/i.test(s)) return checkKeyFile(key) || notFoundMessage(key)
  return null
}

module.exports = { checkKeyFile, explainKeyError, looksLikePublicKey }
