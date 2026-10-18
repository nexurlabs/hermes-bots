/**
 * Hermes keeps the tool list it read when it first connected to the app's tool servers. Registering
 * them again at startup doesn't refresh it, so after an update that changes the app's tools (a new
 * one like `rename_group`), every bot kept the old list and said the tool didn't exist. When the
 * tools' revision differs from the one last loaded on that Hermes, this asks it to reload MCP tools
 * once. A reload costs a prompt-cache miss, so it only happens when the tools actually changed.
 */
import type { Gateway } from './gateway'
import { native } from './native'

const KEY = 'app-tools-rev'
const running = new Set<string>()

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* asked again next launch */
  }
}

/** `machine` names the Hermes (its address), so each machine is reloaded once per change. */
export async function reloadAppToolsOnce(gw: Pick<Gateway, 'request'>, machine: string, rev: string | undefined) {
  if (!rev || !machine) {
    return
  }

  const key = `${KEY}:${machine}`

  if (read(key) === rev || running.has(key)) {
    return
  }

  running.add(key)

  try {
    const result = await gw.request<{ status?: string }>('reload.mcp', { confirm: true }, 60_000)

    if (result?.status !== 'confirm_required') {
      write(key, rev)
    }

    void native.log(`reload tools after the app's tools changed: ${result?.status || 'done'}`)
  } catch (error) {
    void native.log(`reload tools after the app's tools changed failed: ${String((error as Error)?.message || error)}`)
  } finally {
    running.delete(key)
  }
}
