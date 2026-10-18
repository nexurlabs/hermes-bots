/** Templates: Export as template, Import (preview → profile name → create → secrets), Duplicate. */
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { approvalLabel } from '../lib/botconfig'
import { cleanError } from '../lib/native'
import { $allBots, $selection, toast } from '../lib/store'
import {
  buildTemplate,
  createFromTemplate,
  freeProfileName,
  parseTemplate,
  profileNameProblem,
  saveTemplateFile,
  TEMPLATE_EXT,
  templateOfBot,
  type BotTemplate,
  type ExportResult,
  type ImportStep
} from '../lib/templates'
import { $dialog } from './dialogs'
import { BotFace } from './avatar-face'
import { Icon } from './icons'

const close = () => $dialog.set(null)

/** Reads a dropped or picked file and opens the import preview (or says why not). */
export async function openTemplateFile(file: File) {
  const parsed = parseTemplate(await file.text())

  if (typeof parsed === 'string') {
    toast(parsed, 'bad')

    return
  }

  $dialog.set({ kind: 'import-template', template: parsed })
}

export function pickTemplateFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = `${TEMPLATE_EXT},.json,application/json`
  input.onchange = () => input.files?.[0] && void openTemplateFile(input.files[0])
  input.click()
}

export async function duplicateBot(name: string) {
  try {
    const template = await templateOfBot(name)
    $dialog.set({ kind: 'import-template', template, duplicateOf: name })
  } catch (error) {
    toast(`Couldn't copy it: ${cleanError(error)}`, 'bad')
  }
}

const isTemplateFile = (file: File) => file.name.toLowerCase().endsWith(TEMPLATE_EXT)

/** Drop a .hermesbot.json anywhere on the app (before the composer would attach it). */
export function installTemplateDrop() {
  const hasTemplate = (event: DragEvent) => [...(event.dataTransfer?.items || [])].some(item => item.kind === 'file') && [...(event.dataTransfer?.files || [])].some(isTemplateFile)
  window.addEventListener(
    'drop',
    event => {
      const file = [...(event.dataTransfer?.files || [])].find(isTemplateFile)

      if (file) {
        event.preventDefault()
        event.stopPropagation()
        void openTemplateFile(file)
      }
    },
    true
  )
  window.addEventListener('dragover', event => hasTemplate(event) && event.preventDefault(), true)
}

function Face({ t, size = 64 }: { t: BotTemplate; size?: number }) {
  return t.bot.avatar ? (
    <img alt="" className="avatar-img" src={t.bot.avatar} style={{ width: size, height: size, borderRadius: size / 3 }} />
  ) : (
    <BotFace color={t.bot.color || '#8b5cf6'} image={null} mood="idle" name={t.bot.name || t.bot.display} shape={t.bot.shape || ''} size={size} />
  )
}

const triggerText = (r: BotTemplate['routines'][number]) => (r.trigger.kind === 'schedule' ? r.trigger.schedule : r.trigger.kind === 'github' ? `GitHub: ${r.trigger.events.join(', ')}` : 'Webhook')

/** The card both dialogs show: who it is and what comes with it. */
function TemplateCard({ t }: { t: BotTemplate }) {
  const mcp = Object.keys(t.mcpServers)

  return (
    <div className="tpl-card">
      <div className="tpl-head">
        <Face t={t} />
        <div>
          <b>{t.bot.display}</b>
          {t.bot.label ? <span className="tpl-label">{t.bot.label}</span> : null}
          {t.bot.description ? <p>{t.bot.description}</p> : null}
        </div>
      </div>
      <dl className="tpl-facts">
        <dt>Model</dt>
        <dd>{t.model.model ? `${t.model.model}${t.model.provider ? ` · ${t.model.provider}` : ''}` : "The main bot's"}</dd>
        <dt>Approvals</dt>
        <dd>{approvalLabel(t.approvals)}</dd>
        <dt>Tools</dt>
        <dd>{t.toolsets.pinned ? <Chips items={t.toolsets.enabled} /> : 'Hermes defaults'}</dd>
        <dt>Skills</dt>
        <dd>
          <Chips items={t.skills.enabled} more={t.skills.bundled.length ? `${t.skills.bundled.length} bundled` : ''} />
        </dd>
        <dt>Apps</dt>
        <dd>{mcp.length ? <Chips items={mcp} /> : 'None'}</dd>
        <dt>Routines</dt>
        <dd>
          {t.routines.length ? (
            <ul className="tpl-routines">
              {t.routines.map((r, i) => (
                <li key={i}>
                  <Icon name={r.trigger.kind === 'schedule' ? 'clock' : 'bolt'} size={12} /> <b>{r.name}</b> <small>{triggerText(r)}</small>
                </li>
              ))}
            </ul>
          ) : (
            'None'
          )}
        </dd>
        {t.memory ? (
          <>
            <dt>Memory</dt>
            <dd>{t.memory.notes.split('\n').filter(Boolean).length} notes</dd>
          </>
        ) : null}
        <dt>Secrets</dt>
        <dd>
          {t.requiredSecrets.length ? (
            <ul className="tpl-secrets">
              {t.requiredSecrets.map(s => (
                <li key={s.name}>
                  <Icon name="key" size={12} /> <code>{s.name}</code> {s.usedBy ? <small>{s.usedBy}</small> : null}
                </li>
              ))}
            </ul>
          ) : (
            'None needed'
          )}
        </dd>
      </dl>
    </div>
  )
}

function Chips({ items, more }: { items: string[]; more?: string }) {
  const shown = items.slice(0, 8)

  return (
    <span className="tpl-chips">
      {shown.map(item => (
        <span className="chip-s" key={item}>
          {item}
        </span>
      ))}
      {items.length > shown.length ? <span className="chip-s ghost">+{items.length - shown.length}</span> : null}
      {more ? <span className="chip-s ghost">{more}</span> : null}
      {!items.length && !more ? 'None' : null}
    </span>
  )
}

export function ExportTemplate({ name }: { name: string }) {
  const bot = useStore($allBots).find(b => b.name === name)
  const [memory, setMemory] = useState(false)
  const [bundle, setBundle] = useState(true)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setResult(null)
    setError('')
    buildTemplate(name, { memory, bundleSkills: bundle })
      .then(r => live && setResult(r))
      .catch(e => live && setError(cleanError(e)))

    return () => {
      live = false
    }
  }, [name, memory, bundle])

  const save = async () => {
    if (!result) return
    setBusy(true)
    try {
      const saved = await saveTemplateFile(result.template)
      if (saved?.ok) {
        toast(`Saved ${bot?.display || name}'s template${saved && 'path' in saved && saved.path ? ` to ${saved.path}` : ''}`, 'good')
        close()
      }
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {result ? <TemplateCard t={result.template} /> : error ? null : <div className="thread-loading"><span className="spinner" /></div>}
      <div className="tpl-options">
        <label className="tpl-check">
          <input checked={bundle} onChange={e => setBundle(e.target.checked)} type="checkbox" /> Bundle custom skill files
          <small>Skills this bot has that the main bot doesn't (text files, up to 256 KB each skill).</small>
        </label>
        <label className="tpl-check">
          <input checked={memory} onChange={e => setMemory(e.target.checked)} type="checkbox" /> Include memory notes
          <small>The bot's own notes (MEMORY.md). What it knows about you (USER.md) is never included.</small>
        </label>
      </div>
      <div className="tpl-never">
        <Icon name="shield" size={14} />
        <span>
          Never included: API keys, tokens, .env values, OAuth sign-ins, chat history, webhook URLs and secrets. MCP secrets become <code>{'${NAME}'}</code> placeholders the
          importer fills in.
        </span>
      </div>
      {result?.stripped.length ? (
        <div className="banner warn">
          <span className="banner-text">
            The secret scan removed {result.stripped.length} thing{result.stripped.length === 1 ? '' : 's'} that looked like a credential: {result.stripped.slice(0, 4).join('; ')}
            {result.stripped.length > 4 ? '…' : ''}
          </span>
        </div>
      ) : null}
      {result?.notes.length ? (
        <ul className="tpl-notes">
          {result.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
      {error ? <div className="banner bad">{error}</div> : null}
      <div className="sheet-actions">
        <button className="btn ghost" onClick={close} type="button">
          Cancel
        </button>
        <button className="btn primary" disabled={!result || busy} onClick={() => void save()} type="button">
          {busy ? <span className="spinner xs" /> : <Icon name="download" size={15} />} Save {TEMPLATE_EXT}
        </button>
      </div>
    </>
  )
}

export function ImportTemplate({ template, duplicateOf }: { template: BotTemplate; duplicateOf?: string }) {
  const [display, setDisplay] = useState(duplicateOf ? `${template.bot.display} (copy)` : template.bot.display)
  const [profile, setProfile] = useState(() => freeProfileName(duplicateOf ? `${template.bot.name}-copy` : template.bot.name || template.bot.display))
  const [steps, setSteps] = useState<ImportStep[] | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState<null | { name: string; warnings: string[] }>(null)
  const [host, setHost] = useState(() => (duplicateOf ? hostOf(duplicateOf) : $defaultHost.get()))
  const problem = profileNameProblem(profile, host) || (!isHostOnline(host) ? `${machineLabel(host)} is offline` : '')

  const create = async () => {
    setError('')
    try {
      const made = await createFromTemplate(template, botNameOn(profile, host), display.trim() || template.bot.display, setSteps)
      setDone(made)
      toast(`${display.trim() || made.name} is ready${template.requiredSecrets.length ? '. Enter its secrets in the chat' : ''}`, 'good')
    } catch (e) {
      setError(cleanError(e))
    }
  }

  return (
    <>
      <TemplateCard t={template} />
      {!steps ? (
        <div className="editor-row">
          <label className="field">
            <span>Name</span>
            <input className="input" onChange={e => setDisplay(e.target.value)} value={display} />
          </label>
          <label className="field">
            <span>Profile name</span>
            <input className="input" onChange={e => setProfile(e.target.value.toLowerCase())} value={profile} />
            <small data-bad={problem || undefined}>{problem || `The Hermes profile: hermes -p ${profile}`}</small>
          </label>
          <MachineField onChange={setHost} value={host} />
        </div>
      ) : (
        <ol className="tpl-steps">
          {steps.map((s, i) => (
            <li data-state={s.state} key={i}>
              {s.state === 'doing' ? <span className="spinner xs" /> : s.state === 'done' ? <Icon name="check" size={13} /> : s.state === 'warn' ? <span className="warn-dot">!</span> : <span className="todo-dot" />}
              <span>
                {s.label}
                {s.note ? <small>{s.note}</small> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
      {!steps ? (
        <small className="tpl-hint">
          The new bot starts from the main bot's credentials and built-in skills, then takes this template's setup.
          {template.requiredSecrets.length ? ` You'll be asked for ${template.requiredSecrets.length} secret${template.requiredSecrets.length === 1 ? '' : 's'} in its chat, through the secure card.` : ''}
        </small>
      ) : null}
      {error ? <div className="banner bad">{error}</div> : null}
      <div className="sheet-actions">
        {done ? (
          <button
            className="btn primary"
            onClick={() => {
              $selection.set({ kind: 'bot', id: done.name })
              close()
            }}
            type="button"
          >
            Open {display || done.name}
          </button>
        ) : (
          <>
            <button className="btn ghost" disabled={!!steps && !error} onClick={close} type="button">
              Cancel
            </button>
            <button className="btn primary" disabled={!!problem || (!!steps && !error)} onClick={() => void create()} type="button">
              {steps && !error ? <span className="spinner xs" /> : null}
              {duplicateOf ? 'Duplicate bot' : 'Create bot'}
            </button>
          </>
        )}
      </div>
    </>
  )
}

import { $defaultHost, botNameOn, hostOf, isHostOnline, machineLabel } from '../lib/hosts'
import { MachineField } from './machines'
