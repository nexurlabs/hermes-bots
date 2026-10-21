/**
 * Event routines: routines that run when something happens instead of on a timer.
 *
 * A routine stays a Hermes cron job (same prompt, same `bot-chat` delivery into the bot's 1:1
 * chat), parked on a schedule that effectively never comes due (`every 36500d`). The trigger is
 * the app's own listener (electron/hooks.cjs): each event routine gets a secret URL; a POST there
 * runs the job right away with the request body as context. Hermes's run endpoint takes no extra
 * prompt, so the app appends the event to the job's prompt for that one run and puts it back
 * after (runs of one routine are queued).
 *
 * Hermes also has a native webhook platform whose routes can fire a cron job (`cron_job`), but its
 * dashboard API can't create such routes yet; the editor shows the `hermes webhook subscribe
 * --cron-job` command for setting one up on the Hermes host instead.
 */
import { atom } from 'nanostores'

import { native, type HookEvent, type HookInfo, type HooksView } from './native'
import { loadRoutineDetail, runNow, updateRoutine, type Routine } from './routines'
import { toast } from './store'

export const EVENT_SCHEDULE = 'every 36500d'
export const isEventSchedule = (schedule: string) => /^every\s+36500\s*d/i.test(schedule.trim()) || /every 36500 days|52560000/.test(schedule)
const MAX_BODY_CHARS = 4000
const MARKER = '\n\n---\n[Event that triggered this run]'

export const GITHUB_EVENTS: [string, string][] = [
  ['pull_request.opened', 'PR opened'],
  ['pull_request.merged', 'PR merged'],
  ['push', 'Push'],
  ['issues.opened', 'Issue opened'],
  ['*', 'Any event']
]

export const $hooks = atom<HooksView | null>(null)

export const hookFor = (view: HooksView | null, bot: string, routineId: string): HookInfo | undefined =>
  view?.hooks.find(hook => hook.bot === bot && hook.routineId === routineId)

export async function refreshHooks() {
  if (native.hooksList) {
    $hooks.set(await native.hooksList())
  }
}

export async function putHook(input: Parameters<NonNullable<typeof native.hooksPut>>[0]): Promise<string> {
  if (!native.hooksPut) {
    throw new Error('Event routines need the desktop app.')
  }

  const result = await native.hooksPut(input)
  const { token, ...view } = result
  $hooks.set(view)

  return token
}

export async function removeHook(token: string) {
  if (native.hooksRemove) {
    $hooks.set(await native.hooksRemove(token))
  }
}

export async function configureHooks(port: number, lan: boolean) {
  if (native.hooksConfig) {
    $hooks.set(await native.hooksConfig({ port, lan }))
  }
}

export function hookUrl(view: HooksView, token: string, host = '') {
  const where = host || (view.lan ? view.addresses[0] || '127.0.0.1' : '127.0.0.1')

  return `http://${where}:${view.port}/hooks/${token}`
}

/** The request body as context: JSON pretty-printed, truncated. */
export function eventContext(event: string, body: string): string {
  let shown = body.trim()

  try {
    shown = JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    /* not JSON: as is */
  }

  const cut = shown.length > MAX_BODY_CHARS ? `${shown.slice(0, MAX_BODY_CHARS)}\n… (truncated, ${shown.length} characters)` : shown

  return `${MARKER}\nThis run was triggered by the event "${event}", not a schedule. Request body:\n\`\`\`json\n${cut || '(empty)'}\n\`\`\``
}

export const basePrompt = (prompt: string) => (prompt.includes(MARKER) ? prompt.slice(0, prompt.indexOf(MARKER)) : prompt)

const queues = new Map<string, Promise<void>>()

/** Runs the routine once with the event appended to its prompt, then restores the prompt. */
export function fireRoutine(bot: string, routine: Pick<Routine, 'id'> & Partial<Routine>, event: string, body: string): Promise<void> {
  const key = `${bot}|${routine.id}`
  const run = (queues.get(key) || Promise.resolve()).then(async () => {
    const full = routine as Routine
    const detail = await loadRoutineDetail(bot, full)
    const base = basePrompt(detail.prompt)

    await updateRoutine(bot, full, { prompt: base + eventContext(event, body) })

    try {
      await runNow(bot, full)
    } finally {
      await updateRoutine(bot, full, { prompt: base }).catch(() => undefined)
    }
  })
  const settled = run.catch(() => undefined)
  queues.set(key, settled)

  return run
}

/** Starts listening for events from the main process (once, at startup). */
export function startHookListener(onError: (text: string) => void) {
  void refreshHooks().catch(() => undefined)

  return native.onHookEvent?.((event: HookEvent) => {
    void refreshHooks().catch(() => undefined)
    fireRoutine(event.bot, { id: event.routineId }, event.event, event.body).catch(error => onError(`An event routine couldn't run: ${(error as Error).message || error}`))
  })
}

/** "Send test event": POSTs a sample to the routine's own URL, so the whole path runs. */
export async function sendTestEvent(hook: HookInfo) {
  const github = hook.kind === 'github'
  const wanted = hook.events.find(e => e !== '*') || 'pull_request.opened'
  const [event, action] = wanted.split('.')
  const body = github
    ? JSON.stringify({
        action: action === 'merged' ? 'closed' : action,
        repository: { full_name: 'acme/web' },
        sender: { login: 'test-user' },
        ...(event === 'pull_request' ? { pull_request: { number: 42, title: 'Test event from NexurBots', merged: action === 'merged', html_url: 'https://github.com/acme/web/pull/42' } } : {}),
        ...(event === 'issues' ? { issue: { number: 7, title: 'Test issue from NexurBots' } } : {}),
        ...(event === 'push' ? { ref: 'refs/heads/main', commits: [{ message: 'Test commit' }] } : {})
      })
    : JSON.stringify({ test: true, message: 'Test event from NexurBots', at: new Date().toISOString() })
  if (!native.hooksTest) {
    throw new Error('Event routines need the desktop app.')
  }

  const result = await native.hooksTest(hook.token, github ? event : 'test', body)

  if (result.code >= 300) {
    throw new Error(result.error ? `The listener said: ${result.error}` : `The listener answered ${result.code}`)
  }

  return result
}

// Listen from startup, whether or not the Routines pane is open.
startHookListener(text => toast(text, 'bad'))
