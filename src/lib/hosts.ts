/**
 * Bots on several machines. The app's first connection (the one it always had) is the MAIN
 * machine; more Hermes hosts can be added in Settings > Machines and are connected alongside it,
 * each over its own gateway socket.
 *
 * Naming: a bot on an added machine is `<profile>@<host id>` inside the app (host ids look like
 * `hb7k2q9x`), so two machines can both have a `default` or `forge`. Main-machine bots keep their
 * plain names, so nothing changes for an existing setup.
 *
 * Routing: every gateway call and HTTP call is checked for a `@<host id>` name. One that names a bot
 * on an added machine goes to that machine with the suffix taken off; one that names a session
 * started there goes there too; anything else goes to the main machine. So chats, Computer,
 * routines, memory, secrets, files, templates, model picks and group turns all reach the bot's own
 * Hermes without each feature knowing about machines.
 */
import { atom } from 'nanostores'

import { Gateway, gateway, type GatewayState } from './gateway'
import { cleanError, native, type HttpResult } from './native'
import { reloadAppToolsOnce } from './tool-reload'
import type { Connection, ProfileRow } from './types'

export interface MachineView {
  /** '' for the main machine. */
  id: string
  label: string
  kind: Connection['kind']
  where: string
  state: 'online' | 'connecting' | 'offline'
  error?: string
  main: boolean
}

interface Extra {
  id: string
  conn: Connection
  gw: Gateway
  endpoint: null | { baseUrl: string; token: string }
  error: string
  rows: ProfileRow[]
}

const HOST_ID = /^hb[a-z0-9]{4,10}$/
const SUFFIX = /@(hb[a-z0-9]{4,10})(?![a-z0-9])/g
const ROWS_KEY = 'machine-rows'
const GROUP_KEY = 'group-by-machine'

let preview = false
const extras = new Map<string, Extra>()
const sessionHost = new Map<string, string>()

export const $machines = atom<MachineView[]>([])
export const $defaultHost = atom<string>('')
export const $groupByMachine = atom<boolean>(typeof localStorage !== 'undefined' && localStorage.getItem(GROUP_KEY) === '1')
/** Bumped when an added machine's bots change, so the roster re-reads them. */
export const $machineRows = atom<Record<string, ProfileRow[]>>({})

export function setGroupByMachine(on: boolean) {
  $groupByMachine.set(on)
  try {
    localStorage.setItem(GROUP_KEY, on ? '1' : '0')
  } catch {
    /* fine */
  }
}

// ── names ─────────────────────────────────────────────────────────────────
export const suffixOf = (id: string) => (id ? `@${id}` : '')

/** `forge@hb7k2q9x` → { profile: 'forge', host: 'hb7k2q9x' }; plain names are the main machine's. */
export function splitBot(name: string): { profile: string; host: string } {
  const at = name.lastIndexOf('@')
  const host = at > 0 ? name.slice(at + 1) : ''

  return HOST_ID.test(host) ? { profile: name.slice(0, at), host } : { profile: name, host: '' }
}

export const hostOf = (name: string) => splitBot(name).host
export const botNameOn = (profile: string, host: string) => profile + suffixOf(host)

export function machineLabel(host: string): string {
  return $machines.get().find(m => m.id === host)?.label || (host ? 'Other machine' : 'Main machine')
}

export function isHostOnline(host: string): boolean {
  if (preview) return $machines.get().find(m => m.id === host)?.state !== 'offline'
  if (!host) return gateway.state.get() === 'open'

  return extras.get(host)?.gw.state.get() === 'open'
}

/**
 * The gateway that actually carries a suffixed bot's traffic, and the Hermes it points at. A
 * caller that needs to know "is this the same link as before?" for a named bot has to be answered
 * by that bot's own machine — `extras`, not the main socket — otherwise `forge@hbbbbbbb` gets the
 * main gateway's state and proves nothing about the Hermes it will actually talk to.
 * `''`/null means the main machine.
 */
export function gatewayForHost(host: string): null | { gw: Gateway; endpoint: null | { baseUrl: string; token: string } } {
  if (!host) return { gw: gateway, endpoint: null }

  const extra = extras.get(host)

  return extra ? { gw: extra.gw, endpoint: extra.endpoint } : null
}

export const botOffline = (name: string) => !isHostOnline(hostOf(name))

// ── routing ───────────────────────────────────────────────────────────────
function named(text: string): string {
  SUFFIX.lastIndex = 0
  for (const m of text.matchAll(SUFFIX)) {
    if (extras.has(m[1])) return m[1]
  }

  return ''
}

const strip = (text: string, host: string) => text.split(`@${host}`).join('').split(`%40${host}`).join('')

function remember(host: string, result: any) {
  for (const key of ['session_id', 'stored_session_id']) {
    const id = result && typeof result === 'object' ? result[key] : undefined
    if (typeof id === 'string' && id) sessionHost.set(id, host)
  }
}

gateway.setRouter((_method, params) => {
  const raw = JSON.stringify(params ?? {})
  const host = named(raw)

  if (host) {
    const extra = extras.get(host)!

    return { gw: extra.gw, params: JSON.parse(strip(raw, host)), done: result => remember(host, result) }
  }

  const sid = String((params as any)?.session_id || '')
  const owner = sid ? sessionHost.get(sid) : undefined

  if (owner && extras.has(owner)) {
    return { gw: extras.get(owner)!.gw, params, done: result => remember(owner, result) }
  }

  return null
})

const safeDecode = (text: string) => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** native.http, sent to the machine its path/body names (see top). */
export function hostHttp(req: Parameters<typeof native.http>[0], who?: string): Promise<HttpResult> {
  const body = req.body === undefined ? '' : JSON.stringify(req.body)
  const host = (who !== undefined ? hostOf(who) || (extras.has(who) ? who : '') : '') || named(safeDecode(req.path) + ' ' + body)
  const extra = host ? extras.get(host) : undefined

  if (!extra) return native.http(req)
  if (!extra.endpoint || extra.gw.state.get() !== 'open') {
    return Promise.resolve({ ok: false, status: 0, json: { detail: `${extra.conn.label} is offline` }, text: `${extra.conn.label} is offline` } as HttpResult)
  }

  return native.http({ ...req, baseUrl: extra.endpoint.baseUrl, token: extra.endpoint.token, path: strip(req.path, host), ...(req.body === undefined ? {} : { body: JSON.parse(strip(body, host)) }) })
}

/** The Hermes address a bot lives at (for the Computer tab's direct links). */
export function endpointOf(name: string, main: null | { baseUrl: string; token?: string }): null | { baseUrl: string; token?: string } {
  const host = hostOf(name)

  return host ? extras.get(host)?.endpoint || null : main
}

// ── the machine list ──────────────────────────────────────────────────────
interface Saved {
  id: string
  connectionId: string
}

let mainView: Omit<MachineView, 'state'> | null = null
let savedList: Saved[] = []

const whereOf = (conn: Connection) =>
  conn.kind === 'local' ? 'This computer' : conn.kind === 'ssh' ? `${conn.ssh?.user ? `${conn.ssh.user}@` : ''}${conn.ssh?.host || ''}` : (conn.baseUrl || '').replace(/^https?:\/\//, '')

const stateOf = (s: GatewayState): MachineView['state'] => (s === 'open' ? 'online' : s === 'connecting' || s === 'reconnecting' ? 'connecting' : 'offline')

function publish() {
  const list: MachineView[] = []

  if (mainView) list.push({ ...mainView, state: stateOf(gateway.state.get()) })
  for (const extra of extras.values()) {
    list.push({ id: extra.id, label: extra.conn.label, kind: extra.conn.kind, where: whereOf(extra.conn), state: stateOf(extra.gw.state.get()), error: extra.error || undefined, main: false })
  }

  $machines.set(list)
}

gateway.state.subscribe(() => publish())

/** Design preview: machines and their bots without any connection. */
export function seedMachines(list: MachineView[], rows: Record<string, ProfileRow[]>, defaultHost = '') {
  preview = true
  $machines.set(list)
  $machineRows.set(rows)
  $defaultHost.set(defaultHost)
}

export const isMachinesPreview = () => preview

function loadCachedRows(): Record<string, ProfileRow[]> {
  try {
    return JSON.parse(localStorage.getItem(ROWS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function cacheRows() {
  const out: Record<string, ProfileRow[]> = {}
  for (const extra of extras.values()) out[extra.id] = extra.rows
  $machineRows.set(out)
  try {
    localStorage.setItem(ROWS_KEY, JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, rows]) => [k, rows.map(r => ({ name: r.name, display_name: r.display_name, ui_meta: r.ui_meta, description: r.description }))]))))
  } catch {
    /* fine */
  }
}

/** Rows of every added machine, names suffixed (offline machines: last known, so their bots show greyed). */
export function machineProfileRows(): ProfileRow[] {
  if (preview) return Object.entries($machineRows.get()).flatMap(([id, rows]) => rows.map(r => ({ ...r, name: botNameOn(splitBot(r.name).profile, id) })))

  return [...extras.values()].flatMap(extra => extra.rows.map(r => ({ ...r, name: botNameOn(r.name, extra.id) })))
}

async function fetchRows(extra: Extra) {
  try {
    const result = await extra.gw.request<{ profiles?: ProfileRow[] }>('profiles.list', { include_sessions: true }, 30_000)
    extra.rows = Array.isArray(result?.profiles) ? result.profiles : []
    cacheRows()
    const names = extra.rows.filter(r => (r as { role?: string }).role !== 'setup' && r.name !== 'default').map(r => r.name)
    if (extra.endpoint) {
      const baseUrl = extra.endpoint.baseUrl

      native
        .computerSyncProfiles(names, { baseUrl, suffix: suffixOf(extra.id) })
        .then(result => reloadAppToolsOnce(extra.gw, baseUrl, result?.toolsRev))
        .catch(() => undefined)
    }
  } catch {
    /* keep the last rows */
  }
}

/** Re-reads every added machine's bots (refreshProfiles calls this). */
export async function refreshMachineRows() {
  await Promise.all([...extras.values()].filter(e => e.gw.state.get() === 'open').map(fetchRows))
}

let onBots: () => void = () => undefined
/** store.ts hands over refreshProfiles (avoids an import cycle). */
export const onMachineBots = (fn: () => void) => {
  onBots = fn
}

let onLinkChanged: (host: string, gw: Gateway) => void = () => undefined
/**
 * bot-identity.ts hands over its own retirement hook here (avoids an import cycle). It is called for
 * the machine that reconnected, never for the others: a reconnect replaces the socket that machine's
 * affirmative answers were made on, and says nothing about any other machine's.
 */
export const onMachineReconnect = (fn: (host: string, gw: Gateway) => void) => {
  onLinkChanged = fn
}

let resolve: null | ((conn: Connection, hostSuffix: string) => Promise<{ baseUrl: string; token: string }>) = null
let wsUrlOf: (baseUrl: string, token: string) => string = () => ''
export function useEndpointResolver(fn: typeof resolve, ws: typeof wsUrlOf) {
  resolve = fn
  wsUrlOf = ws
}

async function open(extra: Extra) {
  if (!resolve) return
  extra.error = ''
  publish()
  try {
    const endpoint = await resolve(extra.conn, suffixOf(extra.id))
    extra.endpoint = endpoint
    extra.gw.setResolver(async () => {
      const next = await resolve!(extra.conn, suffixOf(extra.id))
      extra.endpoint = next
      return wsUrlOf(next.baseUrl, next.token)
    })
    await extra.gw.connect(wsUrlOf(endpoint.baseUrl, endpoint.token))
    await fetchRows(extra)
    onBots()
  } catch (error) {
    extra.error = cleanError(error)
  }
  publish()
}

function adopt(id: string, conn: Connection, rows: ProfileRow[] = []): Extra {
  const gw = new Gateway()
  const extra: Extra = { id, conn, gw, endpoint: null, error: '', rows }

  gw.on(event => gateway.dispatch(event))
  gw.onServerRequest((method, params, rid) => (gateway.serverHandler ? gateway.serverHandler(method, params, rid) : Promise.reject(new Error('not ready'))))
  gw.state.subscribe(state => {
    publish()
    if (state === 'open') void fetchRows(extra).then(() => onBots())
    else onBots()
  })
  gw.onReconnect(() => {
    // The socket this machine's answers were made on has been replaced. Whoever caches proofs is
    // told which machine lost its link, so it can retire that machine's and no one's else.
    onLinkChanged(id, gw)
    void fetchRows(extra).then(() => onBots())
  })
  extras.set(id, extra)

  return extra
}

/** After the main machine connects: bring up the added ones (in the background). */
export async function startMachines(main: Connection) {
  mainView = { id: '', label: main.label, kind: main.kind, where: whereOf(main), main: true }
  const settings: any = await native.getSettings().catch(() => ({}))
  const connections: Connection[] = settings.connections || []
  savedList = (Array.isArray(settings.machines) ? settings.machines : []).filter((m: Saved) => m && HOST_ID.test(m.id))
  $defaultHost.set(typeof settings.defaultHost === 'string' && (settings.defaultHost === '' || savedList.some(m => m.id === settings.defaultHost)) ? settings.defaultHost : '')
  const cached = loadCachedRows()

  for (const saved of savedList) {
    const conn = connections.find(c => c.id === saved.connectionId)
    if (!conn || extras.has(saved.id)) continue
    void open(adopt(saved.id, conn, cached[saved.id] || []))
  }
  cacheRows()
  publish()
}

async function persistMachines(connections?: Connection[]) {
  await native.setSettings({ machines: savedList, defaultHost: $defaultHost.get(), ...(connections ? { connections } : {}) })
}

const newHostId = () => `hb${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`

/** Adds a machine and connects to it. The connection's token is stored sealed, like the main one. */
export async function addMachine(conn: Connection): Promise<string> {
  if (preview) {
    const id = newHostId()
    $machines.set([...$machines.get(), { id, label: conn.label, kind: conn.kind, where: whereOf(conn), state: 'online', main: false }])
    return id
  }
  const settings: any = await native.getSettings().catch(() => ({}))
  const connections: Connection[] = (settings.connections || []).filter((c: Connection) => c.id !== conn.id)
  const id = newHostId()
  savedList = [...savedList, { id, connectionId: conn.id }]
  await persistMachines([...connections, conn])
  const extra = adopt(id, conn)
  await open(extra)
  if (extra.error) throw new Error(extra.error)

  return id
}

export async function retryMachine(id: string) {
  const extra = extras.get(id)
  if (extra) await open(extra)
}

export async function removeMachine(id: string) {
  const extra = extras.get(id)
  if (preview) return $machines.set($machines.get().filter(m => m.id !== id))
  if (!extra) return
  extra.gw.setResolver(null)
  extra.gw.close()
  extras.delete(id)
  savedList = savedList.filter(m => m.id !== id)
  if ($defaultHost.get() === id) $defaultHost.set('')
  const settings: any = await native.getSettings().catch(() => ({}))
  await persistMachines((settings.connections || []).filter((c: Connection) => c.id !== extra.conn.id))
  cacheRows()
  publish()
  onBots()
}

export async function renameMachine(id: string, label: string) {
  const clean = label.trim().slice(0, 60)
  if (!clean) return
  if (preview) return $machines.set($machines.get().map(m => (m.id === id ? { ...m, label: clean } : m)))
  const settings: any = await native.getSettings().catch(() => ({}))
  const connections: Connection[] = settings.connections || []
  const target = id ? extras.get(id)?.conn : connections.find(c => c.id === settings.lastConnectionId)
  if (!target) return
  const next = connections.map(c => (c.id === target.id ? { ...c, label: clean } : c))
  if (id) extras.get(id)!.conn = { ...extras.get(id)!.conn, label: clean }
  else if (mainView) mainView = { ...mainView, label: clean }
  await native.setSettings({ connections: next })
  publish()
}

export async function setDefaultHost(id: string) {
  $defaultHost.set(id)
  if (!preview) await persistMachines()
}

/** Closes every added machine (logging out of the main one). */
export function closeMachines() {
  for (const extra of extras.values()) {
    extra.gw.setResolver(null)
    extra.gw.close()
  }
  extras.clear()
  mainView = null
  publish()
}
