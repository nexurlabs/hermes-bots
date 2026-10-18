/**
 * Routines: one bot's scheduled and one-time tasks (in its settings), and the form for a new one.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { $botConfig, isLoaded } from '../lib/botconfig'
import { cleanError } from '../lib/native'
import {
  $routines,
  $runningNow,
  $schedulerNote,
  createParkedRoutine,
  createRoutine,
  isPaused,
  loadRoutineDetail,
  isRoutineList,
  lastRunText,
  loadRoutines,
  onOtherClock,
  removeRoutine,
  type Routine,
  runNow,
  scheduleText,
  type RoutineSchedule,
  setPaused,
  updateRoutine,
  whenText,
  cronToText
} from '../lib/routines'
import { $allBots, $bots, toast } from '../lib/store'
import { $hooks, basePrompt, configureHooks, EVENT_SCHEDULE, GITHUB_EVENTS, hookFor, hookUrl, isEventSchedule, putHook, refreshHooks, removeHook, sendTestEvent } from '../lib/event-routines'
import type { HookInfo, HooksView } from '../lib/native'
import { Seg } from './controls'
import { Icon } from './icons'

type Run = (work: () => Promise<unknown>) => Promise<boolean>

function deliveryNote(routine: Routine, who: string) {
  const target = routine.deliver.toLowerCase()

  if (target.split(',').some(part => part.trim().startsWith('bot-chat'))) {
    return ''
  }

  return target === 'local' || !target ? `Results stay on Hermes and don't come to ${who}'s chat.` : `Results go to ${routine.deliver}.`
}

function RoutineCard({ name, routine, save, onEdit }: { name: string; routine: Routine; save: Run; onEdit: (routine: Routine) => void }) {
  const running = useStore($runningNow)[routine.id]
  const bot = useStore($allBots).find(b => b.name === name)
  const [confirm, setConfirm] = useState(false)
  const paused = isPaused(routine)
  const done = routine.state === 'completed'
  const last = lastRunText(routine)
  const note = deliveryNote(routine, bot?.display || name)
  const hooks = useStore($hooks)
  const event = isEventSchedule(routine.schedule)
  const hook = event ? hookFor(hooks, name, routine.id) : undefined
  const next = paused ? 'Paused' : done ? 'Finished' : event ? '' : routine.nextRunAt ? `Next: ${whenText(routine.nextRunAt)}` : ''

  return (
    <div className="routine" data-paused={paused || done || undefined}>
      <div className="routine-top">
        <b>{routine.name}</b>
        {paused ? <span className="chip-s">Paused</span> : done ? <span className="chip-s">Done</span> : null}
      </div>
      {event ? (
        <div className="routine-when" data-event>
          <Icon name="bolt" size={13} />
          <span>{hook ? triggerText(hook) : 'On an event (set up on another computer)'}</span>
        </div>
      ) : (
        <div className="routine-when">
          <Icon name="clock" size={13} />
          <span>
            {scheduleText(routine)}
            {onOtherClock(routine) && !routine.schedule.toLowerCase().startsWith('once') ? ' (Hermes time)' : ''}
          </span>
        </div>
      )}
      {event && hook && hooks ? <HookBox hook={hook} view={hooks} /> : null}
      <div className="routine-meta">
        {running ? (
          <span>
            <span className="spinner xs" /> Running now…
          </span>
        ) : (
          <>
            {next ? <span>{next}</span> : null}
            <span data-bad={last.bad || undefined}>{last.text}</span>
          </>
        )}
      </div>
      {routine.prompt && routine.prompt !== routine.name ? <p className="routine-prompt">{basePrompt(routine.prompt)}</p> : null}
      {note ? <small className="routine-note">{note}</small> : null}
      {confirm ? (
        <div className="routine-confirm">
          <span>Delete this routine? It won't run again.</span>
          <button className="btn sm ghost" onClick={() => setConfirm(false)} type="button">
            Cancel
          </button>
          <button className="btn sm danger-solid" onClick={() => void save(async () => { await removeRoutine(name, routine); if (hook) await removeHook(hook.token) })} type="button">
            Delete
          </button>
        </div>
      ) : (
        <div className="routine-actions">
          {!done ? (
            <button className="btn sm" onClick={() => void save(() => setPaused(name, routine, !paused))} type="button">
              {paused ? 'Resume' : 'Pause'}
            </button>
          ) : null}
          {!done ? (
            <button
              className="btn sm ghost"
              disabled={running}
              onClick={() =>
                void runNow(name, routine)
                  .then(outcome =>
                    toast(
                      outcome === 'done' ? `${routine.name} ran. The result goes to ${bot?.display || name}'s chat.` : `${routine.name} is still running on Hermes.`,
                      'good'
                    )
                  )
                  .catch(err => toast(`Couldn't run it: ${cleanError(err)}`, 'bad'))
              }
              type="button"
            >
              <Icon name="play" size={13} /> Run now
            </button>
          ) : null}
          <span className="grow" />
          {!done ? (
            <button aria-label="Edit routine" className="icon-btn xs ghost" onClick={() => onEdit(routine)} title="Edit" type="button">
              <Icon name="edit" size={13} />
            </button>
          ) : null}
          <button aria-label="Delete routine" className="icon-btn xs ghost" onClick={() => setConfirm(true)} title="Delete" type="button">
            <Icon name="trash" size={13} />
          </button>
        </div>
      )}
    </div>
  )
}

const GITHUB_LABEL = Object.fromEntries(GITHUB_EVENTS)

function triggerText(hook: HookInfo) {
  return hook.kind === 'github' ? `On GitHub: ${hook.events.map(e => GITHUB_LABEL[e] || e).join(', ') || 'any event'}` : 'On webhook (any POST)'
}

function lastFiredText(hook: HookInfo) {
  return hook.lastFired ? `Last fired ${whenText(new Date(hook.lastFired).toISOString())}${hook.lastEvent && hook.lastEvent !== 'webhook' ? ` (${hook.lastEvent})` : ''}` : 'Not fired yet'
}

/** The routine's secret URL with Copy, Send test event and when it last fired. */
function HookBox({ hook, view }: { hook: HookInfo; view: HooksView }) {
  const [busy, setBusy] = useState(false)
  const url = hookUrl(view, hook.token)

  return (
    <div className="hook-box">
      <div className="hook-url">
        <code title={url}>{url}</code>
        <button
          aria-label="Copy URL"
          className="icon-btn xs ghost"
          onClick={() => void navigator.clipboard.writeText(url).then(() => toast('Webhook URL copied. Keep it private: anyone with it can run this routine.', 'good'))}
          title="Copy URL"
          type="button"
        >
          <Icon name="copy" size={13} />
        </button>
      </div>
      <div className="hook-meta">
        <span>{lastFiredText(hook)}</span>
        {hook.hasSecret ? <span className="chip-s">Signed</span> : null}
        {!view.running ? <span className="bad-text">{view.error ? `Listener off: ${view.error}` : 'Listener off'}</span> : null}
        <span className="grow" />
        <button
          className="btn sm ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void sendTestEvent(hook)
              .then(result => toast(result.status === 'ignored' ? 'Test sent, but this routine ignores that event.' : 'Test event sent. The routine is running; the result goes to the chat.', 'good'))
              .catch(err => toast(cleanError(err), 'bad'))
              .finally(() => {
                setBusy(false)
                void refreshHooks()
              })
          }}
          type="button"
        >
          {busy ? <span className="spinner xs" /> : <Icon name="bolt" size={13} />} Send test event
        </button>
      </div>
    </div>
  )
}

export function RoutinesPane({ name, save, onNew, onEdit }: { name: string; save: Run; onNew: () => void; onEdit: (routine: Routine) => void }) {
  const state = useStore($routines)[name]
  const note = useStore($schedulerNote)
  const bot = useStore($allBots).find(b => b.name === name)
  const who = bot?.display || name

  useEffect(() => {
    void loadRoutines(name, true)
  }, [name])

  return (
    <div className="pane">
      <header className="pane-head-row">
        <div>
          <h3>Routines</h3>
          <p>Tasks {who} runs by itself, on a schedule or once. Results arrive in your chat with {who}.</p>
        </div>
        <button className="btn sm primary" onClick={onNew} type="button">
          <Icon name="plus" size={14} /> New routine
        </button>
      </header>
      {note ? (
        <div className="banner warn">
          <span className="banner-text">{note}</span>
        </div>
      ) : null}
      {isRoutineList(state) ? (
        state.length ? (
          <div className="routine-list">
            {state.map(routine => (
              <RoutineCard key={routine.id} name={name} onEdit={onEdit} routine={routine} save={save} />
            ))}
          </div>
        ) : (
          <div className="panel-empty">Nothing yet. Add one here, or ask {who} to “check my inbox every morning at 9”.</div>
        )
      ) : state && typeof state === 'object' ? (
        <div className="panel-empty">
          {state.error}{' '}
          <button className="link-btn" onClick={() => void loadRoutines(name, true)} type="button">
            Try again
          </button>
        </div>
      ) : (
        <div className="thread-loading">
          <span className="spinner" />
        </div>
      )}
    </div>
  )
}

// ── new routine ───────────────────────────────────────────────────────────
type Repeat = 'custom' | 'day' | 'hour' | 'week' | 'weekdays'

const REPEATS: [Repeat, string][] = [
  ['day', 'Every day'],
  ['weekdays', 'Weekdays'],
  ['week', 'Every week'],
  ['hour', 'Every hour'],
  ['custom', 'Custom']
]

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const pad = (n: number) => String(n).padStart(2, '0')

function localInput(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** "2026-10-09T18:00" (this computer's time) → an ISO time with this computer's UTC offset. */
function withOffset(value: string) {
  const at = new Date(value)
  const minutes = -at.getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'

  return `${value}:00${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
}

interface ScheduleForm {
  mode: 'once' | 'repeat'
  repeat: Repeat
  time: string
  weekday: number
  custom: string
  once: string
}

/** What the form sends Hermes for its schedule. */
export function buildSchedule(form: ScheduleForm): string {
  if (form.mode === 'once') {
    return form.once ? withOffset(form.once) : ''
  }

  const [h, m] = form.time.split(':').map(Number)

  switch (form.repeat) {
    case 'day':
      return `${m} ${h} * * *`
    case 'weekdays':
      return `${m} ${h} * * 1-5`
    case 'week':
      return `${m} ${h} * * ${form.weekday}`
    case 'hour':
      return '0 * * * *'
    default:
      return form.custom.trim()
  }
}

/** The form filled in from a routine's stored schedule: the matching preset, or Custom with Hermes's own text.
 *  Repeating times are on Hermes's clock and stay as written, as in the new-routine form.
 */
export function formFromSchedule(schedule: RoutineSchedule, base: ScheduleForm): ScheduleForm {
  if (schedule.kind === 'once' && schedule.runAt) {
    // One-time runs are an exact moment, shown in this computer's time like the new-routine form.
    const at = new Date(schedule.runAt)

    return Number.isNaN(at.getTime()) ? base : { ...base, mode: 'once', once: localInput(at) }
  }

  if (schedule.kind === 'interval' && schedule.minutes) {
    return { ...base, mode: 'repeat', repeat: 'custom', custom: `every ${schedule.minutes}m` }
  }

  const expr = (schedule.expr || schedule.display).trim().replace(/\s+/g, ' ')
  const timed = expr.match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/)

  if (timed && Number(timed[1]) < 60 && Number(timed[2]) < 24) {
    const time = `${pad(Number(timed[2]))}:${pad(Number(timed[1]))}`

    if (timed[3] === '*') {
      return { ...base, mode: 'repeat', repeat: 'day', time }
    }

    return timed[3] === '1-5' ? { ...base, mode: 'repeat', repeat: 'weekdays', time } : { ...base, mode: 'repeat', repeat: 'week', time, weekday: Number(timed[3]) }
  }

  if (expr === '0 * * * *') {
    return { ...base, mode: 'repeat', repeat: 'hour' }
  }

  return expr ? { ...base, mode: 'repeat', repeat: 'custom', custom: expr } : base
}

function freshForm(): ScheduleForm {
  const at = new Date(Date.now() + 86_400_000)
  at.setHours(9, 0, 0, 0)

  return { mode: 'repeat', repeat: 'day', time: '09:00', weekday: 1, custom: '', once: localInput(at) }
}

/** The new-routine form; given a routine, the same form edits it (bot fixed, delivery untouched). */
export function RoutineEditor({ name, routine, onClose }: { name: string; routine?: Routine; onClose: () => void }) {
  const bots = useStore($bots)
  const configs = useStore($botConfig)
  const [bot, setBot] = useState(name)
  const [prompt, setPrompt] = useState(routine?.prompt || '')
  const [title, setTitle] = useState(routine?.name || '')
  const [form, setForm] = useState<ScheduleForm>(freshForm)
  const { mode, repeat, time, weekday, custom, once } = form
  const field =
    <K extends keyof ScheduleForm>(key: K) =>
    (value: ScheduleForm[K]) =>
      setForm(f => ({ ...f, [key]: value }))
  const [setMode, setRepeat, setTime, setWeekday, setCustom, setOnce] = [field('mode'), field('repeat'), field('time'), field('weekday'), field('custom'), field('once')]
  // Editing: what the routine had, to send only what changed. Null until Hermes's copy has loaded.
  const [original, setOriginal] = useState<null | { name: string; prompt: string; schedule: string }>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hooks = useStore($hooks)
  const wasEvent = Boolean(routine && isEventSchedule(routine.schedule))
  const existingHook = routine ? hookFor(hooks, name, routine.id) : undefined
  const [trigger, setTrigger] = useState<'schedule' | 'event'>(wasEvent ? 'event' : 'schedule')
  const [kind, setKind] = useState<'webhook' | 'github' | 'email'>(existingHook?.kind || 'github')
  const [events, setEvents] = useState<string[]>(existingHook?.events.length ? existingHook.events : ['pull_request.opened'])
  const [secret, setSecret] = useState('')

  useEffect(() => {
    void refreshHooks().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (existingHook) {
      setKind(existingHook.kind)
      setEvents(existingHook.events.length ? existingHook.events : ['*'])
    }
  }, [existingHook?.token])

  useEffect(() => {
    if (!routine) {
      return
    }

    let live = true
    setOriginal(null)
    void loadRoutineDetail(name, routine)
      .then(detail => {
        if (!live) {
          return
        }

        const filled = formFromSchedule(detail.schedule, freshForm())
        setTitle(detail.name)
        setPrompt(basePrompt(detail.prompt))
        setForm(filled)
        setOriginal({ name: detail.name, prompt: basePrompt(detail.prompt), schedule: buildSchedule(filled) })
      })
      .catch(err => live && setError(`Couldn't load this routine from Hermes: ${cleanError(err)}`))

    return () => {
      live = false
    }
  }, [name, routine])
  const who = bots.find(b => b.name === bot)?.display || bot
  const cfg = configs[bot]
  const hermesZone = isLoaded(cfg) ? cfg.timezone || '' : ''
  const myZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  const schedule = useMemo(() => buildSchedule(form), [form])

  const eventSummary = kind === 'github' ? `On GitHub: ${events.map(e => GITHUB_LABEL[e] || e).join(', ') || 'any event'}` : 'Whenever its webhook URL gets a POST'
  const summary = trigger === 'event' ? eventSummary : mode === 'once' ? (once ? `Once, ${whenText(new Date(once).toISOString())}` : '') : cronToText(schedule) || (schedule ? schedule : '')

  const editing = Boolean(routine)
  const loading = editing && !original && !error
  const label = title.trim() || prompt.trim().replace(/\s+/g, ' ').slice(0, 48)

  const saveEdit = async () => {
    if (!routine || !original) {
      return
    }

    const changes = {
      name: label !== original.name ? label : undefined,
      prompt: prompt.trim() !== original.prompt.trim() ? prompt.trim() : undefined,
      schedule: trigger === 'event' ? (wasEvent ? undefined : EVENT_SCHEDULE) : schedule !== original.schedule || wasEvent ? schedule : undefined
    }

    await updateRoutine(bot, routine, changes)

    if (trigger === 'event') {
      await saveHook(routine.id)
    } else if (existingHook) {
      await removeHook(existingHook.token)
    }

    toast(changes.name || changes.prompt || changes.schedule ? `Saved. ${who} will run it ${summary.charAt(0).toLowerCase()}${summary.slice(1)}.` : 'Nothing changed.', 'good')
    onClose()
  }

  const saveHook = (routineId: string) =>
    putHook({ token: existingHook?.token, bot, routineId, kind: kind === 'github' ? 'github' : 'webhook', events: kind === 'github' ? events : [], ...(secret ? { secret } : {}) })

  const save = async () => {
    setError('')

    if (trigger === 'event' && kind === 'email') {
      setError('Email triggers are coming soon.')

      return
    }

    if (trigger === 'event' && !editing) {
      setBusy(true)

      try {
        const id = await createParkedRoutine({ bot, name: label, prompt: prompt.trim(), schedule: EVENT_SCHEDULE })
        await saveHook(id)
        toast(`Routine added. Copy its webhook URL from the routine card${kind === 'github' ? ' into your repo\'s Settings → Webhooks' : ''}.`, 'good')
        onClose()
      } catch (err) {
        setError(cleanError(err))
      } finally {
        setBusy(false)
      }

      return
    }

    if (mode === 'once' && new Date(once).getTime() <= Date.now() && !(original && schedule === original.schedule)) {
      setError('Pick a time in the future.')

      return
    }

    setBusy(true)

    if (editing) {
      try {
        await saveEdit()
      } catch (err) {
        setError(cleanError(err))
      } finally {
        setBusy(false)
      }

      return
    }

    try {
      const warning = await createRoutine({ bot, name: label, prompt: prompt.trim(), schedule })
      toast(warning || `Routine added. ${who} will run it ${summary.charAt(0).toLowerCase()}${summary.slice(1)}.`, warning ? 'bad' : 'good')
      onClose()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <label className="field">
        <span>What should it do?</span>
        <textarea
          autoFocus
          className="input area"
          disabled={loading}
          onChange={e => setPrompt(e.target.value)}
          placeholder="e.g. Check my inbox and give me a short summary of what needs a reply"
          rows={3}
          value={prompt}
        />
        <small>It runs in a fresh chat with no memory of this one, so say everything it needs.</small>
      </label>
      <div className="routine-form-row">
        <label className="field">
          <span>Name</span>
          <input className="input" disabled={loading} onChange={e => setTitle(e.target.value)} placeholder="e.g. Morning inbox" value={title} />
        </label>
        <label className="field">
          <span>Who runs it</span>
          <select
            className="input"
            disabled={editing}
            onChange={e => setBot(e.target.value)}
            title={editing ? 'A routine stays with the bot that runs it. To move it, add it to the other bot and delete this one.' : undefined}
            value={bot}
          >
            {bots.map(b => (
              <option key={b.name} value={b.name}>
                {b.display}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <span>When</span>
        <Seg
          onChange={setTrigger}
          options={[
            ['schedule', 'Schedule'],
            ['event', 'Event']
          ]}
          value={trigger}
        />
      </div>
      {trigger === 'event' ? (
        <EventFields
          events={events}
          hook={existingHook}
          kind={kind}
          secret={secret}
          setEvents={setEvents}
          setKind={setKind}
          setSecret={setSecret}
          view={hooks}
        />
      ) : (
      <div className="field">
        <Seg
          onChange={setMode}
          options={[
            ['repeat', 'Repeats'],
            ['once', 'Once']
          ]}
          value={mode}
        />
        {mode === 'repeat' ? (
          <>
            <div className="chips left">
              {REPEATS.map(([id, label]) => (
                <button className="chip" data-on={repeat === id || undefined} key={id} onClick={() => setRepeat(id)} type="button">
                  {label}
                </button>
              ))}
            </div>
            {repeat === 'custom' ? (
              <input className="input" onChange={e => setCustom(e.target.value)} placeholder="Cron like 30 8 * * 1-5, or every 2h" value={custom} />
            ) : repeat !== 'hour' ? (
              <div className="inline-field">
                {repeat === 'week' ? (
                  <select className="input" onChange={e => setWeekday(Number(e.target.value))} value={weekday}>
                    {WEEKDAYS.map((day, i) => (
                      <option key={day} value={i}>
                        {day}
                      </option>
                    ))}
                  </select>
                ) : null}
                <input className="input narrow-time" onChange={e => setTime(e.target.value || '09:00')} type="time" value={time} />
              </div>
            ) : null}
            {hermesZone && hermesZone !== myZone ? <small>Repeating times use Hermes's clock ({hermesZone}).</small> : null}
          </>
        ) : (
          <input className="input" min={localInput(new Date())} onChange={e => setOnce(e.target.value)} type="datetime-local" value={once} />
        )}
      </div>
      )}
      {summary ? (
        <div className="routine-summary">
          <Icon name={trigger === 'event' ? 'bolt' : 'clock'} size={14} />
          <span>
            {summary}. The result goes to your chat with {who}.
          </span>
        </div>
      ) : null}
      {error ? <div className="banner bad">{error}</div> : null}
      <div className="sheet-actions">
        <button className="btn ghost" onClick={onClose} type="button">
          Cancel
        </button>
        <button className="btn primary" disabled={busy || loading || (editing && !original) || !prompt.trim() || (trigger === 'schedule' ? !schedule : kind === 'email' || (kind === 'github' && !events.length))} onClick={() => void save()} type="button">
          {busy || loading ? <span className="spinner xs" /> : null}
          {editing ? 'Save changes' : 'Add routine'}
        </button>
      </div>
    </>
  )
}

function EventFields({
  kind,
  setKind,
  events,
  setEvents,
  secret,
  setSecret,
  hook,
  view
}: {
  kind: 'webhook' | 'github' | 'email'
  setKind: (kind: 'webhook' | 'github' | 'email') => void
  events: string[]
  setEvents: (events: string[]) => void
  secret: string
  setSecret: (secret: string) => void
  hook?: HookInfo
  view: HooksView | null
}) {
  const toggle = (id: string) =>
    setEvents(id === '*' ? (events.includes('*') ? [] : ['*']) : events.includes(id) ? events.filter(e => e !== id) : [...events.filter(e => e !== '*'), id])
  const [port, setPort] = useState(String(view?.port || 8648))

  return (
    <div className="field event-fields">
      <div className="chips left">
        {(
          [
            ['github', 'GitHub'],
            ['webhook', 'Webhook'],
            ['email', 'Email']
          ] as const
        ).map(([id, label]) => (
          <button className="chip" data-on={kind === id || undefined} key={id} onClick={() => setKind(id)} type="button">
            {label}
            {id === 'email' ? <small className="soon">soon</small> : null}
          </button>
        ))}
      </div>
      {kind === 'email' ? (
        <small>Coming soon. Hermes can read email as a chat platform, but there's no way yet to start a routine from a new email.</small>
      ) : null}
      {kind === 'github' ? (
        <>
          <span className="sub-label">Run on</span>
          <div className="chips left">
            {GITHUB_EVENTS.map(([id, label]) => (
              <button className="chip" data-on={events.includes(id) || undefined} key={id} onClick={() => toggle(id)} type="button">
                {label}
              </button>
            ))}
          </div>
          <label className="field">
            <span className="sub-label">Webhook secret {hook?.hasSecret ? '(saved; type to replace)' : '(optional, recommended)'}</span>
            <input
              autoComplete="off"
              className="input"
              onChange={e => setSecret(e.target.value)}
              placeholder={hook?.hasSecret ? '••••••••' : 'The same secret you enter in GitHub'}
              type="password"
              value={secret}
            />
            <small>Checked against GitHub's X-Hub-Signature-256. It's kept encrypted on this computer and never shown in chat.</small>
          </label>
        </>
      ) : null}
      {kind === 'webhook' ? <small>Any POST to the routine's URL runs it. The request body (JSON shown pretty, up to 4,000 characters) is added to the prompt for that run.</small> : null}
      {hook && view ? <HookBox hook={hook} view={view} /> : kind !== 'email' ? <small>The secret URL appears here and on the routine card after you add it.</small> : null}
      {kind !== 'email' && view ? (
        <details className="hook-advanced">
          <summary>Listener: {view.lan ? 'all networks' : 'this computer only'}, port {view.port}</summary>
          <div className="inline-field">
            <input className="input narrow-time" onChange={e => setPort(e.target.value)} value={port} />
            <label className="hook-check">
              <input checked={view.lan} onChange={e => void configureHooks(Number(port) || view.port, e.target.checked)} type="checkbox" /> Accept from other machines
            </label>
            <button className="btn sm ghost" onClick={() => void configureHooks(Number(port) || view.port, view.lan)} type="button">
              Apply
            </button>
          </div>
          <small>
            The URL is served by this app, so it must be running, and the sender has to reach this computer. For GitHub that usually means a tunnel (e.g. cloudflared or ngrok) to port {view.port}. To run without the app, set it up on the Hermes host with
            <code> hermes webhook subscribe &lt;name&gt; --cron-job &lt;routine id&gt; --events pull_request</code>.
          </small>
        </details>
      ) : null}
    </div>
  )
}
