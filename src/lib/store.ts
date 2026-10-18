/**
 * App state + the Hermes data operations behind it (bots, metadata, avatars,
 * scheduled jobs). Bot metadata lives in each profile's
 * ui_meta['hermes-bots'] — the same record Hermes's own Bots mode used, so
 * names, avatars and the Lead carry straight over.
 */
import { atom, computed } from 'nanostores'

import { gateway } from './gateway'
import { $defaultHost, botNameOn, hostHttp, isHostOnline, machineLabel, machineProfileRows, onMachineBots, refreshMachineRows, splitBot } from './hosts'
import { native } from './native'
import { reloadAppToolsOnce } from './tool-reload'
import type { Bot, BotMeta, Connection, ProfileRow } from './types'

export const META_KEY = 'hermes-bots'

export type Phase = 'boot' | 'connect' | 'connecting' | 'app'

export interface ActiveConnection extends Connection {
  baseUrl: string
  token: string
}

export const $phase = atom<Phase>('boot')
export const $active = atom<ActiveConnection | null>(null)
export const $profiles = atom<ProfileRow[]>([])
export const $avatars = atom<Record<string, string>>({})
export const $selection = atom<null | { kind: 'bot' | 'room'; id: string }>(null)
export const $panelOpen = atom(true)
export const $query = atom('')
export const $searchOpen = atom(false)
export const $toast = atom<null | { id: number; text: string; tone?: 'bad' | 'good' }>(null)
export const $userName = atom('You')
/** Bots currently producing a reply (1:1 or in a room). */
export const $busy = atom<Record<string, boolean>>(Object.create(null) as Record<string, boolean>)

/** A DM finishing must not clear a live group claim, or the other way around. `external` is a
 * backend-proven lease for a worker this app did not start (message_agent / kanban). */
type BusyScope = 'dm' | 'group' | 'external'
const busyClaims = new Map<string, Set<BusyScope>>()

function syncBusy(name: string) {
  const held = busyClaims.get(name)
  const next = Object.assign(Object.create(null) as Record<string, boolean>, $busy.get())

  if (held && held.size) {
    next[name] = true
  } else {
    delete next[name]
    busyClaims.delete(name)
  }

  $busy.set(next)
}

export function claimBusy(name: string, scope: BusyScope = 'dm') {
  const held = busyClaims.get(name) || new Set<BusyScope>()
  held.add(scope)
  busyClaims.set(name, held)
  syncBusy(name)
}

export function releaseBusy(name: string, scope: BusyScope = 'dm') {
  busyClaims.get(name)?.delete(scope)
  syncBusy(name)
}

let toastId = 0

export function toast(text: string, tone?: 'bad' | 'good') {
  const id = ++toastId
  $toast.set({ id, text, tone })
  setTimeout(() => {
    if ($toast.get()?.id === id) {
      $toast.set(null)
    }
  }, 3800)
}

/** DM wrapper. Group turns use claimBusy/releaseBusy so the two cannot clear each other. */
export function setBusy(name: string, on: boolean) {
  if (on) {
    claimBusy(name, 'dm')
  } else {
    releaseBusy(name, 'dm')
  }
}

// ── what each bot is working on ─────────────────────────────────────────────
/** What a bot's current turn is about, recorded by the app as the turn runs. */
export type TurnStatus = {
  /** The text that started the turn, on one line. */
  ask: string
  /** The branch this turn is on, when the ask named one. */
  branch?: string
  /** Whether that branch is on origin. 'unknown' when no repo is configured or git failed. */
  onOrigin: 'yes' | 'no' | 'unknown'
}

/** The status of every bot's current turn, keyed by bot name. Absent means idle. */
export const $turnStatus = atom<Record<string, TurnStatus>>({})

/** Longest ask kept in the status line, so one bot's message cannot swamp the team line. */
const ASK_LIMIT = 80

/** Branch answers per branch name, so git is asked once rather than on every turn start. */
const originCache = new Map<string, TurnStatus['onOrigin']>()

/** The repo path to ask git about, when one is configured. Empty means no repo, so nothing to ask. */
let repoPath = ''

/**
 * Points the on-origin check at a repo. Left unset in the app, where no repo is configured, so onOrigin
 * stays 'unknown' rather than running git against whatever directory the renderer happens to sit in.
 */
export function setTurnStatusRepo(path: string) {
  repoPath = path || ''
  originCache.clear()
}

/** Drops a cached answer, so a branch that was pushed is not still reported as not on origin. */
export function forgetTurnStatusOrigin(branch?: string) {
  if (branch) {
    originCache.delete(branch)
  } else {
    originCache.clear()
  }
}

/** Whether a branch is on origin, cached per branch. Any failure to answer is 'unknown'. */
export function branchOnOrigin(branch: string): TurnStatus['onOrigin'] {
  if (!branch) {
    return 'unknown'
  }

  const cached = originCache.get(branch)

  if (cached !== undefined) {
    return cached
  }

  if (!repoPath) {
    // No repo configured: never run git, and never claim to know.
    originCache.set(branch, 'unknown')

    return 'unknown'
  }

  let answer: TurnStatus['onOrigin'] = 'unknown'

  try {
    // Answered by the app, which owns the repo and can shell out; the renderer cannot.
    answer = typeof onOriginProbe === 'function' ? onOriginProbe(repoPath, branch) : 'unknown'
  } catch {
    answer = 'unknown'
  }

  const value = answer === 'yes' || answer === 'no' ? answer : 'unknown'
  originCache.set(branch, value)

  return value
}

/** Set by the app to answer branchOnOrigin; unset in the renderer, which has no process to run. */
let onOriginProbe: ((repo: string, branch: string) => TurnStatus['onOrigin']) | undefined

/** Registers the probe used to answer onOrigin. Passing nothing turns it off. */
export function setOnOriginProbe(probe?: (repo: string, branch: string) => TurnStatus['onOrigin']) {
  onOriginProbe = probe
}

/** The branch an ask names: a backticked token, else the word after "branch". */
export function branchFromAsk(ask: string): string | undefined {
  const ticked = ask.match(/`([^`\n]+)`/)

  if (ticked) {
    return ticked[1].trim() || undefined
  }

  const said = ask.match(/\bbranch\s+(\S+)/i)

  if (said) {
    return said[1].replace(/[.,;:]$/, '') || undefined
  }

  return undefined
}

/** Builds the status for an ask, without recording it. */
export function turnStatusOf(ask: string): TurnStatus {
  // Read the branch from the full ask, then cut only what is shown. Cutting first drops any
  // branch named past the limit.
  const whole = String(ask || '').replace(/\s+/g, ' ').trim()
  const one = whole.slice(0, ASK_LIMIT)
  const branch = branchFromAsk(whole)

  return { ask: one, ...(branch ? { branch } : {}), onOrigin: branchOnOrigin(branch || '') }
}

/** Records what a bot's turn is about, as it starts. */
export function recordTurnStatus(name: string, ask: string) {
  $turnStatus.set({ ...$turnStatus.get(), [name]: turnStatusOf(ask) })
}

/** Clears a bot's status as its turn ends. Safe to call for a bot that never started one. */
export function clearTurnStatus(name: string) {
  const next = { ...$turnStatus.get() }

  if (!(name in next)) {
    return
  }

  delete next[name]
  $turnStatus.set(next)
}

/**
 * The one-line status text. Both the team line and the roster call this, so a bot and a person are
 * told the same thing about the same turn in the same words.
 */
export function statusLine(status: TurnStatus): string {
  const parts = [status.ask]

  if (status.branch) {
    parts.push(`on \`${status.branch}\``)
  }

  parts.push(
    status.onOrigin === 'yes' ? 'on origin' : status.onOrigin === 'no' ? 'not on origin' : 'origin unknown'
  )

  return parts.join(', ')
}

// ── bots ──────────────────────────────────────────────────────────────────
export function metaOf(row: ProfileRow): BotMeta {
  const raw = row.ui_meta?.[META_KEY]

  return raw && typeof raw === 'object' ? (raw as BotMeta) : {}
}

/** What you type after @ in a group. The default profile goes by its display name ("kacy"), not "hermes". */
export function handleOf(full: string, display = ''): string {
  const name = splitBot(full).profile

  if (name !== 'default') {
    return name
  }

  const slug = display.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')

  return slug && slug !== 'default' ? slug : 'hermes'
}

function displayOf(row: ProfileRow, meta: BotMeta): string {
  const title = String(meta.title || '').trim()

  if (title) {
    return title
  }

  const display = String(row.display_name || '').trim()

  if (display && display.toLowerCase() !== 'default') {
    return display
  }

  const base = splitBot(row.name).profile

  return base === 'default' ? (splitBot(row.name).host ? `Hermes (${machineLabel(splitBot(row.name).host)})` : 'Hermes') : base
}

function activityOf(row: ProfileRow): number {
  const times = [row.canonical_session?.last_active, row.last_session?.last_active, row.worker_session?.last_active]
    .map(value => Number(value || 0))
    .filter(Boolean)

  const best = times.length ? Math.max(...times) : 0

  return best > 1e12 ? best : best * 1000
}

export function toBot(row: ProfileRow): Bot {
  const meta = metaOf(row)
  const display = displayOf(row, meta)

  return {
    name: row.name,
    row,
    meta,
    display,
    handle: handleOf(row.name, display),
    lead: meta.lead === true,
    lastActive: activityOf(row),
    preview: String(row.canonical_session?.preview || row.last_session?.preview || meta.description || row.description || '').trim()
  }
}

export const $allBots = computed($profiles, rows =>
  rows.filter(row => (row as { role?: string }).role !== 'setup').map(toBot)
)

export const $bots = computed($allBots, bots => bots.filter(bot => !bot.meta.hidden))
export const $lead = computed($bots, bots => bots.find(bot => bot.lead) || null)

export function botByName(name: null | string | undefined): Bot | null {
  return $allBots.get().find(bot => bot.name === name) || null
}

/** Avatar image (data URL) for a bot: an uploaded/generated picture beats a face. */
export function avatarImage(bot: Bot): null | string {
  return $avatars.get()[bot.name] || (typeof bot.meta.image === 'string' ? bot.meta.image : null)
}

let mainRows: ProfileRow[] = []

let profilesRequested = 0
let profilesApplied = 0

/** Main-machine bots plus every added machine's (names `<profile>@<host>`, see hosts.ts). */
export async function refreshProfiles(): Promise<void> {
  const request = ++profilesRequested
  const [result] = await Promise.all([
    gateway.request<{ profiles?: ProfileRow[] }>('profiles.list', { include_sessions: true }, 30_000),
    refreshMachineRows()
  ])
  const profiles = result?.profiles

  // An answer to an older request must not overwrite a newer answer that already landed.
  if (request < profilesApplied) {
    return
  }

  // A reply with no profile list is a bad answer, not an empty team: keep the bots already loaded.
  if (!Array.isArray(profiles)) {
    return
  }

  profilesApplied = request
  mainRows = profiles
  mergeRows()
  void shareThisPc(mainRows)
}

function mergeRows() {
  const rows = [...mainRows, ...machineProfileRows()]
  $profiles.set(rows)
  void loadAvatars(rows)
}

// An added machine came online, went away or changed its bots.
onMachineBots(() => mergeRows())

/** Every bot is its own profile, so the "This PC" tool server must be registered in each. */
function shareThisPc(rows: ProfileRow[]) {
  const names = rows.filter(row => (row as { role?: string }).role !== 'setup' && row.name !== 'default').map(row => row.name)

  if (names.length) {
    native
      .computerSyncProfiles(names)
      .then(result => reloadAppToolsOnce(gateway, $active.get()?.baseUrl || '', result?.toolsRev))
      .catch(() => undefined)
  }
}

const avatarTried = new Set<string>()

async function loadAvatars(rows: ProfileRow[]) {
  for (const row of rows) {
    if (!row.has_avatar || avatarTried.has(row.name)) {
      continue
    }

    avatarTried.add(row.name)

    try {
      const asset = await gateway.request<{ found?: boolean; data?: string }>('profiles.get_asset', {
        name: row.name,
        asset: 'avatar',
        profile: row.name
      })

      if (asset?.found && asset.data) {
        $avatars.set({ ...$avatars.get(), [row.name]: asset.data })
      }
    } catch {
      /* the face stands in */
    }
  }
}

/** Compare-and-swap write of ui_meta['hermes-bots'] (merging with what's there). */
export async function saveMeta(name: string, patch: Partial<BotMeta>): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = $profiles.get().find(entry => entry.name === name)

    if (!row) {
      throw new Error(`No bot named ${name}`)
    }

    const merged: BotMeta = { ...metaOf(row), ...patch }
    delete merged.image // pictures travel as profile assets, not ui_meta
    const revision = row.ui_meta_revisions?.[META_KEY]

    const result = await gateway.request<{
      applied?: { ui_meta?: boolean; ui_meta_conflicts?: Record<string, unknown>; ui_meta_revisions?: Record<string, number> }
    }>('profiles.configure', {
      name,
      profile: name,
      ui_meta: { [META_KEY]: merged },
      ...(typeof revision === 'number' ? { ui_meta_expected_revisions: { [META_KEY]: revision } } : {})
    })

    if (result?.applied?.ui_meta_conflicts && Object.keys(result.applied.ui_meta_conflicts).length) {
      await refreshProfiles()
      continue
    }

    // Reflect locally right away; the next refresh confirms it.
    $profiles.set(
      $profiles.get().map(entry =>
        entry.name === name
          ? {
              ...entry,
              ui_meta: { ...(entry.ui_meta || {}), [META_KEY]: merged },
              ui_meta_revisions: { ...(entry.ui_meta_revisions || {}), ...(result?.applied?.ui_meta_revisions || {}) }
            }
          : entry
      )
    )

    return
  }

  throw new Error('Another device keeps changing this bot — try again')
}

export async function setLead(name: null | string) {
  const bots = $allBots.get()

  for (const bot of bots) {
    const want = bot.name === name

    if (Boolean(bot.meta.lead) !== want) {
      await saveMeta(bot.name, { lead: want })
    }
  }
}

export async function setAvatar(name: string, dataUrl: null | string) {
  await gateway.request(
    'profiles.set_asset',
    dataUrl ? { name, profile: name, asset: 'avatar', data: dataUrl } : { name, profile: name, asset: 'avatar', clear: true }
  )
  const next = { ...$avatars.get() }

  if (dataUrl) {
    next[name] = dataUrl
  } else {
    delete next[name]
  }

  $avatars.set(next)
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export interface BotDraft {
  name: string
  display: string
  description: string
  soul: string
  color?: string
  shape?: string
  image?: null | string
  /** Copy the main Hermes setup into the new bot (default true). */
  inherit?: boolean
  /** Machine to create it on (host id; '' = main). Defaults to Settings > Machines' default. */
  host?: string
}

export async function createBot(draft: BotDraft): Promise<string> {
  const base = slugify(draft.name || draft.display)

  if (!base) {
    throw new Error('Give your bot a name')
  }

  // On an added machine the app calls it `<name>@<host>`; the gateway router sends it there.
  const host = draft.host ?? $defaultHost.get()

  if (host && !isHostOnline(host)) {
    throw new Error(`${machineLabel(host)} is offline`)
  }

  const name = botNameOn(base, host)

  await gateway.request(
    'profiles.create',
    {
      name,
      description: draft.description || null,
      soul: draft.soul || null,
      // Start from the main Hermes setup: its config (tools, MCP servers, model), skills and
      // what it knows about the user. Without this a bot is a bare profile with defaults only.
      ...(draft.inherit === false ? {} : { clone_from: 'default' }),
      mirror_credentials: true,
      share_auth: true
    },
    120_000
  )
  await refreshProfiles()
  await saveMeta(name, {
    title: draft.display || undefined,
    description: draft.description || undefined,
    color: draft.color,
    shape: draft.shape,
    custom: Boolean(draft.color || draft.shape || draft.image),
    created: Date.now()
  })

  if (draft.image) {
    await setAvatar(name, draft.image)
  }

  return name
}

export async function updateBot(name: string, draft: Partial<BotDraft> & { soulChanged?: boolean; label?: string }) {
  const params: Record<string, unknown> = { name, profile: name }

  if (draft.description !== undefined) {
    params.description = draft.description
  }

  if (draft.soulChanged && draft.soul !== undefined) {
    params.soul = draft.soul
  }

  if (Object.keys(params).length > 2) {
    await gateway.request('profiles.configure', params)
  }

  // Only what was given: a partial update (a bot renaming itself) mustn't blank the rest.
  await saveMeta(name, {
    ...(draft.display !== undefined ? { title: draft.display } : {}),
    ...(draft.description !== undefined ? { description: draft.description } : {}),
    ...(draft.label !== undefined ? { label: draft.label } : {}),
    ...(draft.color ? { color: draft.color, custom: true } : {}),
    ...(draft.shape ? { shape: draft.shape, custom: true } : {})
  })

  if (draft.image !== undefined) {
    await setAvatar(name, draft.image)
  }
}

export async function describeBot(name: string): Promise<{ soul?: string; description?: string; model?: { default?: string; provider?: string } }> {
  return gateway.request('profiles.describe', { name, profile: name })
}

export async function deleteBot(name: string) {
  const active = $active.get()

  if (!active) {
    throw new Error('Not connected')
  }

  const res = await hostHttp({
    baseUrl: active.baseUrl,
    token: active.token,
    method: 'DELETE',
    path: `api/profiles/${encodeURIComponent(name)}`,
    timeoutMs: 60_000
  })

  if (!res.ok) {
    await gateway.request('cli.exec', { argv: ['profile', 'delete', name, '--yes'], profile: 'default' }, 120_000)
  }

  if ($selection.get()?.id === name) {
    $selection.set(null)
  }

  await refreshProfiles()
}
