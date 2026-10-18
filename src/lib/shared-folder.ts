/**
 * The team's shared folder: one folder on the Hermes machine every bot can read and write, so
 * work can be handed over as files. It is `<Hermes home>/team-shared` (the default profile's
 * folder, which is the Hermes root). Hermes already keeps its own `<Hermes home>/shared` folder
 * for login tokens shared between profiles, so the team's files stay out of it.
 *
 * The app creates it if missing and lists, previews, uploads and deletes through Hermes's
 * managed-files API (`/api/files`, `/api/files/read`, `/api/files/upload`, `/api/files/mkdir`,
 * `DELETE /api/files`), the sibling of the `/api/fs` endpoints memory uses: `/api/fs` has no
 * sizes, dates, folders, uploads or deletes. Bots use their own file and terminal tools on the path
 * the team directory gives them (team.ts).
 */
import { atom } from 'nanostores'

import { native } from './native'
import { hostHttp } from './hosts'
import { $active, $profiles } from './store'

export const SHARED_FOLDER_NAME = 'team-shared'
/** Uploads go as a data URL in one JSON request, so keep them modest. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_TEXT_PREVIEW = 1024 * 1024
const MAX_IMAGE_PREVIEW = 8 * 1024 * 1024

export interface SharedFile {
  name: string
  path: string
  dir: boolean
  size: number | null
  /** Milliseconds since the epoch. */
  mtime: number | null
  mime: string | null
}

export type Preview = { kind: 'text'; text: string } | { kind: 'image'; dataUrl: string } | { kind: 'none'; reason: string }

/** Where the folder is and whether the app has made sure it exists (what bots are told). */
export const $sharedFolder = atom<{ path: string; ready: boolean; error?: string }>({ path: '', ready: false })

// ── paths ─────────────────────────────────────────────────────────────────
const defaultRow = () => $profiles.get().find(row => row.name === 'default') || $profiles.get().find(row => row.is_default)

const sepOf = (path: string) => (path.includes('\\') && !path.includes('/') ? '\\' : '/')

/** `<Hermes home>/team-shared`, with the separator the Hermes machine uses; '' before profiles load. */
export function sharedFolderRoot(): string {
  const home = defaultRow()?.path

  if (!home) {
    return ''
  }

  return [home.replace(/[\\/]+$/, ''), SHARED_FOLDER_NAME].join(sepOf(home))
}

/** A path inside the shared folder; `sub` is a list of folder names under it. */
export function sharedPath(root: string, ...parts: string[]): string {
  const clean = parts.filter(Boolean).map(part => {
    if (part === '.' || part === '..' || /[\\/]/.test(part)) {
      throw new Error(`"${part}" is not a valid name`)
    }

    return part
  })

  return [root, ...clean].join(sepOf(root))
}

// ── preview mode ──────────────────────────────────────────────────────────
interface PreviewFile extends SharedFile {
  text?: string
}

let preview: null | Map<string, PreviewFile> = null

/** Design preview: a folder with sample files, kept in this window. */
export function seedSharedPreview(root: string, files: { name: string; text?: string; size?: number; ago: number; dir?: boolean; mime?: string }[]) {
  preview = new Map()

  for (const file of files) {
    const path = sharedPath(root, ...file.name.split('/'))
    preview.set(path, {
      name: file.name.split('/').pop() as string,
      path,
      dir: Boolean(file.dir),
      size: file.dir ? null : (file.size ?? new Blob([file.text || '']).size),
      mtime: Date.now() - file.ago,
      mime: file.dir ? null : file.mime || 'text/markdown',
      text: file.text
    })
  }

  $sharedFolder.set({ path: root, ready: true })
}

// ── Hermes ────────────────────────────────────────────────────────────────
async function api(method: string, path: string, body?: unknown, timeoutMs = 20_000) {
  const active = $active.get()

  if (!active) {
    throw new Error('Not connected to Hermes')
  }

  return hostHttp({ baseUrl: active.baseUrl, token: active.token, method, path, body, timeoutMs })
}

const detailOf = (res: { status: number; json: any; text?: string }) => String(res.json?.detail || res.text || `Hermes answered ${res.status}`)

function missingApi(res: { status: number; json: any }) {
  return res.status === 404 && /not found/i.test(String(res.json?.detail || '')) && !/path not found|file not found/i.test(String(res.json?.detail || ''))
}

/** Creates the folder if it isn't there. Safe to call again; bots are told the path once it works. */
export async function ensureSharedFolder(): Promise<string> {
  if (preview) {
    return $sharedFolder.get().path
  }

  const root = sharedFolderRoot()

  if (!root) {
    throw new Error("Hermes didn't say where its home folder is.")
  }

  try {
    const res = await api('POST', 'api/files/mkdir', { path: root })

    if (!res.ok) {
      throw new Error(
        res.status === 404 || res.status === 405
          ? "This Hermes doesn't have the file API the shared folder uses. Update Hermes to use it."
          : `Couldn't create ${root}: ${detailOf(res)}`
      )
    }

    $sharedFolder.set({ path: root, ready: true })

    return root
  } catch (error) {
    $sharedFolder.set({ path: root, ready: false, error: String((error as Error)?.message || error) })
    throw error
  }
}

const entryOf = (raw: any): SharedFile => ({
  name: String(raw?.name || ''),
  path: String(raw?.path || ''),
  dir: Boolean(raw?.is_directory),
  size: typeof raw?.size === 'number' ? raw.size : null,
  mtime: typeof raw?.mtime === 'number' ? Math.round(raw.mtime * 1000) : null,
  mime: raw?.mime_type ? String(raw.mime_type) : null
})

/** The folder's entries (folders first), `sub` being folder names under the shared folder. */
export async function listShared(sub: string[] = []): Promise<SharedFile[]> {
  const root = $sharedFolder.get().ready ? $sharedFolder.get().path : await ensureSharedFolder()
  const dir = sharedPath(root, ...sub)

  if (preview) {
    const prefix = dir + sepOf(root)

    return [...preview.values()]
      .filter(file => file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes(sepOf(root)))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      .map(({ text: _text, ...file }) => file)
  }

  let res = await api('GET', `api/files?path=${encodeURIComponent(dir)}`)

  if (res.status === 404 && !sub.length && /path not found/i.test(detailOf(res))) {
    await ensureSharedFolder()
    res = await api('GET', `api/files?path=${encodeURIComponent(dir)}`)
  }

  if (!res.ok) {
    throw new Error(missingApi(res) ? "This Hermes doesn't have the file API the shared folder uses. Update Hermes to use it." : `Couldn't list ${dir}: ${detailOf(res)}`)
  }

  return (Array.isArray(res.json?.entries) ? res.json.entries : []).map(entryOf).filter((file: SharedFile) => file.name)
}

const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|log|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|bash|zsh|ps1|sql|env\.example|gitignore|dockerfile|tex|rst|org|srt|vtt)$/i

export const isTextFile = (file: SharedFile) =>
  !file.dir && (/^text\//.test(file.mime || '') || /json|xml|yaml|javascript|x-sh|toml|sql/.test(file.mime || '') || TEXT_EXT.test(file.name) || !/\.[^.]+$/.test(file.name))

export const isImageFile = (file: SharedFile) => !file.dir && /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp)$/.test(file.mime || '')

function decodeBase64(dataUrl: string): Uint8Array {
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

/** What the file view shows: text, an image, or why there's no preview. */
export async function readShared(file: SharedFile): Promise<Preview> {
  const text = isTextFile(file)
  const image = isImageFile(file)

  if (!text && !image) {
    return { kind: 'none', reason: "There's no preview for this kind of file. Bots can still open it from the folder." }
  }

  if ((file.size || 0) > (image ? MAX_IMAGE_PREVIEW : MAX_TEXT_PREVIEW)) {
    return { kind: 'none', reason: 'This file is too large to preview here.' }
  }

  if (preview) {
    const found = preview.get(file.path)

    return found?.text !== undefined ? { kind: 'text', text: found.text } : { kind: 'none', reason: 'No preview in the design preview.' }
  }

  const res = await api('GET', `api/files/read?path=${encodeURIComponent(file.path)}`, undefined, 60_000)

  if (!res.ok) {
    throw new Error(`Couldn't open ${file.name}: ${detailOf(res)}`)
  }

  const dataUrl = String(res.json?.data_url || '')

  if (image) {
    return { kind: 'image', dataUrl }
  }

  const bytes = decodeBase64(dataUrl)

  if (bytes.subarray(0, 8000).includes(0)) {
    return { kind: 'none', reason: "This file isn't text, so there's no preview." }
  }

  return { kind: 'text', text: new TextDecoder('utf-8').decode(bytes) }
}

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error(`Couldn't read ${file.name}`))
    reader.readAsDataURL(file)
  })

/** "notes.md" → "notes (2).md" when the name is taken. */
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) {
    return name
  }

  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''

  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`

    if (!taken.has(next.toLowerCase())) {
      return next
    }
  }
}

/** Uploads into `sub`, never overwriting: a taken name gets " (2)". Returns the names used. */
export async function uploadShared(sub: string[], files: File[], existing: SharedFile[]): Promise<string[]> {
  const root = $sharedFolder.get().ready ? $sharedFolder.get().path : await ensureSharedFolder()
  const taken = new Set(existing.map(file => file.name.toLowerCase()))
  const used: string[] = []

  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`${file.name} is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB. Copy big files onto the Hermes machine directly.`)
    }

    const name = freeName(file.name.replace(/[\\/]/g, '_') || 'file', taken)
    taken.add(name.toLowerCase())
    const path = sharedPath(root, ...sub, name)

    if (preview) {
      const text = file.size < MAX_TEXT_PREVIEW ? await file.text() : undefined
      preview.set(path, { name, path, dir: false, size: file.size, mtime: Date.now(), mime: file.type || 'application/octet-stream', text })
      used.push(name)
      continue
    }

    const dataUrl = await readAsDataUrl(file)
    // An empty file reads as "data:" with no ";base64", which Hermes refuses.
    const payload = /;base64,/.test(dataUrl) ? dataUrl : `data:${file.type || 'application/octet-stream'};base64,`
    const res = await api('POST', 'api/files/upload', { path, data_url: payload, overwrite: false }, 5 * 60_000)

    if (!res.ok) {
      throw new Error(res.status === 413 ? `${file.name} is too large for Hermes to accept.` : `Couldn't upload ${file.name}: ${detailOf(res)}`)
    }

    used.push(name)
  }

  return used
}

/** Deletes a file, or a folder with everything in it. */
export async function deleteShared(file: SharedFile) {
  const root = $sharedFolder.get().path

  if (!root || file.path === root || !file.path.startsWith(root + sepOf(root))) {
    throw new Error('Only files inside the shared folder can be deleted here.')
  }

  if (preview) {
    for (const key of [...preview.keys()]) {
      if (key === file.path || key.startsWith(file.path + sepOf(root))) {
        preview.delete(key)
      }
    }

    return
  }

  const res = await api('DELETE', 'api/files', { path: file.path, recursive: file.dir })

  if (!res.ok && res.status !== 404) {
    throw new Error(`Couldn't delete ${file.name}: ${detailOf(res)}`)
  }
}

/** Forget the folder state when switching Hermes machines. */
export function resetSharedFolder() {
  if (!preview) {
    $sharedFolder.set({ path: '', ready: false })
  }
}

// ── pictures on the Hermes machine, for images in replies ─────────────────
const imageCache = new Map<string, Promise<string>>()

/**
 * A picture a bot linked by its path on the Hermes machine (`![chart](/home/me/chart.png)`), as a
 * data URL, read through the same managed-files API. Rejects for anything that isn't a picture.
 */
export function readHermesImage(path: string): Promise<string> {
  const hit = imageCache.get(path)

  if (hit) {
    return hit
  }

  const load = (async () => {
    if (preview) {
      throw new Error('No pictures from Hermes in the design preview')
    }

    const res = await api('GET', `api/files/read?path=${encodeURIComponent(path)}`, undefined, 60_000)

    if (!res.ok) {
      throw new Error(detailOf(res))
    }

    const dataUrl = String(res.json?.data_url || '')

    if (!/^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,/i.test(dataUrl) || Number(res.json?.size || 0) > MAX_IMAGE_PREVIEW) {
      throw new Error('Not a picture the app can show')
    }

    return dataUrl
  })()

  imageCache.set(path, load)
  load.catch(() => setTimeout(() => imageCache.delete(path), 30_000))

  return load
}
