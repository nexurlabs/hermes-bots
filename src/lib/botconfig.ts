/**
 * Everything about how a bot is set up — its model, tools, skills, connected apps, safety and
 * working folder — read from and written to its Hermes profile. This is the same surface
 * `hermes tools`, `hermes skills` and `hermes model` edit, scoped to one bot.
 */
import { atom } from 'nanostores'

import { gateway } from './gateway'
import { refreshProfiles } from './store'

export interface ToolsetInfo {
  name: string
  label: string
  description: string
  tool_count: number
  enabled: boolean
}

export interface SkillInfo {
  name: string
  enabled: boolean
}

export interface McpInfo {
  name: string
  enabled: boolean
  transport: string
}

/** Every mode Hermes's terminal guard enforces (hermes_cli/approval_mode.py VALID_APPROVAL_MODES). */
export type Approvals = 'manual' | 'off' | 'smart'

/** What the panel shows: a real Hermes mode, or a value Hermes didn't hand back cleanly. Never guessed. */
export type ApprovalsState = Approvals | 'unknown'

export interface BotConfig {
  model: { provider: string; model: string }
  reasoning: string
  approvals: ApprovalsState
  /** The raw value when `approvals` is 'unknown', so the panel can say what Hermes actually has. */
  approvalsRaw?: string
  cwd: string
  toolsets: ToolsetInfo[]
  /** False until the tool list has been saved once; before that Hermes uses its own defaults. */
  toolsetsPinned: boolean
  skills: SkillInfo[]
  mcp: McpInfo[]
  /** Hermes's `timezone` setting (cron times use it); '' means the Hermes machine's own clock. */
  timezone?: string
}

export interface ProviderOption {
  slug: string
  name: string
  models: string[]
  current: boolean
  authenticated: boolean
  warning?: string
  /** Per model: does it take a thinking level (Hermes's capability catalog; true when unknown). */
  reasoning?: Record<string, boolean>
}

export type ConfigState = BotConfig | { error: string } | 'loading'

export const $botConfig = atom<Record<string, ConfigState>>({})

const put = (name: string, state: ConfigState) => $botConfig.set({ ...$botConfig.get(), [name]: state })

/** Preview mode (no Hermes behind it): settings live in memory only. */
let preview: ProviderOption[] | null = null

export function seedPreview(configs: Record<string, BotConfig>, providers: ProviderOption[]) {
  preview = providers
  $botConfig.set(configs)
}

/** The tool server that lets bots use this PC is plumbing, not something to toggle by name. */
export const THIS_PC_SERVER = 'hermes-bots-this-pc'

/** The app's own tool server (one per bot): group posts from a 1:1 chat, and a bot editing its own name, label and description. */
export const GROUPS_SERVER = 'hermes-bots-groups'

/** How the app's own tool servers read in the UI; anything else keeps its Hermes name. */
export const appLabel = (server: string) => (server === THIS_PC_SERVER ? 'This PC' : server === GROUPS_SERVER ? 'App tools' : server)

export const APPROVAL_CHOICES: { id: Approvals; label: string; hint: string }[] = [
  { id: 'manual', label: 'Ask me', hint: 'Check with you before commands that could change things.' },
  { id: 'smart', label: 'Smart', hint: 'Hermes approves routine commands itself and asks about risky ones.' },
  { id: 'off', label: 'Never ask', hint: 'Runs everything without checking. Only for bots you fully trust.' }
]

/**
 * Hermes's own effort ladder. Hermes clamps a level the model can't take down to the strongest one it
 * does support, so "Max" is always safe to pick: it means "as hard as this model can think".
 */
export const REASONING_CHOICES: { id: string; label: string }[] = [
  { id: 'none', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' }
]

/** The level a bot thinks at when nothing is pinned: what to fall back to after a one-message boost. */
export function botReasoning(name: string) {
  const state = $botConfig.get()[name]

  return isLoaded(state) && state.reasoning ? state.reasoning.toLowerCase() : ''
}

export function reasoningLabel(value: string) {
  return REASONING_CHOICES.find(choice => choice.id === value.toLowerCase())?.label || (value ? value[0].toUpperCase() + value.slice(1) : 'Default')
}

/** The label for a mode. Anything Hermes doesn't define reads as "Unknown", never as the safe-looking "Ask me". */
export const approvalLabel = (value: ApprovalsState | string | undefined) =>
  APPROVAL_CHOICES.find(choice => choice.id === value)?.label || 'Unknown'

/**
 * Reads `approvals.mode` the way Hermes does (tools/approval_context._normalize_approval_mode): YAML 1.1
 * turns a bare `off` into false, so booleans map to off/manual; a missing value is Hermes's default,
 * manual. Any other value is reported as 'unknown' instead of being dressed up as "Ask me".
 */
export function normalizeApprovals(value: unknown): ApprovalsState {
  if (value === false) {
    return 'off'
  }

  if (value === true || value === undefined || value === null || value === '') {
    return 'manual'
  }

  const word = String(value).trim().toLowerCase()

  return word === 'manual' || word === 'smart' || word === 'off' ? word : 'unknown'
}

/** Shows a change straight away; the real value arrives when the save finishes (a failure reloads it). */
export function patchConfig(name: string, change: (cfg: BotConfig) => BotConfig) {
  const current = $botConfig.get()[name]

  if (current && typeof current === 'object' && !('error' in current)) {
    put(name, change(current))
  }
}

export const isLoaded = (state: ConfigState | undefined): state is BotConfig => Boolean(state && typeof state === 'object' && !('error' in state))

export async function loadBotConfig(name: string, force = false) {
  if (preview) {
    return
  }

  const existing = $botConfig.get()[name]

  if (!force && existing && (existing === 'loading' || !('error' in existing))) {
    return
  }

  if (!existing || 'error' in (existing as object)) {
    put(name, 'loading')
  }

  try {
    const [described, full, mode] = await Promise.all([
      gateway.request<any>('profiles.describe', { name, profile: name }, 30_000),
      gateway.request<any>('config.get', { key: 'full', profile: name }, 30_000).catch(() => null),
      // The mode Hermes's guard actually enforces (its own normalisation), not our reading of the YAML.
      gateway.request<any>('config.get', { key: 'approvals.mode', profile: name }, 30_000).catch(() => null)
    ])

    const cfg = (full?.config && typeof full.config === 'object' ? full.config : {}) as Record<string, any>
    const rawMode = mode && 'value' in mode ? mode.value : cfg.approvals?.mode
    const approvals = normalizeApprovals(rawMode)

    if (approvals === 'unknown') {
      console.warn(`[botconfig] ${name}: unrecognised approvals.mode ${JSON.stringify(rawMode)}`)
    }

    put(name, {
      model: { provider: String(described?.model?.provider || ''), model: String(described?.model?.default || '') },
      reasoning: String(cfg.agent?.reasoning_effort ?? ''),
      approvals,
      ...(approvals === 'unknown' ? { approvalsRaw: String(rawMode) } : {}),
      cwd: String(cfg.terminal?.cwd ?? ''),
      toolsets: Array.isArray(described?.toolsets) ? described.toolsets : [],
      toolsetsPinned: Boolean(described?.toolsets_pinned),
      skills: Array.isArray(described?.skills) ? described.skills : [],
      mcp: Array.isArray(described?.mcp_servers) ? described.mcp_servers : [],
      timezone: String(cfg.timezone ?? '').trim()
    })
  } catch (error) {
    put(name, { error: String((error as Error).message || error) })
  }
}

export async function loadProviders(name: string): Promise<ProviderOption[]> {
  if (preview) {
    return preview
  }

  const res = await gateway.request<any>('model.options', { profile: name }, 60_000)

  return (Array.isArray(res?.providers) ? res.providers : [])
    .filter((row: any) => row && row.slug && Array.isArray(row.models) && row.models.length)
    .map((row: any) => ({
      slug: String(row.slug),
      name: String(row.name || row.slug),
      models: row.models.map(String),
      current: Boolean(row.is_current),
      authenticated: row.authenticated !== false,
      warning: row.warning ? String(row.warning) : undefined,
      ...(row.capabilities && typeof row.capabilities === 'object'
        ? { reasoning: Object.fromEntries(Object.entries(row.capabilities).map(([m, c]: [string, any]) => [m, c?.reasoning !== false])) }
        : {})
    }))
}

export interface ModelResult {
  /** Hermes wants the person to confirm before pinning this model (cost or data policy). */
  confirm?: string
}

export async function setModel(name: string, provider: string, model: string, confirmed = false): Promise<ModelResult> {
  if (preview) {
    patchConfig(name, cfg => ({ ...cfg, model: { provider, model } }))

    return {}
  }

  const res = await gateway.request<any>('profiles.configure', {
    name,
    profile: name,
    provider,
    model,
    ...(confirmed ? { confirm_expensive_model: true } : {})
  })

  if (res?.confirm_required) {
    return { confirm: String(res.confirm_message || 'Hermes asks you to confirm this model.') }
  }

  if (res?.applied?.model === false) {
    throw new Error("Hermes couldn't switch to that model. Check that its provider is connected.")
  }

  await loadBotConfig(name, true)
  void refreshProfiles().catch(() => undefined)

  return {}
}

export async function setApprovals(name: string, mode: Approvals) {
  if (preview) {
    return
  }

  await gateway.request('config.set', { key: 'approvals.mode', value: mode, profile: name })
  await loadBotConfig(name, true)

  const after = $botConfig.get()[name]

  if (isLoaded(after) && after.approvals !== mode) {
    throw new Error(`Hermes kept approvals at "${approvalLabel(after.approvals)}" instead of "${approvalLabel(mode)}".`)
  }
}

export async function setReasoning(name: string, level: string) {
  if (preview) {
    return
  }

  await gateway.request('config.set', { key: 'reasoning', value: level, scope: 'global', profile: name })
  await loadBotConfig(name, true)
}

export async function setWorkingFolder(name: string, folder: string) {
  if (preview) {
    patchConfig(name, cfg => ({ ...cfg, cwd: folder }))

    return
  }

  await gateway.request('config.set', { key: 'cwd', value: folder, profile: name })
  await loadBotConfig(name, true)
}

async function configure(name: string, patch: Record<string, unknown>, section: string) {
  if (preview) {
    return
  }

  const res = await gateway.request<any>('profiles.configure', { name, profile: name, ...patch })

  if (res?.applied?.[section] === false) {
    throw new Error('Hermes could not save that change.')
  }

  await loadBotConfig(name, true)
}

export const setToolsets = (name: string, enabled: string[]) => configure(name, { enabled_toolsets: enabled }, 'toolsets')

/** `enabled` is the list of skills that stay on; Hermes stores the complement as "disabled". */
export function setSkills(name: string, skills: SkillInfo[], enabled: string[]) {
  const on = new Set(enabled)

  return configure(name, { disabled_skills: skills.filter(skill => !on.has(skill.name)).map(skill => skill.name) }, 'skills')
}

export const setMcp = (name: string, enabled: string[]) => configure(name, { enabled_mcp_servers: enabled }, 'mcp_servers')

/** A one-line summary for the panel: "12 of 14 on". */
export const countOn = (items: { enabled: boolean }[]) => `${items.filter(item => item.enabled).length} of ${items.length} on`
