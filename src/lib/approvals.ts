/**
 * Approval prompts for risky actions. When Hermes's approval gate stops a bot (a dangerous shell
 * command, a `computer_use` desktop action, a write to a protected file, a tool a plugin or an
 * untrusted MCP server flags), it sends the `approval` server request on the bot's session with
 * `request_id`, `command`, `description` and the `choices` it will accept (once / session /
 * always / deny). The app shows a card in the chat that bot is in (its 1:1 chat or the group),
 * answers with `approval.respond`, and keeps a one-line record of the answer in that chat.
 *
 * Hermes withdraws a request it stopped waiting for with `request.cancel` (timeout, stop, turn
 * over) and drops a session's approvals with `approval.cancelled`; both mark the card expired.
 *
 * This PC: the app registers its own `hermes-bots-this-pc` server as `trust: untrusted`, so Hermes
 * asks before every This PC action that isn't read-only (a screenshot isn't asked about). The card
 * names the action from the tool call Hermes just announced ("Click at (812, 604)"). "Allow for
 * this chat" covers that kind of action only. While "Allow control" is off, the ask is denied
 * without a card (the PC server would refuse it anyway), and turning control off, or the panic key,
 * denies any waiting This PC card and forgets those chat allows.
 */
import { atom, computed } from 'nanostores'

import { gateway } from './gateway'
import { cleanError, native } from './native'
import { toast } from './store'
import type { Approval, ApprovalChoice, ApprovalKind } from './types'

const STORE_KEY = 'approvals:v1'
const KEEP = 200

function load(): Approval[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]')

    return Array.isArray(raw) ? raw.filter(a => a && a.status !== 'pending' && a.status !== 'sending') : []
  } catch {
    return []
  }
}

export const $approvals = atom<Approval[]>(typeof localStorage === 'undefined' ? [] : load())

function save(list: Approval[]) {
  try {
    const done = list.filter(a => a.status !== 'pending' && a.status !== 'sending').slice(-KEEP)
    localStorage.setItem(STORE_KEY, JSON.stringify(done))
  } catch {
    /* fine */
  }
}

function setAll(list: Approval[]) {
  $approvals.set(list)
  save(list)
}

function patch(id: string, update: (a: Approval) => Approval) {
  setAll($approvals.get().map(a => (a.id === id ? update(a) : a)))
}

/** Waiting approvals per chat (`bot:<name>` / `room:<roomId>`), for the roster. */
export const $askingScopes = computed($approvals, list => {
  const out: Record<string, Approval[]> = {}

  for (const a of list) {
    if (a.status === 'pending') {
      ;(out[a.scope] ||= []).push(a)
    }
  }

  return out
})

export const approvalsFor = (list: Approval[], scope: string) => list.filter(a => a.scope === scope)

// ── wording ───────────────────────────────────────────────────────────────
const THIS_PC = 'hermes-bots-this-pc'
const quoted = (text: string, label: string) => new RegExp(`${label} '([^']+)'`).exec(text)?.[1] || ''
const cap = (text: string) => (text ? `${text[0].toUpperCase()}${text.slice(1)}` : '')

interface Shaped {
  kind: ApprovalKind
  command: string
  description: string
  /** Set for an untrusted-MCP prompt: Hermes asks on every call and keeps no grant itself. */
  mcpServer?: string
  /** This PC: the kind of action (`click`, `type`, …), what "Allow for this chat" covers. */
  action?: string
}

// ── This PC actions ───────────────────────────────────────────────────────
/** The latest This PC tool call each session announced (`tool.start` comes before Hermes asks). */
const pcCalls = new Map<string, { action: string; args: Record<string, any> }>()

/** `computer_click` → `click`, from Hermes's tool name (`mcp__hermes_bots_this_pc__computer_click`) or the bare one. */
export function pcAction(name: string): string {
  return /(?:^|_)computer_([a-z]+)$/.exec(name)?.[1] || ''
}

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : '?')
const spot = (x: unknown, y: unknown) => `(${num(x)}, ${num(y)})`
const clip = (text: unknown, max = 120) => {
  const flat = String(text ?? '')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const PC_ACTION: Record<string, { name: string; noun: string; uses: string }> = {
  move: { name: 'Move the mouse', noun: 'mouse moves', uses: 'Moves your mouse pointer.' },
  click: { name: 'Click', noun: 'clicks', uses: 'Clicks with your mouse.' },
  drag: { name: 'Drag', noun: 'drags', uses: 'Drags with your mouse.' },
  scroll: { name: 'Scroll', noun: 'scrolling', uses: 'Scrolls with your mouse wheel.' },
  type: { name: 'Type', noun: 'typing', uses: 'Types with your keyboard.' },
  key: { name: 'Press keys', noun: 'key presses', uses: 'Presses keys on your keyboard.' }
}

/**
 * Whether a card may offer "Allow for this chat". A command on this PC is never granted for a whole
 * chat: every one asks. Clicks and typing can still be granted for the chat, as before.
 */
export const chatGrantFor = (server: string | undefined, action: string | undefined) => !(server === THIS_PC && action === 'terminal')

/** What "Allow for this chat" covers on a This PC card, e.g. "clicks". */
export const pcNoun = (action: string | undefined) => (action && PC_ACTION[action]?.noun) || 'this kind of action'

/** One line for the card: the action and where, from the call's arguments. */
export function describePc(action: string, args: Record<string, any> = {}): string {
  switch (action) {
    case 'move':
      return `Move the mouse to ${spot(args.x, args.y)}`
    case 'click': {
      const button = args.button === 'right' ? 'Right-click' : args.button === 'middle' ? 'Middle-click' : 'Click'
      return `${args.double ? `Double-${button.toLowerCase()}` : button} at ${spot(args.x, args.y)}`
    }
    case 'drag':
      return `Drag from ${spot(args.fromX, args.fromY)} to ${spot(args.toX, args.toY)}`
    case 'scroll':
      return `Scroll ${args.direction || 'down'} ${num(args.amount ?? 3)} at ${spot(args.x, args.y)}`
    case 'type':
      return `Type "${clip(args.text)}"`
    case 'key':
      return `Press ${clip(args.combo, 60) || 'a key'}`
    default:
      return action ? `computer_${action}` : 'Use your PC'
  }
}

/** Turns Hermes's request into card text: what kind of thing, the action, and why. */
function shape(params: Record<string, any>): Shaped {
  const command = String(params.command || '').trim()
  const description = String(params.description || '').trim()
  const pattern = String(params.pattern_key || '')

  if (pattern === 'mcp_elicitation') {
    const tool = quoted(command, 'MCP tool')
    const server = quoted(command, 'server')

    if (server === THIS_PC) {
      const action = pcAction(tool)
      const call = pcCalls.get(String(params.session_id || ''))
      const args = call && call.action === action ? call.args : undefined

      return {
        kind: 'pc',
        command: args ? describePc(action, args) : PC_ACTION[action]?.name || tool || command,
        description: PC_ACTION[action]?.uses || 'Uses your mouse, keyboard or screen.',
        mcpServer: server,
        action: action || tool
      }
    }

    return {
      kind: server === THIS_PC ? 'pc' : 'tool',
      command: tool || command,
      description: server === THIS_PC ? 'Uses your mouse, keyboard or screen.' : server ? `From ${server}, which is set to ask first.` : description,
      mcpServer: server || 'mcp'
    }
  }

  if (command.startsWith('computer_use:')) {
    return { kind: 'pc', command: command.slice('computer_use:'.length).trim(), description: 'Uses your mouse and keyboard.' }
  }

  if (pattern === 'ssh_config_write' || command.startsWith('<write to')) {
    return { kind: 'file', command: command.replace(/^<write to (.*)>$/, '$1'), description: 'SSH settings can run commands, so this needs your OK.' }
  }

  if (pattern.startsWith('plugin_rule:')) {
    return { kind: 'tool', command: command.replace(/^<(.+)> \(plugin approval rule\)$/, '$1'), description: cap(description) }
  }

  return { kind: 'command', command, description: cap(description) }
}

export const KIND_ASK: Record<ApprovalKind, string> = {
  command: 'wants to run a command',
  pc: 'wants to use your PC',
  file: 'wants to change a protected file',
  tool: 'wants to use a tool'
}

export const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: 'Allow once',
  session: 'Allow for this chat',
  always: 'Always allow',
  deny: 'Deny'
}

export const RECORD_LABEL: Record<ApprovalChoice, string> = {
  once: 'Allowed once',
  session: 'Allowed for this chat',
  always: 'Always allowed',
  deny: 'Denied'
}

const CHOICES: ApprovalChoice[] = ['once', 'session', 'always', 'deny']

// ── incoming requests ─────────────────────────────────────────────────────
type Reply = (result: { choice: ApprovalChoice }) => void

/** The open server request each pending card answers, by card id. */
const replies = new Map<string, Reply>()
/** "Allow for this chat" on an untrusted-MCP prompt, which Hermes itself does not remember: `<owner>|<server>`, plus `|<action>` for This PC. */
const chatAllows = new Set<string>()
const ownerOf = new Map<string, string>()
const allowKey = (owner: string, server: string, action?: string) => (action ? `${owner}|${server}|${action}` : `${owner}|${server}`)

/** Whether "Allow control" is on for This PC (the main process tells us when it changes). */
let pcControl = false

if (typeof window !== 'undefined') {
  void native
    .computerGetState()
    .then(state => {
      pcControl = Boolean(state?.granted)
    })
    .catch(() => undefined)
  native.onComputerGrantedChanged(granted => {
    pcControl = granted

    if (!granted) {
      pcControlOff()
    }
  })
}

/** Control went off (the switch or Ctrl+Alt+Esc): deny waiting This PC asks and forget their chat allows. */
function pcControlOff() {
  for (const key of [...chatAllows]) {
    if (key.split('|')[1] === THIS_PC) {
      chatAllows.delete(key)
    }
  }

  for (const card of $approvals.get()) {
    if (card.status === 'pending' && card.server === THIS_PC) {
      void answerApproval(card.id, 'deny', false, 'control was turned off')
    }
  }
}

/** Where a session's card goes, from the app's session key (`bot:<name>` or `room:<roomId>:<member>`). */
function placeOf(owner: string): { bot: string; scope: string } | null {
  if (owner.startsWith('bot:')) {
    return { bot: owner.slice(4), scope: owner }
  }

  if (owner.startsWith('room:')) {
    const cut = owner.lastIndexOf(':')

    return cut > 5 ? { bot: owner.slice(cut + 1), scope: owner.slice(0, cut) } : null
  }

  return null
}

/**
 * An `approval` server request for a session the app owns. Returns false when the session is not
 * one of ours (the caller shows it as a floating prompt instead).
 */
export function openApproval(id: string, params: Record<string, any>, owner: string | undefined, reply: Reply): boolean {
  const place = owner ? placeOf(owner) : null

  if (!place || !owner) {
    return false
  }

  const sessionId = String(params.session_id || '')
  const requestId = String(params.request_id || '')
  const shaped = shape(params)
  const offered = (Array.isArray(params.choices) && params.choices.length ? params.choices : CHOICES).filter((c: string): c is ApprovalChoice =>
    CHOICES.includes(c as ApprovalChoice)
  )
  // Hermes grants nothing for "always" on an MCP consent prompt, so don't offer it.
  const noneForChat = chatGrantFor(shaped.mcpServer, shaped.action) ? [] : (['session'] as ApprovalChoice[])
  const choices = (shaped.mcpServer ? offered.filter(c => c !== 'always') : offered).filter(c => !noneForChat.includes(c))

  // Re-sent after a reconnect: point the existing card at the new request.
  const again = requestId ? $approvals.get().find(a => a.requestId === requestId && (a.status === 'pending' || a.status === 'sending')) : null

  if (again) {
    replies.delete(again.id)
    replies.set(id, reply)
    ownerOf.set(id, owner)
    patch(again.id, a => ({ ...a, id, sessionId }))

    return true
  }

  const card: Approval = {
    id,
    requestId,
    sessionId,
    bot: place.bot,
    scope: place.scope,
    kind: shaped.kind,
    command: shaped.command,
    description: shaped.description,
    choices: choices.length ? choices : ['once', 'deny'],
    server: shaped.mcpServer,
    action: shaped.action,
    flagged: Boolean(params.smart_denied) || undefined,
    status: 'pending',
    at: Date.now()
  }

  replies.set(id, reply)
  ownerOf.set(id, owner)
  setAll([...$approvals.get(), card])

  // Nothing on this PC can run while control is off, so don't ask: say no straight away.
  if (shaped.mcpServer === THIS_PC && !pcControl) {
    void answerApproval(id, 'deny', false, 'control is off')

    return true
  }

  if (shaped.mcpServer && chatAllows.has(allowKey(owner, shaped.mcpServer, shaped.mcpServer === THIS_PC ? shaped.action : undefined))) {
    void answerApproval(id, 'once', true)

    return true
  }

  // Tells Hermes the card is on screen (its approval timeout counts from here).
  if (requestId && sessionId) {
    void gateway.request('approval.received', { session_id: sessionId, request_id: requestId }).catch(() => undefined)
  }

  return true
}

/** Sends the answer to Hermes; the card then becomes a one-line record. */
export async function answerApproval(id: string, choice: ApprovalChoice, auto = false, why?: string) {
  const card = $approvals.get().find(a => a.id === id)

  if (!card || card.status !== 'pending') {
    return
  }

  patch(id, a => ({ ...a, status: 'sending' }))
  let landed = true

  if (card.requestId) {
    try {
      // `request_id` targets this exact approval; Hermes falls back to it if the session id went stale.
      const result = await gateway.request<{ resolved?: number }>('approval.respond', {
        session_id: card.sessionId,
        request_id: card.requestId,
        choice
      })

      landed = typeof result?.resolved !== 'number' || result.resolved > 0
    } catch (error) {
      if (!replies.has(id)) {
        // Not sent (the link is down, say): leave the card up so it can be answered again.
        patch(id, a => ({ ...a, status: 'pending' }))
        toast(cleanError(error), 'bad')

        return
      }
    }
  }

  // Also answer the request itself: the reply for an older Hermes, a no-op once `approval.respond` resolved it.
  replies.get(id)?.({ choice })
  replies.delete(id)

  const owner = ownerOf.get(id)
  ownerOf.delete(id)

  if (landed && choice === 'session' && owner && card.server && chatGrantFor(card.server, card.action) && !(card.server === THIS_PC && !pcControl)) {
    chatAllows.add(allowKey(owner, card.server, card.server === THIS_PC ? card.action : undefined))
  }

  patch(id, a =>
    landed
      ? { ...a, status: auto ? 'session' : choice, endedAt: Date.now(), ...(auto ? { auto: true } : {}), ...(why ? { note: why } : {}) }
      : { ...a, status: 'expired', endedAt: Date.now(), note: 'No longer waiting' }
  )
}

function expire(match: (a: Approval) => boolean, note: string) {
  const list = $approvals.get()

  if (!list.some(a => a.status === 'pending' && match(a))) {
    return
  }

  setAll(
    list.map(a => {
      if (a.status !== 'pending' || !match(a)) {
        return a
      }

      replies.delete(a.id)
      ownerOf.delete(a.id)

      return { ...a, status: 'expired', endedAt: Date.now(), note }
    })
  )
}

const CANCEL_NOTE: Record<string, string> = {
  timeout: 'Timed out',
  interrupted: 'Stopped',
  resolved: 'Answered elsewhere',
  session_closed: 'The bot moved on',
  shutdown: 'Hermes restarted'
}

gateway.on(event => {
  const payload = event.payload || {}

  if (event.type === 'tool.start' && event.session_id) {
    const action = /this_pc/.test(String(payload.name || '')) ? pcAction(String(payload.name || '')) : ''

    if (action) {
      pcCalls.set(event.session_id, { action, args: payload.args && typeof payload.args === 'object' ? payload.args : {} })
    }
  }

  if (event.type === 'request.cancel' && payload.method === 'approval') {
    expire(a => a.id === String(payload.id), CANCEL_NOTE[String(payload.reason)] || 'No longer waiting')
  } else if (event.type === 'approval.cancelled') {
    // Broadcast to every client, so the session is in the payload.
    const sid = String(payload.session_id || event.session_id || '')
    const ids: string[] = Array.isArray(payload.request_ids) ? payload.request_ids.map(String) : []
    expire(
      a => (ids.length ? ids.includes(a.requestId) : Boolean(sid) && a.sessionId === sid),
      payload.reason === 'interrupt' ? 'Stopped' : 'The bot moved on'
    )
  } else if ((event.type === 'message.complete' || event.type === 'error') && event.session_id) {
    // The turn is over, so nothing is waiting on an answer any more.
    expire(a => a.sessionId === event.session_id, 'The bot moved on')
  }
})

/** Plain one-liner for records and notifications. */
export function shortAction(card: Pick<Approval, 'command'>, max = 90): string {
  const flat = card.command.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
