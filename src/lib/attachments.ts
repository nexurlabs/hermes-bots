/**
 * Files and pictures people send to a bot.
 *
 * Hermes does the real work: `image.attach_bytes` queues a picture for the model's next turn,
 * `pdf.attach` renders PDF pages, and `file.attach` stages anything else in the bot's workspace and
 * hands back an `@file:` reference. This module wraps those calls, and keeps a local copy of what
 * was sent (IndexedDB, on this device) so the Library tab can show thumbnails and re-open files.
 */
import { atom } from 'nanostores'

import { gateway } from './gateway'
import { native } from './native'
import type { MsgAttachment } from './types'

/** Hermes accepts up to 25 MB per picture; keep every file under the same ceiling. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENTS = 8

export interface Pending {
  id: string
  file: File
  kind: 'file' | 'image'
  name: string
  mime: string
  size: number
  /** Small data-URL preview for pictures. */
  thumb?: string
}

let counter = 0
const uid = () => `a${Date.now().toString(36)}${(counter++).toString(36)}`

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|bmp)$/i

export function humanSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }

  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Could not read the file'))
    reader.readAsDataURL(file)
  })
}

const base64Of = async (file: Blob) => {
  // Bytes straight from the Blob: works in the renderer and in Bun tests (no FileReader there).
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

/** Pictures as native image content for `session.steer_media`, so the model receives the bytes. */
export async function steerImages(items: Pending[]): Promise<{ filename: string; content_base64: string }[]> {
  return Promise.all(items.map(async item => ({ filename: item.name, content_base64: await base64Of(item.file) })))
}

/** A ≤360px preview so the composer and Library stay light even for huge photos. */
async function thumbnail(file: File): Promise<string | undefined> {
  try {
    // Decoded straight from the file, because the page's security policy doesn't allow blob: images.
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, 360 / Math.max(bitmap.width, bitmap.height, 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()

    return canvas.toDataURL('image/jpeg', 0.82)
  } catch {
    // Some Linux GPU setups can't decode with createImageBitmap: a small image is shown as-is instead.
    if (file.size > 4 * 1024 * 1024) return undefined

    return new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined)
      reader.onerror = () => resolve(undefined)
      reader.readAsDataURL(file)
    })
  }
}

/** Turns a picked/pasted/dropped File into a pending attachment, or an error sentence. */
export async function makePending(file: File): Promise<{ error: string } | { pending: Pending }> {
  if (!file.size) {
    return { error: `${file.name || 'That file'} is empty` }
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { error: `${file.name || 'That file'} is over ${humanSize(MAX_ATTACHMENT_BYTES)}` }
  }

  const mime = file.type || 'application/octet-stream'
  const kind = IMAGE_TYPES.test(mime) ? 'image' : 'file'
  const name = file.name || (kind === 'image' ? `pasted-${Date.now().toString(36)}.png` : 'attachment')

  return { pending: { id: uid(), file, kind, name, mime, size: file.size, thumb: kind === 'image' ? await thumbnail(file) : undefined } }
}

export const toMsgAttachment = (item: Pending): MsgAttachment => ({
  id: item.id,
  kind: item.kind,
  name: item.name,
  mime: item.mime,
  size: item.size,
  thumb: item.thumb
})

// ── sending ───────────────────────────────────────────────────────────────
const baseName = (path: string) => path.replace(/\\/g, '/').split('/').pop() || path

export interface Attached {
  /** Marker text for the prompt, so the model (and the reloaded history) knows what came along. */
  text: string
  /** The name Hermes stored it under — how a reloaded message finds its local copy. */
  ref: string
}

/** Hands one attachment to a live Hermes session. Call right before `prompt.submit`. */
export async function attachToSession(runtime: string, profile: string, item: Pending): Promise<Attached> {
  const session = { session_id: runtime, profile }

  if (item.kind === 'image') {
    const res = await gateway.request<{ path?: string; text?: string }>(
      'image.attach_bytes',
      { ...session, content_base64: await base64Of(item.file), filename: item.name },
      120_000
    )
    const ref = baseName(String(res?.path || item.name))

    return { ref, text: `[User attached image: ${ref}]` }
  }

  if (/\.pdf$/i.test(item.name) || item.mime === 'application/pdf') {
    try {
      const res = await gateway.request<{ text?: string; pages_attached?: number }>(
        'pdf.attach',
        { ...session, content_base64: await base64Of(item.file), filename: item.name },
        180_000
      )

      return { ref: item.name, text: String(res?.text || `[User attached PDF: ${item.name}]`) }
    } catch {
      /* no PDF renderer on that machine — hand over the file itself below */
    }
  }

  const res = await gateway.request<{ name?: string; ref_text?: string }>(
    'file.attach',
    { ...session, data_url: await readAsDataUrl(item.file), name: item.name },
    120_000
  )

  return { ref: String(res?.name || item.name), text: String(res?.ref_text || `[User attached file: ${item.name}]`) }
}

/** Attaches everything, returning the marker lines to put in front of the person's text. */
export async function attachAll(runtime: string, profile: string, items: Pending[]): Promise<{ markers: string[]; refs: Record<string, string> }> {
  const markers: string[] = []
  const refs: Record<string, string> = {}

  for (const item of items) {
    const done = await attachToSession(runtime, profile, item)
    markers.push(done.text)
    refs[item.id] = done.ref
  }

  return { markers, refs }
}

// ── reading history back ──────────────────────────────────────────────────
const MARKER = /\[User attached (image|PDF|file): ([^\]\n]+?)(?: \(\d+ pages?\))?\]\s*/g
const FILE_REF = /(?:^|\s)@file:(?:`([^`]+)`|"([^"]+)"|'([^']+)'|(\S+))\s?/g

/** Splits a stored user message into what the person typed and what came along with it. */
export function splitAttachments(text: string): { text: string; attachments: MsgAttachment[] } {
  const attachments: MsgAttachment[] = []
  const seen = new Set<string>()

  const add = (kind: 'file' | 'image', name: string) => {
    const key = `${kind}:${name}`

    if (!seen.has(key)) {
      seen.add(key)
      attachments.push({ id: `h${attachments.length}-${name}`, kind, name, ref: name })
    }
  }

  let rest = text.replace(MARKER, (_all, type: string, name: string) => {
    add(type === 'image' ? 'image' : 'file', baseName(name.trim()))

    return ''
  })

  rest = rest.replace(FILE_REF, (_all, a?: string, b?: string, c?: string, d?: string) => {
    add('file', baseName(a || b || c || d || ''))

    return ' '
  })

  return { text: rest.trim(), attachments }
}

export const attachmentKind = (name: string): 'file' | 'image' => (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name) ? 'image' : 'file')

// ── local library (IndexedDB) ─────────────────────────────────────────────
export interface LibraryItem extends MsgAttachment {
  scope: string
  at: number
}

interface LibraryRecord extends LibraryItem {
  blob: Blob
}

export const $library = atom<Record<string, LibraryItem[]>>({})

const DB_NAME = 'hermes-bots-library'
const STORE = 'items'
const memory = new Map<string, LibraryRecord>()
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, 1)

      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('scope', 'scope')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })

  return dbPromise
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

const meta = ({ blob: _blob, ...rest }: LibraryRecord): LibraryItem => rest

/** Remembers what was just sent. `refs` maps pending ids to the names Hermes stored them under. */
export async function rememberAttachments(scope: string, items: Pending[], refs: Record<string, string> = {}) {
  const at = Date.now()
  const records: LibraryRecord[] = items.map(item => ({
    ...toMsgAttachment(item),
    id: `${scope}|${item.id}`,
    ref: refs[item.id] || item.name,
    scope,
    at,
    blob: item.file
  }))

  const db = await openDb()

  for (const record of records) {
    memory.set(record.id, record)

    if (db) {
      await tx(db, 'readwrite', store => store.put(record)).catch(() => undefined)
    }
  }

  $library.set({ ...$library.get(), [scope]: [...records.map(meta).reverse(), ...($library.get()[scope] || [])] })
}

export async function loadLibrary(scope: string) {
  const db = await openDb()
  let records: LibraryRecord[] = [...memory.values()].filter(record => record.scope === scope)

  if (db) {
    try {
      const stored = await tx<LibraryRecord[]>(db, 'readonly', store => store.index('scope').getAll(scope))
      const byId = new Map(records.map(record => [record.id, record]))

      for (const record of stored) {
        byId.set(record.id, record)
      }

      records = [...byId.values()]
    } catch {
      /* the in-memory copies still show */
    }
  }

  records.sort((a, b) => b.at - a.at)
  $library.set({ ...$library.get(), [scope]: records.map(meta) })
}

export async function removeFromLibrary(scope: string, id: string) {
  memory.delete(id)
  const db = await openDb()

  if (db) {
    await tx(db, 'readwrite', store => store.delete(id)).catch(() => undefined)
  }

  $library.set({ ...$library.get(), [scope]: ($library.get()[scope] || []).filter(item => item.id !== id) })
}

export async function blobOf(id: string): Promise<Blob | null> {
  const cached = memory.get(id)

  if (cached) {
    return cached.blob
  }

  const db = await openDb()

  if (!db) {
    return null
  }

  try {
    const record = await tx<LibraryRecord | undefined>(db, 'readonly', store => store.get(id))

    return record?.blob || null
  } catch {
    return null
  }
}

/** Saves a stored attachment to the person's Downloads folder (or wherever their browser puts it). */
/**
 * Saves a local copy. In the app this is the native Save dialog, titled with the real file name
 * (an <a download> of a blob: URL made the dialog show "blob:file:///…"). Resolves 'saved' only once
 * the file is written, 'canceled' if the dialog was closed, 'missing' when there's no local copy.
 */
export async function downloadAttachment(item: Pick<MsgAttachment, 'id' | 'name'>): Promise<'saved' | 'canceled' | 'missing'> {
  const blob = await blobOf(item.id)

  if (!blob) {
    return 'missing'
  }

  if (native.saveFile) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    const res = await native.saveFile(item.name, dataUrl)

    return res && res.ok ? 'saved' : 'canceled'
  }

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = item.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)

  return 'saved'
}

/** Finds the local copy for a reloaded message's attachment (by the name Hermes stored it under). */
export function findLocal(scope: string, att: MsgAttachment): LibraryItem | undefined {
  return ($library.get()[scope] || []).find(item => item.ref && item.ref === (att.ref || att.name))
}

/** Preview mode: puts ready-made entries in the library (without real files behind them). */
export function seedLibrary(scope: string, items: (LibraryItem & { blob?: Blob })[]) {
  for (const { blob, ...item } of items) {
    memory.set(item.id, { ...item, blob: blob || new Blob([]) })
  }

  $library.set({ ...$library.get(), [scope]: [...($library.get()[scope] || []).filter(old => !items.some(item => item.id === old.id)), ...items.map(({ blob: _blob, ...item }) => item)] })
}
