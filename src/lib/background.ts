/**
 * Background work a bot handed off. Hermes runs delegated helpers (`delegate_task`, including
 * `background=true` jobs that outlive the turn) and streams `subagent.*` events on the bot's
 * session. The app shows each one as a small live row with its goal, latest step, elapsed time
 * and a Stop button. A background job reports back on its own: Hermes starts a new turn with the
 * result, and that arrives as a normal reply.
 */
import { atom } from 'nanostores'

import { gateway, type GatewayEvent } from './gateway'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped'

export interface Job {
  id: string
  goal: string
  status: JobStatus
  /** The latest milestone: a step it just took, or its closing summary. */
  note: string
  steps: number
  startedAt: number
  endedAt?: number
}

export const $jobs = atom<Record<string, Job[]>>({})

/** Finished rows stay visible for a moment so the outcome registers, then go. */
const LINGER_MS = 8_000

const statusOf = (raw: string): JobStatus =>
  raw === 'completed'
    ? 'done'
    : raw === 'interrupted'
      ? 'stopped'
      : raw === 'failed' || raw === 'error' || raw === 'timeout'
        ? 'failed'
        : raw === 'queued'
          ? 'queued'
          : 'running'

const oneLine = (text: string, max = 120) => {
  const flat = text.replace(/[🔀├─└│]/gu, '').replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function patch(bot: string, id: string, update: (job: Job | undefined) => Job | null) {
  const all = $jobs.get()
  const list = all[bot] || []
  const index = list.findIndex(job => job.id === id)
  const next = update(index >= 0 ? list[index] : undefined)
  const rest = list.filter(job => job.id !== id)
  $jobs.set({ ...all, [bot]: next ? (index >= 0 ? list.map(job => (job.id === id ? next : job)) : [...rest, next]) : rest })
}

function finish(bot: string, id: string) {
  setTimeout(() => patch(bot, id, job => (job && job.status !== 'running' && job.status !== 'queued' ? null : job || null)), LINGER_MS)
}

/** Feed a bot-session event in; anything that isn't `subagent.*` is ignored. */
export function trackJobEvent(bot: string, event: GatewayEvent) {
  if (!event.type.startsWith('subagent.')) {
    return
  }

  const p = event.payload || {}
  const id = String(p.subagent_id || p.delegation_id || `${p.goal}:${p.task_index ?? 0}`)

  if (!id || event.type === 'subagent.text' || event.type === 'subagent.thinking') {
    return
  }

  if (event.type === 'subagent.complete') {
    patch(bot, id, job => ({
      ...(job || { id, goal: oneLine(String(p.goal || 'Helper')), steps: 0, startedAt: Date.now() }),
      status: statusOf(String(p.status || 'completed')),
      note: oneLine(String(p.summary || p.text || '')),
      steps: Number(p.tool_count ?? job?.steps ?? 0),
      endedAt: Date.now()
    }))
    finish(bot, id)

    return
  }

  patch(bot, id, job => ({
    id,
    goal: oneLine(String(p.goal || job?.goal || 'Helper')),
    status: event.type === 'subagent.spawn_requested' ? 'queued' : 'running',
    note: event.type === 'subagent.tool' || event.type === 'subagent.progress' ? oneLine(String(p.tool_preview || p.text || p.tool_name || '')) || job?.note || '' : job?.note || '',
    steps: Number(p.tool_count ?? job?.steps ?? 0),
    startedAt: job?.startedAt || Date.now()
  }))
}

/** On opening a chat: pick up helpers that were already running (e.g. after a reconnect). */
export async function syncJobs(bot: string, session: string) {
  const result = await gateway.request<{ subagents?: any[] }>('subagent.list', { session_id: session, profile: bot }).catch(() => null)

  if (!result) {
    return
  }

  const live = (result.subagents || []).filter(row => !row.parent_id || row.depth === 0 || row.depth === 1)
  const kept = ($jobs.get()[bot] || []).filter(job => job.status !== 'running' && job.status !== 'queued')

  $jobs.set({
    ...$jobs.get(),
    [bot]: [
      ...kept,
      ...live.map(row => ({
        id: String(row.subagent_id),
        goal: oneLine(String(row.goal || 'Helper')),
        status: statusOf(String(row.status || 'running')),
        note: oneLine(String(row.last_tool || '')),
        steps: Number(row.tool_count || 0),
        startedAt: row.started_at ? Number(row.started_at) * (Number(row.started_at) < 1e12 ? 1000 : 1) : Date.now()
      }))
    ]
  })
}

export async function stopJob(bot: string, session: string, id: string) {
  patch(bot, id, job => (job ? { ...job, note: 'Stopping…' } : null))
  const result = await gateway.request<{ found?: boolean }>('subagent.interrupt', { session_id: session, profile: bot, subagent_id: id }).catch(() => null)

  if (result && !result.found) {
    patch(bot, id, job => (job ? { ...job, status: 'done', endedAt: Date.now() } : null))
    finish(bot, id)
  }
}
