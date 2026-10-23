/**
 * Routines: scheduled or one-time tasks a bot runs on its own, on Hermes's cron scheduler.
 *
 * Each bot's routines are the cron jobs in its own profile, managed with the `cron.manage` RPC
 * (list / add / pause / resume / remove). `cron.manage` has no run or update action, so "Run now"
 * and Edit use Hermes's dashboard endpoints: `POST /api/cron/jobs/{id}/trigger`, and
 * `GET` / `PUT /api/cron/jobs/{id}` (the same update the cronjob tool's `update` action does).
 * Routines the app creates deliver to `bot-chat`, so the result comes back into that bot's 1:1
 * chat. An edit never sends `deliver`, so that stays as it was.
 */
import { atom } from 'nanostores'

import { gateway } from './gateway'
import { native } from './native'
import { hostHttp } from './hosts'
import { $active, $profiles } from './store'

export interface Routine {
  id: string
  name: string
  prompt: string
  /** Hermes's schedule text: a cron expression, "every 30m", "once at 2026-10-09 18:00", … */
  schedule: string
  deliver: string
  repeat: string
  nextRunAt: string
  lastRunAt: string
  /** ok, error, delivery_failed, or '' before the first run. */
  lastStatus: string
  lastError: string
  enabled: boolean
  /** scheduled, paused, completed or error. */
  state: string
}

type RoutineState = Routine[] | 'loading' | { error: string }

export const $routines = atom<Record<string, RoutineState>>({})
/** Hermes's note when its scheduler isn't running (routines won't fire on their own). */
export const $schedulerNote = atom('')
/** Routines with a "Run now" in flight. */
export const $runningNow = atom<Record<string, boolean>>({})

export const isRoutineList = (state: RoutineState | undefined): state is Routine[] => Array.isArray(state)

const text = (value: unknown) => (value === null || value === undefined ? '' : String(value))

function fromRow(row: any): Routine {
  return {
    id: text(row.job_id || row.id),
    // Older app versions tagged jobs with the bot's name; that's noise now.
    name: text(row.name || row.prompt_preview || row.job_id).replace(/^\[bot:[^\]]+\]\s*/, ''),
    prompt: text(row.prompt_preview || row.prompt),
    schedule: text(row.schedule || row.schedule_display),
    deliver: text(row.deliver || 'local'),
    repeat: text(row.repeat),
    nextRunAt: text(row.next_run_at),
    lastRunAt: text(row.last_run_at),
    lastStatus: text(row.last_status),
    lastError: text(row.last_error || row.last_delivery_error || row.last_fire_error),
    enabled: row.enabled !== false,
    state: text(row.state) || (row.enabled === false ? 'paused' : 'scheduled')
  }
}

export const isPaused = (r: Routine) => r.state === 'paused' || (!r.enabled && r.state !== 'completed')

let preview = false

export function seedRoutinesPreview(bots: Record<string, Routine[]>, note = '') {
  preview = true
  $routines.set(bots)
  $schedulerNote.set(note)
}

const put = (name: string, state: RoutineState) => $routines.set({ ...$routines.get(), [name]: state })

function patch(name: string, id: string, change: Partial<Routine> | null) {
  const list = $routines.get()[name]

  if (isRoutineList(list)) {
    put(name, change ? list.map(r => (r.id === id ? { ...r, ...change } : r)) : list.filter(r => r.id !== id))
  }
}

/** What the person reads when Hermes's scheduler is down (Hermes's own warning is written for the bot). */
export const SCHEDULER_DOWN_NOTE =
  "Hermes's scheduler isn't running, so routines won't fire on their own yet. Open Hermes on its machine (or run `hermes gateway start` there) to turn it on."
const SCHEDULER_STARTING_NOTE = "Hermes's scheduler wasn't running; starting it now so routines fire on time."

/** Hermes reports `gateway_running: false` when no gateway (its cron ticker) is up. */
export const schedulerDown = (result: any) => result?.gateway_running === false

/** Live = would fire later: not paused, not finished. */
export const hasLiveRoutines = (list: Routine[]) => list.some(r => !isPaused(r) && r.state !== 'completed')

/** Test seam for the scheduler start (the Electron bridge in the app). */
let ensureImpl: (() => Promise<{ ok: boolean; state: string }>) | null = null

export function setEnsureGatewayForTests(fn: typeof ensureImpl) {
  ensureImpl = fn
}

let ensuring: Promise<boolean> | null = null

/**
 * Starts Hermes's gateway (which runs the cron ticker) when it isn't running. Only this computer's
 * Hermes can be started from here; for another machine the note asks the person to start it there.
 * Hermes's `gateway ensure` starts it without the idle exit, so it stays up while the app runs.
 */
export async function ensureScheduler(): Promise<boolean> {
  const run = ensureImpl || ($active.get()?.kind === 'local' && native.ensureGateway ? () => native.ensureGateway!() : null)

  if (!run) {
    $schedulerNote.set(SCHEDULER_DOWN_NOTE)

    return false
  }

  if (!ensuring) {
    $schedulerNote.set(SCHEDULER_STARTING_NOTE)
    ensuring = run()
      .then(res => Boolean(res && res.ok))
      .catch(() => false)
      .then(ok => {
        $schedulerNote.set(ok ? '' : SCHEDULER_DOWN_NOTE)

        return ok
      })
      .finally(() => {
        ensuring = null
      })
  }

  return ensuring
}

// Keep-alive: while any bot has routines that will fire, re-check the scheduler every few minutes
// (a gateway can still be stopped by hand or by `hermes update`), and refresh a card whose "Next"
// time has passed so it never shows a stale time.
let keepAlive: ReturnType<typeof setInterval> | undefined
const KEEPALIVE_MS = 60_000
let lastSchedulerCheck = 0

export function routinesTick(now = Date.now()) {
  const due: string[] = []
  const live: string[] = []

  for (const [name, state] of Object.entries($routines.get())) {
    if (!isRoutineList(state) || !hasLiveRoutines(state)) continue
    live.push(name)
    if (state.some(r => !isPaused(r) && r.nextRunAt && Date.parse(r.nextRunAt) <= now)) due.push(name)
  }

  const recheck = live.length && now - lastSchedulerCheck >= 4 * 60_000
  const names = recheck ? live : due

  if (recheck) lastSchedulerCheck = now
  for (const name of names) void loadRoutines(name, true)

  return names
}

function startKeepAlive() {
  if (keepAlive || preview || typeof setInterval === 'undefined') return
  keepAlive = setInterval(() => routinesTick(), KEEPALIVE_MS)
  ;(keepAlive as any)?.unref?.()
}

async function manage(name: string, params: Record<string, unknown>) {
  const result = await gateway.request<any>('cron.manage', { profile: name, ...params }, 60_000)

  if (result && result.success === false) {
    throw new Error(String(result.error || 'Hermes said no'))
  }

  return result
}

export async function loadRoutines(name: string, force = false) {
  if (preview) {
    return
  }

  const existing = $routines.get()[name]

  if (!force && existing && (existing === 'loading' || isRoutineList(existing))) {
    return
  }

  if (!isRoutineList(existing)) {
    put(name, 'loading')
  }

  try {
    const result = await manage(name, { action: 'list', include_disabled: true })
    const rows = Array.isArray(result?.jobs) ? result.jobs : []
    const list = rows.map(fromRow)
    put(name, list)
    startKeepAlive()

    if (schedulerDown(result) && hasLiveRoutines(list)) {
      if (await ensureScheduler()) void manage(name, { action: 'list', include_disabled: true }).then(r => put(name, (Array.isArray(r?.jobs) ? r.jobs : []).map(fromRow))).catch(() => undefined)
    } else if (!ensuring) {
      $schedulerNote.set(schedulerDown(result) ? SCHEDULER_DOWN_NOTE : '')
    }
  } catch (error) {
    put(name, { error: String((error as Error).message || error) })
  }
}

export async function setPaused(name: string, routine: Routine, paused: boolean) {
  if (!preview) {
    await manage(name, { action: paused ? 'pause' : 'resume', name: routine.id })
  }

  patch(name, routine.id, paused ? { enabled: false, state: 'paused' } : { enabled: true, state: 'scheduled' })

  if (!preview) {
    void loadRoutines(name, true)
  }
}

export async function removeRoutine(name: string, routine: Routine) {
  if (!preview) {
    await manage(name, { action: 'remove', name: routine.id })
  }

  patch(name, routine.id, null)
}

export interface NewRoutine {
  bot: string
  name: string
  prompt: string
  /** Anything Hermes's parse_schedule takes: a cron expression, "every 2h", or an ISO time. */
  schedule: string
}

export async function createRoutine(input: NewRoutine): Promise<string> {
  if (preview) {
    const list = $routines.get()[input.bot]
    const once = /^\d{4}-\d{2}-\d{2}T/.test(input.schedule)
    const routine: Routine = {
      id: `p${Date.now().toString(36)}`,
      name: input.name,
      prompt: input.prompt,
      schedule: once ? `once at ${input.schedule.slice(0, 16).replace('T', ' ')}` : input.schedule,
      deliver: 'bot-chat',
      repeat: once ? 'once' : 'forever',
      nextRunAt: once ? input.schedule : '',
      lastRunAt: '',
      lastStatus: '',
      lastError: '',
      enabled: true,
      state: 'scheduled'
    }
    put(input.bot, [...(isRoutineList(list) ? list : []), routine])

    return ''
  }

  const result = await manage(input.bot, {
    action: 'add',
    name: input.name,
    schedule: input.schedule,
    prompt: input.prompt,
    // Into the bot's own Bot Chat, which is the app's 1:1 chat with it.
    deliver: 'bot-chat'
  })
  await loadRoutines(input.bot, true)

  if (schedulerDown(result) && !(await ensureScheduler())) {
    return `Routine added, but ${SCHEDULER_DOWN_NOTE.charAt(0).toLowerCase()}${SCHEDULER_DOWN_NOTE.slice(1)}`
  }

  return ''
}

/** A routine parked on a schedule that never comes due, for event routines; returns its job id. */
export async function createParkedRoutine(input: NewRoutine): Promise<string> {
  if (preview) {
    const id = `p${Date.now().toString(36)}`
    const list = $routines.get()[input.bot]
    put(input.bot, [
      ...(isRoutineList(list) ? list : []),
      { id, name: input.name, prompt: input.prompt, schedule: input.schedule, deliver: 'bot-chat', repeat: 'forever', nextRunAt: '', lastRunAt: '', lastStatus: '', lastError: '', enabled: true, state: 'scheduled' }
    ])

    return id
  }

  const before = new Set((isRoutineList($routines.get()[input.bot]) ? ($routines.get()[input.bot] as Routine[]) : []).map(r => r.id))
  const result = await manage(input.bot, { action: 'add', name: input.name, schedule: input.schedule, prompt: input.prompt, deliver: 'bot-chat' })
  await loadRoutines(input.bot, true)
  const direct = String(result?.job_id || result?.job?.id || result?.id || '')
  const list = $routines.get()[input.bot]
  const fresh = isRoutineList(list) ? list.filter(r => !before.has(r.id) && r.name === input.name) : []

  if (direct) return direct
  if (fresh.length) return fresh[fresh.length - 1].id

  throw new Error("Hermes added the routine but didn't say its id. Reopen Routines and edit it to finish.")
}

/**
 * Runs a routine right away through Hermes's dashboard endpoint. Hermes runs it before answering,
 * so this can take as long as the routine does.
 */
export async function runNow(name: string, routine: Routine): Promise<'done' | 'still-running'> {
  $runningNow.set({ ...$runningNow.get(), [routine.id]: true })

  try {
    if (preview) {
      await new Promise(resolve => setTimeout(resolve, 1200))
      patch(name, routine.id, { lastRunAt: new Date().toISOString(), lastStatus: 'ok', lastError: '' })

      return 'done'
    }

    const active = $active.get()

    if (!active) {
      throw new Error('Not connected to Hermes')
    }

    const res = await hostHttp({
      baseUrl: active.baseUrl,
      token: active.token,
      method: 'POST',
      path: `api/cron/jobs/${encodeURIComponent(routine.id)}/trigger?profile=${encodeURIComponent(name)}`,
      timeoutMs: 15 * 60_000
    })

    if (res.status === 0) {
      return 'still-running'
    }

    if (!res.ok) {
      throw new Error(String(res.json?.detail || res.text || `Hermes answered ${res.status}`))
    }

    return 'done'
  } finally {
    const next = { ...$runningNow.get() }
    delete next[routine.id]
    $runningNow.set(next)

    if (!preview) {
      void loadRoutines(name, true)
    }
  }
}

// ── edit ───────────────────────────────────────────────────────────────────
/** Hermes's stored schedule: `{kind: 'once', run_at}`, `{kind: 'interval', minutes}` or `{kind: 'cron', expr}`. */
export interface RoutineSchedule {
  kind: '' | 'cron' | 'interval' | 'once'
  expr: string
  minutes: number
  runAt: string
  display: string
}

export interface RoutineDetail {
  name: string
  /** The whole prompt (the list only has the first 100 characters). */
  prompt: string
  schedule: RoutineSchedule
  deliver: string
}

/** Hermes's schedule from a job record, or from the list's schedule text when that's all there is. */
export function scheduleOf(raw: any, fallback = ''): RoutineSchedule {
  if (raw && typeof raw === 'object') {
    const kind = ['cron', 'interval', 'once'].includes(raw.kind) ? raw.kind : ''

    return { kind, expr: text(raw.expr), minutes: Number(raw.minutes) || 0, runAt: text(raw.run_at), display: text(raw.display) }
  }

  const value = text(raw || fallback).trim()
  const once = value.match(/^once at (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/i)

  if (once) {
    return { kind: 'once', expr: '', minutes: 0, runAt: `${once[1]}T${once[2]}`, display: value }
  }

  const every = value.match(/^every (\d+)m$/i)

  if (every) {
    return { kind: 'interval', expr: '', minutes: Number(every[1]), runAt: '', display: value }
  }

  return { kind: value.split(/\s+/).length >= 5 ? 'cron' : '', expr: value, minutes: 0, runAt: '', display: value }
}

async function dashboard(method: string, path: string, body?: unknown) {
  const active = $active.get()

  if (!active) {
    throw new Error('Not connected to Hermes')
  }

  const res = await hostHttp({ baseUrl: active.baseUrl, token: active.token, method, path, body, timeoutMs: 30_000 })

  if (!res.ok) {
    const detail = res.json?.detail
    throw new Error(String((typeof detail === 'string' ? detail : detail && JSON.stringify(detail)) || res.text || (res.status ? `Hermes answered ${res.status}` : "Couldn't reach Hermes")))
  }

  return res.json
}

const jobPath = (name: string, id: string) => `api/cron/jobs/${encodeURIComponent(id)}?profile=${encodeURIComponent(name)}`

/** The routine as Hermes stores it, for the edit form: the full prompt and the parsed schedule. */
export async function loadRoutineDetail(name: string, routine: Routine): Promise<RoutineDetail> {
  if (preview) {
    return { name: routine.name, prompt: routine.prompt, schedule: scheduleOf(routine.schedule), deliver: routine.deliver }
  }

  const job = await dashboard('GET', jobPath(name, routine.id))

  return {
    name: text(job?.name || routine.name).replace(/^\[bot:[^\]]+\]\s*/, ''),
    prompt: text(job?.prompt ?? routine.prompt),
    schedule: scheduleOf(job?.schedule, text(job?.schedule_display || routine.schedule)),
    deliver: text(job?.deliver || routine.deliver)
  }
}

export interface RoutineChanges {
  name?: string
  prompt?: string
  /** Anything Hermes's parse_schedule takes, as for a new routine. */
  schedule?: string
}

/** Saves an edit with Hermes's cron update. Only changed fields are sent; delivery is left alone. */
export async function updateRoutine(name: string, routine: Routine, changes: RoutineChanges) {
  const updates = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined))

  if (!Object.keys(updates).length) {
    return
  }

  if (preview) {
    const once = updates.schedule && /^\d{4}-\d{2}-\d{2}T/.test(updates.schedule)
    patch(name, routine.id, {
      ...(updates.name ? { name: updates.name } : {}),
      ...(updates.prompt ? { prompt: updates.prompt } : {}),
      ...(updates.schedule
        ? {
            schedule: once ? `once at ${updates.schedule.slice(0, 16).replace('T', ' ')}` : updates.schedule,
            repeat: once ? 'once' : 'forever',
            nextRunAt: once ? updates.schedule : ''
          }
        : {})
    })

    return
  }

  await dashboard('PUT', jobPath(name, routine.id), { updates })
  await loadRoutines(name, true)
}

// Every bot's routines are read once its profile shows up, so a scheduler that's down is started even
// when nobody opens the Routines pane (a routine that silently never fires is the failure mode).
const seenProfiles = new Set<string>()

$profiles.listen(rows => {
  if (preview) return
  for (const row of rows || []) {
    const name = String((row as { name?: string })?.name || '')
    if (!name || name.includes('@') || seenProfiles.has(name)) continue
    seenProfiles.add(name)
    void loadRoutines(name)
  }
})

// Hermes signals jobs.json changes (edits and scheduler ticks); refresh what's on screen.
let changeTimer: ReturnType<typeof setTimeout> | undefined

gateway.on(event => {
  if (event.type !== 'cron.changed' || preview) {
    return
  }

  clearTimeout(changeTimer)
  changeTimer = setTimeout(() => {
    for (const [name, state] of Object.entries($routines.get())) {
      if (isRoutineList(state)) {
        void loadRoutines(name, true)
      }
    }
  }, 800)
})

// ── plain English ──────────────────────────────────────────────────────────
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

/** "9:00 AM" from an hour and minute on Hermes's clock. */
export function clock(hour: number, minute: number) {
  const h = hour % 12 || 12

  return `${h}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

function days(field: string): null | number[] {
  const out: number[] = []

  for (const part of field.toLowerCase().split(',')) {
    const range = part.match(/^(\w+)-(\w+)$/)
    const num = (v: string) => (/^\d$/.test(v) ? Number(v) % 7 : DAY_ABBR[v.slice(0, 3)])

    if (range) {
      const [a, b] = [num(range[1]), num(range[2])]

      if (a === undefined || b === undefined) {
        return null
      }

      for (let d = a; d <= (b < a ? b + 7 : b); d++) {
        out.push(d % 7)
      }
    } else {
      const d = num(part)

      if (d === undefined) {
        return null
      }

      out.push(d)
    }
  }

  return [...new Set(out)].sort()
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

/** A 5-field cron expression in plain English, or '' when it's not a common shape. */
export function cronToText(expr: string): string {
  const parts = expr.trim().split(/\s+/)

  if (parts.length !== 5) {
    return ''
  }

  const [m, h, dom, mon, dow] = parts
  const num = (v: string) => (/^\d+$/.test(v) ? Number(v) : NaN)

  if (mon !== '*') {
    return ''
  }

  const step = m.match(/^\*\/(\d+)$/)

  if (step && h === '*' && dom === '*' && dow === '*') {
    return Number(step[1]) === 1 ? 'Every minute' : `Every ${step[1]} minutes`
  }

  const hourStep = h.match(/^\*\/(\d+)$/)

  if (!Number.isNaN(num(m)) && hourStep && dom === '*' && dow === '*') {
    return `Every ${hourStep[1]} hours${num(m) ? ` at :${m.padStart(2, '0')}` : ''}`
  }

  if (!Number.isNaN(num(m)) && h === '*' && dom === '*' && dow === '*') {
    return num(m) ? `Every hour at :${m.padStart(2, '0')}` : 'Every hour'
  }

  if (Number.isNaN(num(m)) || Number.isNaN(num(h))) {
    return ''
  }

  const at = clock(num(h), num(m))

  if (dom === '*' && dow === '*') {
    return `Every day at ${at}`
  }

  if (dom === '*') {
    const d = days(dow)

    if (!d) {
      return ''
    }

    if (d.join() === '1,2,3,4,5') {
      return `Weekdays at ${at}`
    }

    if (d.join() === '0,6') {
      return `Weekends at ${at}`
    }

    if (d.length === 7) {
      return `Every day at ${at}`
    }

    return `Every ${list(d.map(i => (d.length > 2 ? DAY_NAMES[i].slice(0, 3) : DAY_NAMES[i])))} at ${at}`
  }

  if (dow === '*' && !Number.isNaN(num(dom))) {
    return `Monthly on the ${ordinal(num(dom))} at ${at}`
  }

  return ''
}

function minutesText(minutes: number) {
  if (minutes % 1440 === 0) {
    return minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`
  }

  if (minutes % 60 === 0) {
    return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`
  }

  return `Every ${minutes} minutes`
}

/** "Thu, Oct 9 at 6:00 PM", or "Today at …" / "Tomorrow at …", in the user's local time. */
export function whenText(iso: string, now = new Date()) {
  const at = new Date(iso)

  if (Number.isNaN(at.getTime())) {
    return ''
  }

  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const diff = Math.round((day - today) / 86_400_000)

  if (diff === 0) {
    return `Today at ${time}`
  }

  if (diff === 1) {
    return `Tomorrow at ${time}`
  }

  if (diff === -1) {
    return `Yesterday at ${time}`
  }

  const date = at.toLocaleDateString([], {
    weekday: Math.abs(diff) < 7 ? 'short' : undefined,
    month: 'short',
    day: 'numeric',
    year: at.getFullYear() === now.getFullYear() ? undefined : 'numeric'
  })

  return `${date} at ${time}`
}

/** Minutes east of UTC that an ISO string was written in, or null without an offset. */
function offsetOf(iso: string): null | number {
  const match = iso.match(/(Z|[+-]\d{2}:?\d{2})$/)

  if (!match) {
    return null
  }

  if (match[1] === 'Z') {
    return 0
  }

  const sign = match[1][0] === '-' ? -1 : 1
  const digits = match[1].slice(1).replace(':', '')

  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)))
}

/** True when Hermes's clock (seen in the next-run time it reports) differs from this computer's. */
export function onOtherClock(routine: Routine) {
  const iso = routine.nextRunAt || routine.lastRunAt
  const offset = iso ? offsetOf(iso) : null

  return offset !== null && offset !== -new Date(iso).getTimezoneOffset()
}

/** The schedule in plain English: "Every day at 9:00 AM", "Once, Oct 9 at 6:00 PM", … */
export function scheduleText(routine: Pick<Routine, 'schedule' | 'nextRunAt' | 'lastRunAt' | 'state'>): string {
  const raw = routine.schedule.trim()
  const lower = raw.toLowerCase()

  if (lower.startsWith('once')) {
    const at = routine.nextRunAt || (routine.state === 'completed' ? routine.lastRunAt : '')

    if (at) {
      return `Once, ${whenText(at)}`
    }

    const stamp = raw.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/)

    return stamp ? `Once, ${new Date(`${stamp[1]}T00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${clock(Number(stamp[2]), Number(stamp[3]))}` : 'Once'
  }

  const every = lower.match(/^every (\d+)m$/)

  if (every) {
    return minutesText(Number(every[1]))
  }

  const cron = cronToText(raw)

  if (cron) {
    return cron
  }

  return raw ? raw[0].toUpperCase() + raw.slice(1) : 'No schedule'
}

/** One line about the last run. */
export function lastRunText(routine: Routine): { text: string; bad: boolean } {
  if (!routine.lastRunAt) {
    return { text: 'Hasn’t run yet', bad: false }
  }

  const when = whenText(routine.lastRunAt)
  const rel = /^(today|yesterday)/i.test(when) ? when.toLowerCase() : `on ${when}`
  const why = routine.lastError ? `: ${routine.lastError.split('\n')[0].slice(0, 160)}` : ''

  if (routine.lastStatus === 'error') {
    return { text: `Failed ${rel}${why}`, bad: true }
  }

  if (routine.lastStatus === 'delivery_failed') {
    return { text: `Ran ${rel}, but the result wasn't delivered${why}`, bad: true }
  }

  return { text: `Ran ${rel}`, bad: false }
}
