/**
 * Files bots send (`send_file` on `hermes-bots-groups`). The bot names a file on the Hermes machine;
 * the app checks it (absolute path, no `..`, no credentials, at most 50 MB, and Hermes's own
 * managed-files policy), then posts a message carrying a reference: path, name, size, type. The
 * bytes are fetched only when needed, through Hermes's managed-files API (`/api/files/read`, the
 * same one the shared folder uses): image thumbnails when shown, media when played, others on
 * Download / Open.
 *
 * 1:1 posts are kept on this device like the other cards; group posts are log entries (synced).
 */
import { atom } from 'nanostores'

import { native } from './native'
import { hostHttp } from './hosts'
import { $active } from './store'
import type { BotFile } from './types'

export const MAX_SEND_BYTES = 50 * 1024 * 1024
export const MAX_FILES_PER_POST = 1
const MAX_INLINE_MEDIA = 25 * 1024 * 1024

export interface FilePost {
  id: string
  at: number
  caption?: string
  files: BotFile[]
  /** Posted while answering in a thread: the root's id. */
  thread?: string
}

// ── checking a path ─────────────────────────────────────────────────────────
const SENSITIVE_NAME = /^(\.env(\..*)?|\.netrc|\.pgpass|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|auth\.json|credentials(\.json)?|.*\.(pem|key|p12|pfx|kdbx))$/i
const SENSITIVE_DIR = /^(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.config\/gcloud)$/i

const sepOf = (path: string) => (/^[A-Za-z]:\\/.test(path) || (path.includes('\\') && !path.includes('/')) ? '\\' : '/')

/** Why a path can't be sent, or null. Hermes applies its own policy on top when it's read. */
export function pathProblem(path: string): null | string {
  if (!path) {
    return 'path is required: the full path of the file on your computer.'
  }

  if (!(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path))) {
    return 'path must be absolute (e.g. /home/you/report.pdf).'
  }

  const parts = path.split(/[\\/]+/).filter(Boolean)

  if (parts.some(part => part === '..' || part === '.')) {
    return 'path must not contain "." or ".." segments.'
  }

  const name = parts[parts.length - 1] || ''

  if (SENSITIVE_NAME.test(name) || parts.some(part => SENSITIVE_DIR.test(part))) {
    return "That file looks like credentials or keys; it can't be sent."
  }

  return null
}

export const baseName = (path: string) => path.split(/[\\/]+/).filter(Boolean).pop() || 'file'
export const dirName = (path: string) => {
  const sep = sepOf(path)
  const cut = path.replace(/[\\/]+$/, '').lastIndexOf(sep)

  return cut <= 0 ? sep : path.slice(0, cut)
}

/** A display name the user's OS can save: no path parts or control characters. */
export const cleanFileName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 180)

// ── Hermes's managed-files API ──────────────────────────────────────────────
async function api(method: string, path: string, timeoutMs = 20_000, who?: string) {
  const active = $active.get()

  if (!active) {
    throw new Error('Not connected to Hermes')
  }

  return hostHttp({ baseUrl: active.baseUrl, token: active.token, method, path, timeoutMs }, who)
}

const detail = (res: { status: number; json: any; text?: string }) => String(res.json?.detail || res.text || `Hermes answered ${res.status}`)

/** Size and type of a file on the Hermes machine, from its folder's listing (no download). */
export async function statHermesFile(path: string, who?: string): Promise<{ size: number; mime?: string }> {
  const res = await api('GET', `api/files?path=${encodeURIComponent(dirName(path))}`, 20_000, who)

  if (!res.ok) {
    throw new Error(res.status === 404 && !res.json?.detail ? "This Hermes doesn't have the file API (/api/files)." : `Can't reach that folder: ${detail(res)}`)
  }

  const name = baseName(path)
  const entry = (Array.isArray(res.json?.entries) ? res.json.entries : []).find((e: any) => String(e?.name) === name)

  if (!entry) {
    throw new Error(`No file named ${name} there.`)
  }

  if (entry.is_directory) {
    throw new Error(`${name} is a folder; send one file.`)
  }

  return { size: Number(entry.size || 0), ...(entry.mime_type ? { mime: String(entry.mime_type) } : {}) }
}

const cache = new Map<string, Promise<string>>()

/** The file's bytes as a data URL (cached per path for this session). */
export function fetchBotFile(file: BotFile): Promise<string> {
  const hit = cache.get(file.path)

  if (hit) {
    return hit
  }

  const demo = $demoFiles.get()[file.path]
  const load = demo
    ? Promise.resolve(demo)
    : api('GET', `api/files/read?path=${encodeURIComponent(file.path)}`, 120_000, file.host).then(res => {
        if (!res.ok) {
          throw new Error(`Couldn't get ${file.name}: ${detail(res)}`)
        }

        return String(res.json?.data_url || '')
      })

  cache.set(file.path, load)
  load.catch(() => cache.delete(file.path))

  return load
}

export const kindOf = (file: BotFile): 'image' | 'video' | 'audio' | 'file' => {
  const mime = file.mime || ''

  if (/^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/.test(mime) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name)) return 'image'
  if (/^video\/(mp4|webm|ogg)$/.test(mime) || /\.(mp4|webm|ogv|mov)$/i.test(file.name)) return 'video'
  if (/^audio\//.test(mime) || /\.(mp3|wav|ogg|oga|m4a|flac)$/i.test(file.name)) return 'audio'

  return 'file'
}

/** Media players load the whole file, so only modest ones play inline. */
export const playable = (file: BotFile) => (file.size || 0) <= MAX_INLINE_MEDIA

/** Download: a Save dialog in the app, a browser download otherwise. */
export async function saveBotFile(file: BotFile) {
  const dataUrl = await fetchBotFile(file)

  if (native.saveFile) {
    return native.saveFile(file.name, dataUrl)
  }

  const link = document.createElement('a')
  link.href = dataUrl
  link.download = file.name
  document.body.appendChild(link)
  link.click()
  link.remove()

  return { ok: true }
}

/** Open: saved to a temp folder and opened with the OS default app. */
export async function openBotFile(file: BotFile) {
  const dataUrl = await fetchBotFile(file)

  if (native.openFile) {
    const result = await native.openFile(file.name, dataUrl)

    if (!result.ok) {
      throw new Error(result.error || `Couldn't open ${file.name}`)
    }

    return
  }

  window.open(dataUrl, '_blank')
}

// ── 1:1 posts (this device) ─────────────────────────────────────────────────
const key = (chat: string) => `file-posts:${chat}`

export const $filePosts = atom<Record<string, FilePost[]>>({})
/** Design preview only: stand-in bytes by path. */
export const $demoFiles = atom<Record<string, string>>({})

export function chatFilePosts(chat: string): FilePost[] {
  const cached = $filePosts.get()[chat]

  if (cached) {
    return cached
  }

  let list: FilePost[] = []

  try {
    list = JSON.parse(localStorage.getItem(key(chat)) || '[]') || []
  } catch {
    list = []
  }

  $filePosts.set({ ...$filePosts.get(), [chat]: list })

  return list
}

export function addFilePost(chat: string, post: FilePost) {
  const list = [...chatFilePosts(chat), post].slice(-200)
  $filePosts.set({ ...$filePosts.get(), [chat]: list })

  try {
    localStorage.setItem(key(chat), JSON.stringify(list))
  } catch {
    /* session only */
  }
}
