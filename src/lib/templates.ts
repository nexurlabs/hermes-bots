/**
 * Bot templates: a bot's setup as a `.hermesbot.json` file, and a new bot made from one.
 *
 * What goes in: name, label, description, face (shape/colour or a small embedded picture), the
 * persona (the profile's SOUL.md), model + provider *name*, thinking level, approvals, the tool
 * list, skills (names; optionally the files of skills the default bot doesn't have), MCP servers
 * with every secret replaced by a `${VAR}` placeholder, routines (prompt, schedule or event type),
 * and — only if asked — the bot's own memory notes (MEMORY.md, never USER.md).
 *
 * What never goes in: .env values, API keys, tokens, OAuth credentials, chat history, webhook URLs
 * or secrets, USER.md. As a last line of defence the finished JSON is scanned with the same
 * key patterns as the composer's pasted-key guard (plus generic ones); anything that still looks
 * like a credential is replaced with `[removed]` and listed.
 *
 * Import makes the bot through Hermes's own profile APIs (`profiles.create` cloned from the main
 * bot for its credentials and built-in skills, `profiles.configure`, `config.set`, the model
 * switch), adds MCP servers through `PUT /api/config` (placeholders are resolved by Hermes from the
 * bot's .env at launch), writes bundled skill files and memory with `/api/files/upload`, recreates
 * routines, then opens a secure secret card (the `request_secret` flow) for each required secret.
 */
import { $botConfig, GROUPS_SERVER, isLoaded, loadBotConfig, setApprovals, setMcp, setModel, setReasoning, setSkills, setToolsets, THIS_PC_SERVER, type Approvals, type BotConfig } from './botconfig'
import { $hooks, EVENT_SCHEDULE, hookFor, isEventSchedule, putHook, refreshHooks } from './event-routines'
import { gateway } from './gateway'
import { native } from './native'
import { botNameOn, hostHttp } from './hosts'
import { $routines, createParkedRoutine, createRoutine, isRoutineList, loadRoutineDetail, loadRoutines, setPaused, type Routine } from './routines'
import { addSecretCard, findKey, listSecretNames, NAME_RE } from './secrets'
import { $active, $allBots, $avatars, $profiles, createBot, refreshProfiles, saveMeta, slugify } from './store'
import { newId } from './chat'
import { basePrompt } from './event-routines'

export const TEMPLATE_FORMAT = 'hermes-bot-template'
export const TEMPLATE_VERSION = 1
export const TEMPLATE_EXT = '.hermesbot.json'
const MAX_SKILL_BYTES = 256 * 1024
const MAX_TEMPLATE_BYTES = 8 * 1024 * 1024

export interface TemplateMcp {
  url?: string
  command?: string
  args?: string[]
  /** Values are always `${NAME}` placeholders. */
  env?: Record<string, string>
  headers?: Record<string, string>
  auth?: string
  enabled: boolean
  tools?: unknown
}

export interface TemplateRoutine {
  name: string
  prompt: string
  trigger: { kind: 'schedule'; schedule: string } | { kind: 'github'; events: string[] } | { kind: 'webhook' }
  paused?: boolean
}

export interface TemplateSkillFile {
  path: string
  /** UTF-8 text. Binary skill files aren't bundled. */
  text: string
}

export interface BotTemplate {
  format: typeof TEMPLATE_FORMAT
  version: number
  exportedAt: string
  app: string
  bot: { name: string; display: string; label?: string; description?: string; color?: string; shape?: string; avatar?: string }
  persona: { soul: string }
  model: { provider: string; model: string; reasoning?: string }
  approvals: Approvals
  toolsets: { pinned: boolean; enabled: string[] }
  skills: { enabled: string[]; disabled: string[]; bundled: { name: string; files: TemplateSkillFile[] }[] }
  mcpServers: Record<string, TemplateMcp>
  routines: TemplateRoutine[]
  memory?: { notes: string }
  requiredSecrets: { name: string; label: string; usedBy: string }[]
}

export interface ExportOptions {
  memory: boolean
  bundleSkills: boolean
}

export interface ExportResult {
  template: BotTemplate
  /** What the secret scan removed (where, which pattern). */
  stripped: string[]
  /** Things that couldn't be included and why. */
  notes: string[]
}

let preview = false
export const setTemplatesPreview = (on: boolean) => {
  preview = on
}

// ── talking to Hermes ─────────────────────────────────────────────────────
/** The bot a template is being built from / created as: its machine gets the calls (hosts.ts). */
let scopeWho = ''

async function api(method: string, path: string, body?: unknown, timeoutMs = 30_000) {
  const active = $active.get()

  if (!active) {
    throw new Error('Not connected to Hermes')
  }

  const res = await hostHttp({ baseUrl: active.baseUrl, token: active.token, method, path, body, timeoutMs }, scopeWho || undefined)

  if (!res.ok) {
    throw new Error(String(res.json?.detail || res.text || `Hermes answered ${res.status}`))
  }

  return res.json as any
}

const withProfile = (path: string, profile: string) => `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`
const sepOf = (path: string) => (path.includes('\\') && !path.includes('/') ? '\\' : '/')
const join = (base: string, ...parts: string[]) => [base.replace(/[\\/]+$/, ''), ...parts].join(sepOf(base))
const profilePath = (name: string) => $profiles.get().find(row => row.name === name)?.path || ''

const utf8ToDataUrl = (text: string, mime = 'text/plain') => {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  bytes.forEach(b => (bin += String.fromCharCode(b)))

  return `data:${mime};base64,${btoa(bin)}`
}

const dataUrlToText = (dataUrl: string) => {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))

  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, c => c.charCodeAt(0)))
}

// ── secrets: placeholders and the scan ──────────────────────────────────────
const SECRETISH = /(key|token|secret|password|passwd|pwd|auth|credential|bearer|cookie|session|private)/i
const envName = (...parts: string[]) =>
  parts
    .join('_')
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, '_$1')
    .slice(0, 64) || 'SECRET'

const PLACEHOLDER = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g

/** An MCP server with every value that could carry a secret turned into a `${VAR}` placeholder. */
export function stripMcp(server: string, raw: Record<string, any>, need: (name: string, why: string) => void): TemplateMcp {
  const out: TemplateMcp = { enabled: raw.enabled !== false }
  const keepPlaceholders = (value: string, fallback: string, why: string) => {
    const refs = [...value.matchAll(PLACEHOLDER)].map(m => m[1])

    if (refs.length) {
      refs.forEach(ref => need(ref, why))

      return value
    }

    need(fallback, why)

    return `\${${fallback}}`
  }

  if (typeof raw.url === 'string') {
    try {
      const url = new URL(raw.url)

      for (const [k] of [...url.searchParams]) {
        if (SECRETISH.test(k)) {
          const name = envName(server, k)
          url.searchParams.set(k, `\${${name}}`)
          need(name, `${server} URL`)
        }
      }

      url.username = ''
      url.password = ''
      out.url = url.toString().replace(/%24(?:%7B|\{)([A-Za-z0-9_]+)(?:%7D|\})/gi, '${$1}')
    } catch {
      out.url = String(raw.url).replace(/[?#].*$/, '')
    }
  }

  if (typeof raw.command === 'string') out.command = raw.command
  if (Array.isArray(raw.args)) {
    // Arguments sometimes carry a key (`--api-key sk-...`): the scan below catches known shapes,
    // and a value right after a secret-sounding flag becomes a placeholder.
    out.args = raw.args.map(String).map((arg: string, i: number, all: string[]) => {
      const flag = all[i - 1] || ''
      const inline = arg.match(/^(--?[\w-]+)=(.+)$/)

      if (inline && SECRETISH.test(inline[1])) return `${inline[1]}=${keepPlaceholders(inline[2], envName(server, inline[1].replace(/^-+/, '')), `${server} argument`)}`
      if (/^--?[\w-]+$/.test(flag) && SECRETISH.test(flag) && !arg.startsWith('-')) return keepPlaceholders(arg, envName(server, flag.replace(/^-+/, '')), `${server} argument`)

      return arg
    })
  }

  if (raw.env && typeof raw.env === 'object') {
    // Plain settings (LOG_LEVEL=debug) stay; anything secret-named or token-shaped becomes a placeholder.
    const plain = (k: string, v: string) => !SECRETISH.test(k) && v.length <= 64 && !/[A-Za-z0-9_+/=-]{24,}/.test(v) && !findKey(v) && !v.includes('${')
    out.env = Object.fromEntries(
      Object.keys(raw.env).map(k => {
        const v = String(raw.env[k] ?? '')

        return [k, plain(k, v) ? v : keepPlaceholders(v, NAME_RE.test(k) ? k : envName(k), `${server} (env)`)]
      })
    )
  }

  if (raw.headers && typeof raw.headers === 'object') {
    out.headers = Object.fromEntries(
      Object.keys(raw.headers).map(k => {
        const value = String(raw.headers[k] ?? '')

        if (/^authorization$/i.test(k)) {
          const scheme = value.match(/^(Bearer|Basic|Token)\s+/i)?.[1]
          const ph = keepPlaceholders(value.replace(/^(Bearer|Basic|Token)\s+/i, ''), envName('MCP', server, 'TOKEN'), `${server} header`)

          return [k, scheme ? `${scheme} ${ph}` : ph]
        }

        return [k, SECRETISH.test(k) || /\$\{/.test(value) ? keepPlaceholders(value, envName(server, k), `${server} header`) : value]
      })
    )
  }

  if (typeof raw.auth === 'string') out.auth = raw.auth
  if (raw.tools !== undefined) out.tools = raw.tools

  return out
}

const GENERIC_SECRETS: { re: RegExp; what: string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, what: 'a private key' },
  { re: /\bBearer\s+(?!\$\{)[A-Za-z0-9._~+/=-]{20,}/g, what: 'a bearer token' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, what: 'a JWT' },
  { re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g, what: 'a Stripe key' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, what: 'a GitLab token' },
  { re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"]+:[^\s/@"]+@/gi, what: 'a password in a URL' }
]

/** Scans every string in the template; known key shapes are replaced with `[removed]`. */
export function scanTemplate<T>(value: T): { clean: T; stripped: string[] } {
  const stripped: string[] = []
  const visit = (node: unknown, where: string): unknown => {
    if (typeof node === 'string') {
      // The embedded picture is base64, not text: skip it (it can't be "read" as a key anyway).
      if (/^data:image\//.test(node)) return node
      let text = node

      for (let hit = findKey(text); hit; hit = findKey(text)) {
        stripped.push(`${where}: something shaped like ${hit.name}`)
        text = text.split(hit.key).join('[removed]')
      }

      for (const { re, what } of GENERIC_SECRETS) {
        text = text.replace(re, () => {
          stripped.push(`${where}: ${what}`)

          return '[removed]'
        })
      }

      return text
    }

    if (Array.isArray(node)) return node.map((item, i) => visit(item, `${where}[${i}]`))
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v, where ? `${where}.${k}` : k)]))

    return node
  }

  return { clean: visit(value, '') as T, stripped }
}

// ── export ──────────────────────────────────────────────────────────────────
async function smallAvatar(dataUrl: string): Promise<string | undefined> {
  if (!/^data:image\//.test(dataUrl)) return undefined

  try {
    const blob = await (await fetch(dataUrl)).blob()
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, 160 / Math.max(bitmap.width, bitmap.height, 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()

    return canvas.toDataURL('image/webp', 0.85)
  } catch {
    return dataUrl.length < 120_000 ? dataUrl : undefined
  }
}

async function listDir(path: string): Promise<{ name: string; path: string; dir: boolean; size: number }[]> {
  const json = await api('GET', `api/files?path=${encodeURIComponent(path)}`)

  return (Array.isArray(json?.entries) ? json.entries : []).map((e: any) => ({ name: String(e.name), path: String(e.path), dir: Boolean(e.is_directory), size: Number(e.size || 0) }))
}

// The skill folder holding SKILL.md under <profile>/skills, a few levels down (Hermes nests by category).
async function findSkillDir(root: string, name: string, depth = 0): Promise<string> {
  if (depth > 3) return ''
  const entries = await listDir(root).catch(() => [])
  const direct = entries.find(e => e.dir && e.name.toLowerCase() === name.toLowerCase())

  if (direct) return direct.path

  for (const e of entries.filter(e => e.dir && !e.name.startsWith('.'))) {
    const found = await findSkillDir(e.path, name, depth + 1)
    if (found) return found
  }

  return ''
}

async function readSkillFiles(dir: string, base = dir, budget = { left: MAX_SKILL_BYTES }): Promise<TemplateSkillFile[]> {
  const out: TemplateSkillFile[] = []

  for (const entry of await listDir(dir)) {
    if (entry.name.startsWith('.') || /^(\.env.*|.*\.(pem|key|p12|pfx))$/i.test(entry.name)) continue
    if (entry.dir) {
      out.push(...(await readSkillFiles(entry.path, base, budget)))
      continue
    }
    if (entry.size > budget.left) throw new Error('over 256 KB')
    const json = await api('GET', `api/files/read?path=${encodeURIComponent(entry.path)}`, undefined, 60_000)

    try {
      const text = dataUrlToText(String(json?.data_url || ''))
      budget.left -= entry.size
      out.push({ path: entry.path.slice(base.length).replace(/^[\\/]+/, '').replace(/\\/g, '/'), text })
    } catch {
      /* binary: skipped */
    }
  }

  return out
}

function routineOf(bot: string, routine: Routine, prompt: string): TemplateRoutine | null {
  if (/^once/i.test(routine.schedule) || routine.state === 'completed') return null
  if (isEventSchedule(routine.schedule)) {
    const hook = hookFor($hooks.get(), bot, routine.id)

    return { name: routine.name, prompt, trigger: hook?.kind === 'github' ? { kind: 'github', events: hook.events } : { kind: 'webhook' }, ...(routine.enabled ? {} : { paused: true }) }
  }

  return { name: routine.name, prompt, trigger: { kind: 'schedule', schedule: routine.schedule }, ...(routine.enabled ? {} : { paused: true }) }
}

/** Builds the template from the bot's live setup. Nothing secret is read: no .env, no auth files. */
export async function buildTemplate(name: string, opts: ExportOptions): Promise<ExportResult> {
  scopeWho = name

  const bot = $allBots.get().find(b => b.name === name)

  if (!bot) throw new Error(`No bot called ${name}`)

  const notes: string[] = []
  const secrets = new Map<string, { label: string; usedBy: string }>()
  const need = (secret: string, why: string) => !secrets.has(secret) && secrets.set(secret, { label: secret, usedBy: why })

  if (!preview) await loadBotConfig(name, true)
  const cfg = $botConfig.get()[name]

  if (!isLoaded(cfg)) throw new Error(`Couldn't read ${bot.display}'s setup`)

  let soul = ''
  let rawMcp: Record<string, any> = {}

  if (preview) {
    soul = `You are ${bot.display}. ${bot.meta.description || ''}`.trim()
    rawMcp = (window as any).__demoMcp || {}
  } else {
    const [described, full] = await Promise.all([
      gateway.request<any>('profiles.describe', { name, profile: name }, 30_000),
      gateway.request<any>('config.get', { key: 'full', profile: name }, 30_000).catch(() => null)
    ])
    soul = String(described?.soul || '')
    rawMcp = full?.config?.mcp_servers && typeof full.config.mcp_servers === 'object' ? full.config.mcp_servers : {}
  }

  const mcpServers: Record<string, TemplateMcp> = {}

  for (const [server, raw] of Object.entries(rawMcp)) {
    if (server === GROUPS_SERVER || server === THIS_PC_SERVER || !raw || typeof raw !== 'object') continue
    if ((raw as any).auth === 'oauth') notes.push(`${server} signs in with OAuth: whoever imports it signs in again (no OAuth tokens are included).`)
    mcpServers[server] = stripMcp(server, raw as Record<string, any>, need)
  }

  // Routines: full prompts, the trigger, nothing about URLs or HMAC secrets.
  if (!preview) {
    await loadRoutines(name, true)
    await refreshHooks().catch(() => undefined)
  }
  const list = $routines.get()[name]
  const routines: TemplateRoutine[] = []

  for (const routine of isRoutineList(list) ? list : []) {
    const prompt = preview ? routine.prompt : basePrompt((await loadRoutineDetail(name, routine).catch(() => routine)).prompt)
    const item = routineOf(name, routine, prompt)
    if (item) routines.push(item)
    else notes.push(`"${routine.name}" runs once (or already ran), so it isn't included.`)
  }

  // Skills: names always; files only for skills the main bot doesn't have (its own custom ones).
  const bundled: BotTemplate['skills']['bundled'] = []

  if (opts.bundleSkills && !preview) {
    const base = $botConfig.get().default
    const known = new Set(isLoaded(base) ? base.skills.map(s => s.name.toLowerCase()) : [])
    const root = profilePath(name) ? join(profilePath(name), 'skills') : ''

    for (const skill of cfg.skills.filter(s => !known.has(s.name.toLowerCase()) && name !== 'default')) {
      try {
        const dir = root ? await findSkillDir(root, skill.name) : ''
        if (!dir) throw new Error('not found')
        bundled.push({ name: skill.name, files: await readSkillFiles(dir) })
      } catch (error) {
        notes.push(`Skill ${skill.name}'s files weren't bundled (${(error as Error).message}); only its name is.`)
      }
    }
  } else if (opts.bundleSkills && preview) {
    bundled.push({ name: 'release-notes', files: [{ path: 'SKILL.md', text: '---\nname: release-notes\ndescription: Draft release notes from merged PRs\n---\n\nRead the merged PRs since the last tag…' }] })
  }

  let memory: BotTemplate['memory']

  if (opts.memory) {
    try {
      const path = profilePath(name)
      const json = preview ? { text: '- Prefers short bullet summaries.\n- Repo of record: acme/web.' } : await api('GET', `api/fs/read-text?path=${encodeURIComponent(join(path, 'memories', 'MEMORY.md'))}`)
      const notesText = String(json?.text || '').trim()
      if (notesText) memory = { notes: notesText }
    } catch (error) {
      notes.push(`Memory wasn't included: ${(error as Error).message}`)
    }
  }

  const avatar = $avatars.get()[name] ? await smallAvatar($avatars.get()[name]) : undefined
  const template: BotTemplate = {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'Hermes Bots',
    bot: {
      name,
      display: bot.display,
      ...(bot.meta.label ? { label: String(bot.meta.label) } : {}),
      ...(bot.meta.description ? { description: String(bot.meta.description) } : {}),
      ...(bot.meta.color ? { color: String(bot.meta.color) } : {}),
      ...(bot.meta.shape ? { shape: String(bot.meta.shape) } : {}),
      ...(avatar ? { avatar } : {})
    },
    persona: { soul },
    model: { provider: cfg.model.provider, model: cfg.model.model, ...(cfg.reasoning ? { reasoning: cfg.reasoning } : {}) },
    approvals: cfg.approvals,
    toolsets: { pinned: cfg.toolsetsPinned, enabled: cfg.toolsets.filter(t => t.enabled).map(t => t.name) },
    skills: { enabled: cfg.skills.filter(s => s.enabled).map(s => s.name), disabled: cfg.skills.filter(s => !s.enabled).map(s => s.name), bundled },
    mcpServers,
    routines,
    ...(memory ? { memory } : {}),
    requiredSecrets: [...secrets.entries()].map(([secret, info]) => ({ name: secret, ...info }))
  }

  const { clean, stripped } = scanTemplate(template)

  return { template: clean, stripped, notes }
}

export const templateFileName = (t: BotTemplate) => `${slugify(t.bot.display || t.bot.name) || 'bot'}${TEMPLATE_EXT}`

/** Saves the file (desktop: a Save dialog; browser: a download). */
export async function saveTemplateFile(t: BotTemplate) {
  const text = JSON.stringify(t, null, 2)
  // One more scan on the exact bytes that leave, in case anything slipped past.
  if (findKey(text)) throw new Error('The template still contains something that looks like a key. Not saved.')
  const url = utf8ToDataUrl(text, 'application/json')

  if (native.saveFile) return native.saveFile(templateFileName(t), url)
  const link = document.createElement('a')
  link.href = url
  link.download = templateFileName(t)
  link.click()

  return { ok: true }
}

// ── import ──────────────────────────────────────────────────────────────────
/** Reads and checks a template file; an error sentence if it isn't one. */
export function parseTemplate(text: string): BotTemplate | string {
  if (text.length > MAX_TEMPLATE_BYTES) return 'That file is too large to be a bot template.'
  let raw: any

  try {
    raw = JSON.parse(text)
  } catch {
    return "That file isn't valid JSON."
  }

  if (raw?.format !== TEMPLATE_FORMAT) return "That isn't a Hermes Bots template (.hermesbot.json)."
  if (typeof raw.version !== 'number' || raw.version > TEMPLATE_VERSION) return `This template is version ${raw.version}; this app reads up to version ${TEMPLATE_VERSION}. Update Hermes Bots.`
  if (!raw.bot || typeof raw.bot.display !== 'string') return 'The template has no bot in it.'

  const t: BotTemplate = {
    format: TEMPLATE_FORMAT,
    version: raw.version,
    exportedAt: String(raw.exportedAt || ''),
    app: String(raw.app || ''),
    bot: {
      name: String(raw.bot.name || ''),
      display: String(raw.bot.display).slice(0, 80),
      ...(raw.bot.label ? { label: String(raw.bot.label).slice(0, 80) } : {}),
      ...(raw.bot.description ? { description: String(raw.bot.description).slice(0, 2000) } : {}),
      ...(raw.bot.color ? { color: String(raw.bot.color) } : {}),
      ...(raw.bot.shape ? { shape: String(raw.bot.shape) } : {}),
      ...(typeof raw.bot.avatar === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(raw.bot.avatar) && raw.bot.avatar.length < 400_000 ? { avatar: raw.bot.avatar } : {})
    },
    persona: { soul: String(raw.persona?.soul || '').slice(0, 200_000) },
    model: { provider: String(raw.model?.provider || ''), model: String(raw.model?.model || ''), ...(raw.model?.reasoning ? { reasoning: String(raw.model.reasoning) } : {}) },
    approvals: (['manual', 'off', 'smart'].includes(raw.approvals) ? raw.approvals : 'manual') as Approvals,
    toolsets: { pinned: Boolean(raw.toolsets?.pinned), enabled: Array.isArray(raw.toolsets?.enabled) ? raw.toolsets.enabled.map(String) : [] },
    skills: {
      enabled: Array.isArray(raw.skills?.enabled) ? raw.skills.enabled.map(String) : [],
      disabled: Array.isArray(raw.skills?.disabled) ? raw.skills.disabled.map(String) : [],
      bundled: (Array.isArray(raw.skills?.bundled) ? raw.skills.bundled : [])
        .filter((s: any) => /^[\w.-]{1,64}$/.test(String(s?.name || '')))
        .map((s: any) => ({
          name: String(s.name),
          files: (Array.isArray(s.files) ? s.files : [])
            .filter((f: any) => typeof f?.text === 'string' && typeof f?.path === 'string' && !f.path.split(/[\\/]/).some((p: string) => p === '..' || p === '') && !/^[\\/]|^[A-Za-z]:/.test(f.path))
            .map((f: any) => ({ path: String(f.path), text: String(f.text) }))
        }))
    },
    mcpServers: raw.mcpServers && typeof raw.mcpServers === 'object' ? raw.mcpServers : {},
    routines: (Array.isArray(raw.routines) ? raw.routines : [])
      .filter((r: any) => typeof r?.prompt === 'string' && r?.trigger)
      .map((r: any) => ({
        name: String(r.name || r.prompt).slice(0, 120),
        prompt: String(r.prompt),
        trigger:
          r.trigger.kind === 'github' ? { kind: 'github', events: Array.isArray(r.trigger.events) ? r.trigger.events.map(String) : ['*'] } : r.trigger.kind === 'webhook' ? { kind: 'webhook' } : { kind: 'schedule', schedule: String(r.trigger.schedule || '') },
        ...(r.paused ? { paused: true } : {})
      })),
    ...(raw.memory?.notes ? { memory: { notes: String(raw.memory.notes).slice(0, 20_000) } } : {}),
    requiredSecrets: (Array.isArray(raw.requiredSecrets) ? raw.requiredSecrets : [])
      .filter((s: any) => NAME_RE.test(String(s?.name || '')))
      .map((s: any) => ({ name: String(s.name), label: String(s.label || s.name).slice(0, 80), usedBy: String(s.usedBy || '').slice(0, 120) }))
  }

  // A shared file is untrusted: scan it too, and never write anything that looks like a key.
  return scanTemplate(t).clean
}

/** A free profile name close to `want`. */
export function freeProfileName(want: string) {
  const taken = new Set($profiles.get().map(row => row.name))
  const base = slugify(want) || 'bot'
  let name = base

  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`

  return name
}

/** `host`: the machine it's going on (hosts.ts); names only clash on the same machine. */
export const profileNameProblem = (name: string, host = '') =>
  !name ? 'Give it a profile name' : !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) ? 'Lowercase letters, digits and dashes' : $profiles.get().some(row => row.name === botNameOn(name, host)) ? 'That name is taken' : ''

export interface ImportStep {
  label: string
  state: 'todo' | 'doing' | 'done' | 'warn'
  note?: string
}

/** Makes the bot. `onStep` reports progress; problems after the bot exists are warnings, not failures. */
export async function createFromTemplate(t: BotTemplate, profile: string, display: string, onStep: (steps: ImportStep[]) => void): Promise<{ name: string; warnings: string[] }> {
  scopeWho = profile

  const steps: ImportStep[] = [
    { label: 'Create the bot', state: 'todo' },
    { label: 'Model, tools and approvals', state: 'todo' },
    { label: 'Skills', state: 'todo' },
    { label: 'Connected apps (MCP)', state: 'todo' },
    { label: 'Routines', state: 'todo' },
    ...(t.memory ? [{ label: 'Memory', state: 'todo' as const }] : []),
    { label: 'Secrets', state: 'todo' }
  ]
  const warnings: string[] = []
  const step = async (i: number, work: () => Promise<string | void>) => {
    steps[i] = { ...steps[i], state: 'doing' }
    onStep([...steps])
    try {
      const note = await work()
      steps[i] = { ...steps[i], state: note ? 'warn' : 'done', ...(note ? { note } : {}) }
      if (note) warnings.push(`${steps[i].label}: ${note}`)
    } catch (error) {
      const note = String((error as Error).message || error)
      steps[i] = { ...steps[i], state: 'warn', note }
      warnings.push(`${steps[i].label}: ${note}`)
      if (i === 0) {
        onStep([...steps])
        throw error
      }
    }
    onStep([...steps])
  }
  const slow = () => new Promise(resolve => setTimeout(resolve, preview ? 350 : 0))

  let name = profile

  await step(0, async () => {
    if (preview) return void (await slow())
    name = await createBot({ name: profile, display, description: t.bot.description || '', soul: t.persona.soul, color: t.bot.color, shape: t.bot.shape, image: t.bot.avatar || null, inherit: true })
    if (t.bot.label) await saveMeta(name, { label: t.bot.label })
    await loadBotConfig(name, true)
  })

  await step(1, async () => {
    if (preview) return void (await slow())
    const problems: string[] = []
    if (t.model.provider && t.model.model) {
      const res = await setModel(name, t.model.provider, t.model.model, true).catch(error => ({ error: String(error.message || error) }) as any)
      if (res && (res as any).error) problems.push(`model ${t.model.model} (${(res as any).error}); it uses the main bot's model`)
    }
    if (t.model.reasoning) await setReasoning(name, t.model.reasoning).catch(() => problems.push('thinking level'))
    await setApprovals(name, t.approvals).catch(() => problems.push('approvals'))
    if (t.toolsets.pinned) await setToolsets(name, t.toolsets.enabled).catch(() => problems.push('tool list'))

    return problems.length ? `Couldn't set ${problems.join(', ')}` : undefined
  })

  await step(2, async () => {
    if (preview) return void (await slow())
    const root = profilePath(name) ? join(profilePath(name), 'skills') : ''
    const failed: string[] = []

    for (const skill of t.skills.bundled) {
      try {
        if (!root) throw new Error('no profile folder')
        for (const file of skill.files) {
          await api('POST', 'api/files/upload', { path: join(root, skill.name, ...file.path.split('/')), data_url: utf8ToDataUrl(file.text), overwrite: true }, 60_000)
        }
      } catch {
        failed.push(skill.name)
      }
    }
    await loadBotConfig(name, true)
    const cfg = $botConfig.get()[name] as BotConfig
    const off = new Set(t.skills.disabled.map(s => s.toLowerCase()))
    const want = new Set(t.skills.enabled.map(s => s.toLowerCase()))
    if (isLoaded(cfg)) await setSkills(name, cfg.skills, cfg.skills.filter(s => want.has(s.name.toLowerCase()) || (!off.has(s.name.toLowerCase()) && s.enabled)).map(s => s.name))
    const missing = t.skills.enabled.filter(s => isLoaded(cfg) && !cfg.skills.some(k => k.name.toLowerCase() === s.toLowerCase()))

    return [failed.length ? `couldn't write ${failed.join(', ')}` : '', missing.length ? `not installed here: ${missing.join(', ')} (install with hermes skills)` : ''].filter(Boolean).join('; ') || undefined
  })

  await step(3, async () => {
    if (preview) return void (await slow())
    const servers = Object.fromEntries(Object.entries(t.mcpServers).filter(([server]) => server !== GROUPS_SERVER && server !== THIS_PC_SERVER))
    if (Object.keys(servers).length) await api('PUT', withProfile('api/config', name), { config: { mcp_servers: servers }, profile: name })
    await loadBotConfig(name, true)
    const cfg = $botConfig.get()[name]
    const on = Object.entries(servers).filter(([, s]) => (s as TemplateMcp).enabled !== false).map(([server]) => server)
    if (isLoaded(cfg)) await setMcp(name, cfg.mcp.filter(m => on.includes(m.name) || m.name === GROUPS_SERVER || m.name === THIS_PC_SERVER).map(m => m.name))
  })

  await step(4, async () => {
    if (preview) return void (await slow())
    const failed: string[] = []

    for (const r of t.routines) {
      try {
        if (r.trigger.kind === 'schedule') {
          await createRoutine({ bot: name, name: r.name, prompt: r.prompt, schedule: r.trigger.schedule })
        } else {
          const id = await createParkedRoutine({ bot: name, name: r.name, prompt: r.prompt, schedule: EVENT_SCHEDULE })
          await putHook({ bot: name, routineId: id, kind: r.trigger.kind, events: r.trigger.kind === 'github' ? r.trigger.events : [] })
        }
        if (r.paused) {
          await loadRoutines(name, true)
          const list = $routines.get()[name]
          const made = isRoutineList(list) ? [...list].reverse().find(x => x.name === r.name) : undefined
          if (made) await setPaused(name, made, true)
        }
      } catch {
        failed.push(r.name)
      }
    }

    return failed.length ? `couldn't add ${failed.join(', ')}` : t.routines.some(r => r.trigger.kind !== 'schedule') ? 'event routines got new URLs; set them up again where the events come from' : undefined
  })

  if (t.memory) {
    await step(5, async () => {
      if (preview) return void (await slow())
      await api('POST', 'api/files/upload', { path: join(profilePath(name), 'memories', 'MEMORY.md'), data_url: utf8ToDataUrl(t.memory!.notes + '\n'), overwrite: true })
    })
  }

  await step(steps.length - 1, async () => {
    if (preview) return void (await slow())
    const have = new Set((await listSecretNames(name).catch(() => [])).map(s => s.name))
    const missing = t.requiredSecrets.filter(s => !have.has(s.name))
    for (const s of missing) addSecretCard(`bot:${name}`, { id: newId('k'), at: Date.now(), name: s.name, label: s.label || s.name, description: s.usedBy ? `Needed by ${s.usedBy} (from the template).` : 'Needed by this template.', status: 'open' })

    return missing.length ? `${missing.length} to enter in ${display}'s chat` : undefined
  })

  if (!preview) await refreshProfiles()

  return { name, warnings }
}

/** Duplicate: the same path as export → import, without a file (no memory, skill files bundled). */
export async function templateOfBot(name: string) {
  return (await buildTemplate(name, { memory: false, bundleSkills: true })).template
}
