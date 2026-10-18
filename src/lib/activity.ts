/**
 * Truthful activity for teammates working OUTSIDE this app (message_agent turns, kanban workers).
 *
 * The app only knows about turns it started. A CLI worker holds an active-session lease instead,
 * which `profiles.activity` reports after re-proving the owner process is alive. That proof is the
 * only thing that may mark a teammate working here: never a timestamp, never a remembered state.
 * A failed poll is "no answer", not "idle", so it changes nothing. The external claim is its own
 * busy scope, so it can neither clear nor be cleared by the app's DM/group claims.
 */
import { gateway } from './gateway'
import { $busy, claimBusy, releaseBusy } from './store'

type Entry = { name?: string; running?: boolean; source?: string }

const held = new Set<string>()

export async function refreshExternalActivity(): Promise<void> {
  let rows: Entry[]

  try {
    const res = await gateway.request<{ activity?: Entry[] }>('profiles.activity', {}, 15_000)
    rows = Array.isArray(res?.activity) ? res.activity : []
  } catch {
    return
  }

  const live = new Set(rows.filter(row => row?.running === true && row.source === 'lease' && row.name).map(row => String(row.name)))

  for (const name of live) {
    if (!held.has(name)) {
      held.add(name)
      claimBusy(name, 'external')
    }
  }

  for (const name of [...held]) {
    if (!live.has(name)) {
      held.delete(name)
      releaseBusy(name, 'external')
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null
let soon: ReturnType<typeof setTimeout> | null = null

/**
 * A turn this app ran just ended. A poll during it can see that turn's own lease and claim the bot
 * as working outside the app; waiting for the next poll left "working" up for as long as 10 s after
 * the reply. Checks again shortly instead. Does nothing while not polling.
 */
export function refreshExternalSoon(delayMs = 1_500) {
  if (!timer || soon) {
    return
  }

  soon = setTimeout(() => {
    soon = null
    void refreshExternalActivity()
  }, delayMs)
}

/** Polls while the app is connected. Safe to call more than once. */
export function startExternalActivity(everyMs = 10_000) {
  if (timer) {
    return
  }

  void refreshExternalActivity()
  timer = setInterval(() => void refreshExternalActivity(), everyMs)
}

export function stopExternalActivity() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }

  if (soon) {
    clearTimeout(soon)
    soon = null
  }

  for (const name of held) {
    releaseBusy(name, 'external')
  }

  held.clear()
  void $busy
}
