'use strict'
/**
 * Pure checks the main process applies to requests coming from the renderer. Kept free of Electron
 * so the node test suite can exercise exactly the code the app runs.
 */
const path = require('node:path')

// ── files a bot sent: never launch anything executable ──────────────────────
// Windows runs these by double-click (or by shell.openPath); several also run on macOS/Linux
// (.jar, .command, .sh, .desktop, .app). Lower-case, without the dot.
const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'com', 'bat', 'cmd', 'msi', 'msp', 'mst', 'msc', 'msh', 'msh1', 'msh2', 'mshxml', 'msh1xml', 'msh2xml',
  'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psm1', 'psd1',
  'vb', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'wsc', 'ws', 'scr', 'scf', 'lnk', 'url', 'inf', 'ins', 'isp',
  'reg', 'hta', 'cpl', 'jar', 'appref-ms', 'application', 'gadget', 'pif', 'sct', 'shb', 'shs', 'xbap', 'xll',
  'library-ms', 'searchconnector-ms', 'settingcontent-ms', 'diagcab', 'appx', 'appxbundle', 'msix', 'msixbundle',
  'chm', 'hlp', 'dll', 'sys', 'drv', 'ocx', 'iso', 'img', 'vhd', 'vhdx',
  'sh', 'bash', 'zsh', 'csh', 'ksh', 'command', 'tool', 'app', 'pkg', 'dmg', 'desktop', 'run', 'bin', 'deb', 'rpm', 'appimage',
  'py', 'pyw', 'pyc', 'pl', 'rb', 'php'
])

/** The extensions of a file name, last first, after Windows' own trimming (trailing dots/spaces). */
function extensionsOf(name) {
  // Windows ignores trailing dots and spaces, so "evil.exe. " runs as evil.exe. Strip NTFS stream
  // suffixes too ("evil.exe::$DATA").
  const base = path.basename(String(name || '').replace(/\\/g, '/')).replace(/:.*$/, '').replace(/[.\s]+$/g, '')
  const parts = base.toLowerCase().split('.').slice(1).map(part => part.trim())
  return parts.reverse()
}

/** True when opening this file with the OS default app could run code. Checks every extension, so a
 *  double extension ("invoice.pdf.exe") and its trailing-dot variants are caught. */
function isDangerousFile(name) {
  return extensionsOf(name).some(ext => DANGEROUS_EXTENSIONS.has(ext))
}

// ── renderer HTTP: only to machines the user set up ─────────────────────────
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/** The origin of a configured base URL, read the same way the renderer normalizes it. */
function originOf(baseUrl) {
  let text = String(baseUrl || '').trim()
  if (!text || (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text))) return ''
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
  } catch {
    return ''
  }
}

/** The URL the http IPC would fetch, or an error. The route may never leave the base's origin. */
function targetFor(baseUrl, route) {
  const base = originOf(baseUrl) ? String(baseUrl).trim() : ''
  if (!base) return { error: 'invalid base URL' }
  const normalized = /^https?:\/\//i.test(base) ? base : `http://${base}`
  let url
  try {
    url = new URL(String(route || ''), normalized.replace(/\/?$/, '/'))
  } catch {
    return { error: 'invalid path' }
  }
  if (url.origin !== originOf(normalized)) return { error: 'path leaves the machine' }
  return { url }
}

/** Origins the http IPC may reach without asking: loopback (this PC, SSH tunnels) and saved machines. */
function knownOrigins(connections) {
  const out = new Set()
  for (const conn of Array.isArray(connections) ? connections : []) {
    const origin = conn && originOf(conn.baseUrl)
    if (origin) out.add(origin)
  }
  return out
}

function isKnownTarget(url, connections, trusted = new Set()) {
  return isLoopbackHost(url.hostname) || knownOrigins(connections).has(url.origin) || trusted.has(url.origin)
}

module.exports = { DANGEROUS_EXTENSIONS, extensionsOf, isDangerousFile, isLoopbackHost, originOf, targetFor, knownOrigins, isKnownTarget }
