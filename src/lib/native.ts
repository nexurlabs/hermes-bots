import type { Connection } from './types'

export interface HttpResult {
  ok: boolean
  status: number
  json: any
  text?: string
}

interface NativeBridge {
  platform: string
  getSettings(): Promise<{ connections?: Connection[]; lastConnectionId?: string; user?: { name?: string } }>
  setSettings(patch: Record<string, unknown>): Promise<boolean>
  http(req: { baseUrl: string; token?: string; method?: string; path: string; body?: unknown; timeoutMs?: number }): Promise<HttpResult>
  discoverLocal(): Promise<{ baseUrl: string; token: string; role: string }[]>
  startLocal(): Promise<{ baseUrl: string; token: string }>
  sshConnect(cfg: NonNullable<Connection['ssh']> & { hostSuffix?: string }): Promise<{ baseUrl: string; token: string }>
  cancelConnect(): Promise<boolean>
  logPath(): Promise<string>
  onStep(cb: (text: string) => void): () => void
  hermesMachines(): Promise<Connection[]>
  openExternal(url: string): Promise<void>
  /** Event routines' local listener (electron/hooks.cjs). Desktop only. */
  hooksList?(): Promise<HooksView>
  hooksPut?(input: { token?: string; bot: string; routineId: string; kind: 'webhook' | 'github'; events: string[]; secret?: string }): Promise<HooksView & { token: string }>
  hooksTest?(token: string, event: string, body: string): Promise<{ code: number; status?: string; error?: string }>
  hooksRemove?(token: string): Promise<HooksView>
  hooksConfig?(config: { port: number; lan: boolean }): Promise<HooksView>
  onHookEvent?(cb: (event: HookEvent) => void): () => void
  /** Save bytes (a data URL) through a Save dialog / open them with the OS default app. Desktop only. */
  saveFile?(name: string, dataUrl: string): Promise<{ ok: boolean; canceled?: boolean; path?: string }>
  openFile?(name: string, dataUrl: string): Promise<{ ok: boolean; error?: string; path?: string; blocked?: boolean }>
  copyText(text: string): Promise<boolean>
  /** The local clipboard's text ('' when empty). Older builds' preloads lack it; use readClipboardText. */
  readText?(): Promise<string>
  pickImage(): Promise<null | string>
  toggleMaximize(): Promise<void>
  /** Starts this computer's Hermes gateway (the routine scheduler) without its idle exit. */
  ensureGateway?(): Promise<{ ok: boolean; state: string; reason: string }>
  computerGetState(): Promise<{ running: boolean; port: number; granted: boolean; lastError?: string }>
  computerSetGranted(value: boolean): Promise<{ running: boolean; port: number; granted: boolean; lastError?: string }>
  computerGetLastShot(): Promise<null | { dataUrl: string; at: number }>
  /** `toolsRev` changes whenever the app's tools do (see tool-reload.ts). */
  computerSyncProfiles(profiles: string[], opts?: { baseUrl: string; suffix: string }): Promise<{ ok: boolean; done: string[]; toolsRev?: string }>
  /**
   * The conversation-identity barrier, asked just before a bot's first real turn: is this bot
   * confirmed to be registered as ITS OWN groups route on Hermes? Independent of This PC, and
   * fail-closed — `{ ready: false }` means unproven, not "probably fine". A browser preview has no
   * Hermes to ask, so the optionality keeps the design preview working.
   */
  groupsEnsureIdentity?(who: string): Promise<{ ready: boolean; error?: string }>
  log(text: string): Promise<void>
  computerCheck(profile?: string): Promise<{ ok: boolean; tools: string[]; error: string; asks?: boolean }>
  onComputerGrantedChanged(cb: (granted: boolean) => void): () => void
  /** A bot called one of the app's own tools (the group tools); answer with `appToolResult`. */
  onAppToolCall(cb: (call: AppToolCall) => void): () => void
  appToolResult(id: number, ok: boolean, text: string): void
}

export interface AppToolCall {
  id: number
  /** The Hermes profile (bot) that made the call. */
  profile: string
  name: string
  args: Record<string, unknown>
}

declare global {
  interface Window {
    native: NativeBridge
  }
}

/** In a plain browser (design preview) there is no Electron bridge. */
export const native: NativeBridge =
  typeof window !== 'undefined' && window.native
    ? window.native
    : ({
        platform: 'web',
        getSettings: async () => ({}),
        setSettings: async () => true,
        http: async () => ({ ok: false, status: 0, json: null }),
        discoverLocal: async () => [],
        startLocal: async () => {
          throw new Error('Not available in preview')
        },
        sshConnect: async () => {
          throw new Error('Not available in preview')
        },
        cancelConnect: async () => true,
        logPath: async () => '',
        onStep: () => () => undefined,
        openExternal: async (url: string) => void window.open(url),
        copyText: async (text: string) => {
          try {
            await navigator.clipboard.writeText(text)
            return true
          } catch {
            return false
          }
        },
        readText: async () => {
          try {
            return await navigator.clipboard.readText()
          } catch {
            return ''
          }
        },
        hermesMachines: async () => [],
        pickImage: async () => null,
        toggleMaximize: async () => undefined,
        computerGetState: async () => ({ running: false, port: 0, granted: false }),
        computerSetGranted: async () => ({ running: false, port: 0, granted: false }),
        computerGetLastShot: async () => null,
        computerSyncProfiles: async () => ({ ok: false, done: [] }),
        groupsEnsureIdentity: async () => ({ ready: false, error: 'Not available in the preview.' }),
        log: async () => undefined,
        computerCheck: async () => ({ ok: false, tools: [], error: 'Not available in the preview.' }),
        onComputerGrantedChanged: () => () => undefined,
        onAppToolCall: () => () => undefined,
        appToolResult: () => undefined
      } as NativeBridge)

export function cleanError(error: unknown): string {
  const text = String((error as Error)?.message || error || 'Something went wrong')

  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Local clipboard text: Electron's clipboard through the preload, else the web Clipboard API. */
export async function readClipboardText(): Promise<string> {
  try {
    if (native.readText) {
      return String((await native.readText()) || '')
    }

    return await navigator.clipboard.readText()
  } catch {
    return ''
  }
}

export interface HookInfo {
  token: string
  bot: string
  routineId: string
  kind: 'webhook' | 'github'
  events: string[]
  hasSecret: boolean
  lastFired: number
  lastEvent: string
}

export interface HooksView {
  port: number
  lan: boolean
  addresses: string[]
  running: boolean
  error: string
  hooks: HookInfo[]
}

export interface HookEvent {
  token: string
  bot: string
  routineId: string
  event: string
  body: string
  at: number
}
