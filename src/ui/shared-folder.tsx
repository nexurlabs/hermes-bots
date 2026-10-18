import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState, type DragEvent } from 'react'

import { humanSize } from '../lib/attachments'
import { cleanError, native } from '../lib/native'
import {
  $sharedFolder,
  deleteShared,
  ensureSharedFolder,
  isImageFile,
  isTextFile,
  listShared,
  readShared,
  uploadShared,
  type Preview,
  type SharedFile
} from '../lib/shared-folder'
import { Icon } from './icons'

/** "just now", "5 min ago", "3 h ago", then a date. */
export function ago(at: number | null, now = Date.now()): string {
  if (!at) {
    return ''
  }

  const minutes = Math.round((now - at) / 60_000)

  if (minutes < 1) {
    return 'just now'
  }

  if (minutes < 60) {
    return `${minutes} min ago`
  }

  if (minutes < 24 * 60) {
    return `${Math.round(minutes / 60)} h ago`
  }

  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()

  return date.toLocaleDateString([], { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

const fullDate = (at: number | null) => (at ? new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '')

function FileView({ file, onBack }: { file: SharedFile; onBack: () => void }) {
  const [state, setState] = useState<Preview | 'loading' | { error: string }>('loading')

  useEffect(() => {
    let live = true
    setState('loading')
    readShared(file)
      .then(result => live && setState(result))
      .catch(error => live && setState({ error: cleanError(error) }))

    return () => {
      live = false
    }
  }, [file.path])

  return (
    <div className="sf-view">
      <div className="sf-view-head">
        <button aria-label="Back to the folder" className="icon-btn sm ghost" onClick={onBack} type="button">
          <Icon name="back" />
        </button>
        <Icon className="sf-kind" name="file" />
        <div>
          <b>{file.name}</b>
          <small title={fullDate(file.mtime)}>
            {[file.size !== null ? humanSize(file.size) : '', file.mtime ? `changed ${ago(file.mtime)}` : ''].filter(Boolean).join(' · ')}
          </small>
        </div>
        <button className="btn sm ghost" onClick={() => void native.copyText(file.path)} title={file.path} type="button">
          Copy path
        </button>
      </div>
      {state === 'loading' ? (
        <div className="panel-empty">
          <span className="spinner xs" /> Opening…
        </div>
      ) : 'error' in state ? (
        <div className="banner bad">{state.error}</div>
      ) : state.kind === 'text' ? (
        <pre className="sf-text">{state.text || '(empty file)'}</pre>
      ) : state.kind === 'image' ? (
        <div className="sf-image">
          <img alt={file.name} src={state.dataUrl} />
        </div>
      ) : (
        <div className="panel-empty">{state.reason}</div>
      )}
    </div>
  )
}

/** `initial`: a file name to open once the folder has loaded (design preview). */
export function SharedFolderBody({ initial }: { initial?: string }) {
  const folder = useStore($sharedFolder)
  const [sub, setSub] = useState<string[]>([])
  const [files, setFiles] = useState<SharedFile[] | null>(null)
  const [open, setOpen] = useState<SharedFile | null>(null)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const refresh = async (where = sub) => {
    setError('')

    try {
      setFiles(await listShared(where))
    } catch (err) {
      setError(cleanError(err))
      setFiles(current => current || [])
    }
  }

  useEffect(() => {
    if (initial && files && !open) {
      const found = files.find(file => file.name === initial)

      if (found) {
        setOpen(found)
      }
    }
  }, [initial, files === null])

  useEffect(() => {
    void (folder.ready ? Promise.resolve() : ensureSharedFolder().catch(() => undefined)).then(() => refresh(sub))
  }, [sub.join('/')])

  const upload = async (list: FileList | File[] | null) => {
    const picked = [...(list || [])]

    if (!picked.length) {
      return
    }

    setBusy(picked.length === 1 ? `Uploading ${picked[0].name}…` : `Uploading ${picked.length} files…`)
    setError('')

    try {
      await uploadShared(sub, picked, files || [])
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy('')
      void refresh()
    }
  }

  const remove = async (file: SharedFile) => {
    setBusy(`Deleting ${file.name}…`)
    setError('')

    try {
      await deleteShared(file)
      setConfirm('')
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy('')
      void refresh()
    }
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    void upload(event.dataTransfer.files)
  }

  if (open) {
    return <FileView file={open} onBack={() => setOpen(null)} />
  }

  const crumbs = ['team-shared', ...sub]

  return (
    <>
      <div className="sf-bar">
        <div className="sf-crumbs">
          <Icon name="folder" />
          {crumbs.map((crumb, index) => (
            <span key={`${index}-${crumb}`}>
              {index ? <i>/</i> : null}
              {index < crumbs.length - 1 ? (
                <button className="sf-crumb" onClick={() => setSub(sub.slice(0, index))} type="button">
                  {crumb}
                </button>
              ) : (
                <b>{crumb}</b>
              )}
            </span>
          ))}
        </div>
        <button aria-label="Refresh" className="icon-btn sm ghost" disabled={Boolean(busy)} onClick={() => void refresh()} title="Refresh" type="button">
          <Icon name="refresh" />
        </button>
        <button className="btn sm" disabled={Boolean(busy) || !folder.path} onClick={() => input.current?.click()} type="button">
          <Icon name="upload" /> Upload
        </button>
        <input hidden multiple onChange={event => void upload(event.target.files).then(() => (event.target.value = ''))} ref={input} type="file" />
      </div>
      {folder.path ? (
        <button className="sf-path" onClick={() => void native.copyText(folder.path)} title="Copy the path" type="button">
          <code>{folder.path}</code>
          <Icon name="copy" />
        </button>
      ) : null}
      {error ? <div className="banner bad">{error}</div> : null}
      <div
        className="sf-list"
        data-dragging={dragging || undefined}
        onDragLeave={() => setDragging(false)}
        onDragOver={event => {
          event.preventDefault()
          setDragging(true)
        }}
        onDrop={onDrop}
      >
        {files === null ? (
          <div className="panel-empty">
            <span className="spinner xs" /> Loading…
          </div>
        ) : !files.length ? (
          <div className="panel-empty">{sub.length ? 'This folder is empty.' : 'Nothing here yet. Upload a file, or ask a bot to save one here for the team.'}</div>
        ) : (
          files.map(file =>
            confirm === file.path ? (
              <div className="sf-row sf-confirm" key={file.path}>
                <span>
                  Delete <b>{file.name}</b>
                  {file.dir ? ' and everything in it' : ''}? Every bot loses it too.
                </span>
                <button className="btn sm ghost" onClick={() => setConfirm('')} type="button">
                  Cancel
                </button>
                <button className="btn sm danger-solid" disabled={Boolean(busy)} onClick={() => void remove(file)} type="button">
                  Delete
                </button>
              </div>
            ) : (
              <div className="sf-row" key={file.path}>
                <button
                  className="sf-open"
                  onClick={() => (file.dir ? setSub([...sub, file.name]) : setOpen(file))}
                  title={file.dir ? `Open ${file.name}` : isTextFile(file) || isImageFile(file) ? `Preview ${file.name}` : file.name}
                  type="button"
                >
                  <Icon className="sf-kind" data-dir={file.dir || undefined} name={file.dir ? 'folder' : 'file'} />
                  <b>{file.name}</b>
                  <small>{file.dir ? 'Folder' : file.size !== null ? humanSize(file.size) : ''}</small>
                  <small title={fullDate(file.mtime)}>{ago(file.mtime)}</small>
                </button>
                <button aria-label={`Delete ${file.name}`} className="icon-btn xs ghost" onClick={() => setConfirm(file.path)} title="Delete" type="button">
                  <Icon name="trash" />
                </button>
              </div>
            )
          )
        )}
        {dragging ? <div className="sf-drop">Drop to upload here</div> : null}
      </div>
      {busy ? (
        <div className="sf-busy">
          <span className="spinner xs" /> {busy}
        </div>
      ) : null}
      <p className="mem-foot">
        Every bot is told where this folder is and can read and write it, so they can hand work to each other as files. It lives on your Hermes machine.
      </p>
    </>
  )
}
