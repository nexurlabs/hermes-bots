import { atom } from 'nanostores'

import { newId } from './chat'
import { startExternalActivity, stopExternalActivity } from './activity'
import { gateway } from './gateway'
import { closeMachines, startMachines, useEndpointResolver } from './hosts'
import { cleanError, native } from './native'
import { syncSharedMemory } from './memory'
import { ensureSharedFolder, resetSharedFolder } from './shared-folder'
import { loadRooms } from './rooms'
import { $routines } from './routines'
import { warmTeam } from './team'
import { $active, $phase, $profiles, $selection, $userName, refreshProfiles, toast, type ActiveConnection } from './store'
// Answers bots' calls to the app's own tools (group posts, profile edits).
import './app-tools'
import type { Connection } from './types'

export const $saved = atom<Connection[]>([])
export const $connectError = atom<null | string>(null)
export const $connectStep = atom<string>('')
export const $connectLog = atom<string>('')

let attempt = 0

native.onStep(text => {
  if (text) {
    $connectStep.set(text)
  }
})

void native.logPath().then(path => $connectLog.set(path)).catch(() => undefined)

/** Stop whatever connect attempt is in flight and go back to the picker. */
export function cancelConnect() {
  attempt += 1
  void native.cancelConnect().catch(() => undefined)
  gateway.setResolver(null)
  gateway.close()
  $connectStep.set('')
  $connectError.set(null)
  $phase.set('connect')
}

export async function boot() {
  const settings = await native.getSettings().catch(() => ({}) as Awaited<ReturnType<typeof native.getSettings>>)
  $saved.set(settings.connections || [])

  if (settings.user?.name) {
    $userName.set(settings.user.name)
  }

  let last = (settings.connections || []).find(c => c.id === settings.lastConnectionId)

  // First run (or never logged out): go straight to the VM set up in Hermes.
  if (!last && settings.lastConnectionId !== '') {
    const machines = await native.hermesMachines().catch(() => [])
    last = machines[0]
  }

  if (last?.kind === 'ssh' && last.ssh) {
    // Hermes may have updated this machine (new key, new path) since we saved it.
    const fresh = (await native.hermesMachines().catch(() => [])).find(
      m => m.ssh?.host === last!.ssh!.host && (m.ssh?.user || '') === (last!.ssh!.user || '')
    )

    if (fresh?.ssh) {
      last = { ...last, ssh: { ...last.ssh, ...fresh.ssh } }
    }
  }

  if (last) {
    await connect(last).catch(() => undefined)

    if ($phase.get() === 'app') {
      return
    }
  }

  $phase.set('connect')
}

async function persist(connections: Connection[], lastConnectionId?: string) {
  $saved.set(connections)
  await native.setSettings({ connections, ...(lastConnectionId ? { lastConnectionId } : {}) })
}

function normalizeUrl(input: string): string {
  let url = input.trim()

  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`
  }

  return url.replace(/\/+$/, '')
}

async function resolveEndpoint(conn: Connection, hostSuffix = ''): Promise<{ baseUrl: string; token: string }> {
  if (conn.kind === 'local') {
    $connectStep.set('Looking for Hermes on this computer…')
    const found = await native.discoverLocal()

    if (found.length) {
      return found[0]
    }

    $connectStep.set('Starting Hermes…')

    return native.startLocal()
  }

  if (conn.kind === 'ssh' && conn.ssh) {
    $connectStep.set(`Opening a secure tunnel to ${conn.ssh.host}…`)

    return native.sshConnect(hostSuffix ? { ...conn.ssh, hostSuffix } : conn.ssh)
  }

  return { baseUrl: normalizeUrl(conn.baseUrl || ''), token: conn.token || '' }
}

export function wsUrl(baseUrl: string, token: string) {
  const url = new URL(baseUrl.replace(/\/?$/, '/') + 'api/ws')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

  if (token) {
    url.searchParams.set('token', token)
  }

  return url.toString()
}

export async function connect(conn: Connection) {
  const mine = ++attempt
  const stale = () => mine !== attempt

  $phase.set('connecting')
  $connectError.set(null)

  try {
    const endpoint = await resolveEndpoint(conn)

    if (stale()) {
      throw new Error('Cancelled')
    }

    if (conn.kind === 'remote') {
      $connectStep.set('Checking the server…')
      const status = await native.http({ baseUrl: endpoint.baseUrl, path: 'api/status', timeoutMs: 8000 })

      if (status.status === 0) {
        throw new Error(`Can't reach ${endpoint.baseUrl}`)
      }

      if (status.json?.auth_required && !endpoint.token) {
        throw new Error('This Hermes needs a session token')
      }
    }

    $connectStep.set('Connecting…')
    gateway.close()
    // If the link drops later, every retry asks for the address again: that re-opens the SSH tunnel
    // (and picks up a new session token) instead of knocking on a port nothing is listening on.
    gateway.setResolver(async () => {
      const next = await resolveEndpoint(conn)

      if (!stale()) {
        $active.set({ ...conn, ...next } as ActiveConnection)
      }

      return wsUrl(next.baseUrl, next.token)
    })
    await gateway.connect(wsUrl(endpoint.baseUrl, endpoint.token))

    if (stale()) {
      gateway.close()
      throw new Error('Cancelled')
    }

    $active.set({ ...conn, ...endpoint } as ActiveConnection)
    // Added machines (Settings > Machines) connect alongside, in the background.
    void startMachines(conn)
    $connectStep.set('Loading your bots…')
    await refreshProfiles()
    loadRooms()
    warmTeam()
    void syncSharedMemory()
    $routines.set({})
    resetSharedFolder()
    // Bots are told about the shared folder once it exists.
    void ensureSharedFolder().catch(() => undefined)

    const saved = $saved.get().filter(c => c.id !== conn.id)
    await persist([{ ...conn, lastUsed: Date.now() }, ...saved], conn.id)

    if (stale()) {
      throw new Error('Cancelled')
    }

    $phase.set('app')
    // Teammates working outside the app (message_agent / kanban workers) show as working only
    // while the backend proves their lease.
    startExternalActivity()
  } catch (error) {
    if (stale()) {
      throw error
    }

    gateway.setResolver(null)
    gateway.close()
    $connectError.set(cleanError(error))
    $phase.set('connect')
    throw error
  } finally {
    if (!stale()) {
      $connectStep.set('')
    }
  }
}

export function makeConnection(kind: Connection['kind'], fields: Partial<Connection>): Connection {
  const label =
    fields.label ||
    (kind === 'local' ? 'This computer' : kind === 'ssh' ? fields.ssh?.host || 'SSH' : (fields.baseUrl || '').replace(/^https?:\/\//, ''))

  return { id: newId('c'), kind, label, ...fields }
}

export async function disconnect() {
  attempt += 1
  stopExternalActivity()
  closeMachines()
  gateway.setResolver(null)
  gateway.close()
  $active.set(null)
  $profiles.set([])
  $selection.set(null)
  await native.setSettings({ lastConnectionId: '' })
  $phase.set('connect')
}

export async function forget(id: string) {
  await persist($saved.get().filter(c => c.id !== id))
}

// After sleep or a network change the socket can look open and be dead; a quick check (or, if we are
// already retrying, an immediate try) gets things moving without waiting for the next heartbeat.
gateway.onReconnect(() => toast('Reconnected to Hermes', 'good'))

if (typeof window !== 'undefined') {
  const wake = () => {
    if ($phase.get() === 'app') {
      void gateway.probe()
    }
  }

  window.addEventListener('online', wake)
  window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wake())
}

// Added machines resolve their address the same way (local, SSH tunnel or URL + token).
useEndpointResolver(
  async (conn, hostSuffix) => {
    const endpoint = await resolveEndpoint(conn, hostSuffix)

    if (conn.kind === 'remote') {
      const status = await native.http({ baseUrl: endpoint.baseUrl, path: 'api/status', timeoutMs: 8000 })

      if (status.status === 0) throw new Error(`Can't reach ${endpoint.baseUrl}`)
      if (status.json?.auth_required && !endpoint.token) throw new Error('This Hermes needs a session token')
    }

    return endpoint
  },
  wsUrl
)
