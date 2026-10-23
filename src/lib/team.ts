/**
 * Team awareness: one short, plain-text picture of the whole team that every bot gets with its
 * turns (1:1 and group), and that the Team view shows the user. Hermes's own Bot Mode already
 * puts a teammate roster and the `message_agent` tool into each bot's "Bot Chat"; this adds what
 * only the app knows — labels, the Lead, models, live status, groups, the machine, the time.
 *
 * To keep prompts small the full directory is only resent when it changes (per session);
 * otherwise a turn carries just one line with the time and live status.
 */
import { hostOf, isHostOnline, machineLabel } from './hosts'
import { computed } from 'nanostores'

import { $botConfig, GROUPS_SERVER, isLoaded, loadBotConfig, THIS_PC_SERVER } from './botconfig'
import { gateway } from './gateway'
import { $memoryEdits, $sharedFacts, sharedFactLines } from './memory'
import { $sharedFolder } from './shared-folder'
import { $active, $allBots, $busy, $turnStatus, $userName, statusLine, type TurnStatus } from './store'
import type { Bot, Room } from './types'

export type Status = 'busy' | 'idle' | 'offline'

export interface TeamMember {
  bot: Bot
  label: string
  role: string
  model: string
  status: Status
  /** A few of what it can do: enabled toolsets, apps and skills. */
  strengths: string[]
  groups: string[]
}

const MAX_ROLE = 90
const MAX_STRENGTHS = 4

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * What Hermes's `message_agent` routes by for a private message: the profile name, with the
 * default profile as "hermes". This is NOT the bot's group @handle — a group addresses the
 * default profile as `@<handle>` (e.g. "@kacy"), so the two must never be used interchangeably.
 */
export const targetOf = (bot: Bot) => (bot.name === 'default' ? 'hermes' : bot.name)

/** What a bot writes after @ to address this bot in a group: its own handle. */
export const groupHandleOf = (bot: Bot) => bot.handle

const shortModel = (model: string) => model.split('/').pop() || model

function strengthsOf(name: string): string[] {
  const cfg = ownValue($botConfig.get(), name)

  if (!isLoaded(cfg)) {
    return []
  }

  const apps = cfg.mcp.filter(item => item.enabled && item.name !== GROUPS_SERVER).map(item => (item.name === THIS_PC_SERVER ? 'this PC' : item.name))
  const tools = cfg.toolsets.filter(item => item.enabled).map(item => item.label.toLowerCase())
  const skills = cfg.skills.filter(item => item.enabled).map(item => item.name)

  return [...apps, ...tools, ...skills].slice(0, MAX_STRENGTHS)
}

export function memberOf(bot: Bot, rooms: Room[], busy: Record<string, boolean>, online: boolean): TeamMember {
  const cfg = ownValue($botConfig.get(), bot.name)

  return {
    bot,
    label: String(bot.meta.label || '').trim(),
    role: oneLine(String(bot.meta.description || bot.row.description || ''), MAX_ROLE),
    model: shortModel((isLoaded(cfg) && cfg.model.model) || bot.row.model || ''),
    status: !online ? 'offline' : ownValue(busy, bot.name) ? 'busy' : 'idle',
    strengths: strengthsOf(bot.name),
    groups: rooms.filter(room => room.members.some(m => m.name === bot.name)).map(room => room.name)
  }
}

/** The user's local time, with its zone, e.g. "Wed 7 Oct 2026, 6:10 PM (Asia/Calcutta)". */
export function nowLine(date = new Date()) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const when = date.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

  return `${when} (${zone})`
}

function line(member: TeamMember) {
  const { bot } = member
  const bits = [
    `${bot.display} (@${groupHandleOf(bot)})`,
    bot.lead ? 'Lead' : '',
    member.label,
    member.model,
    member.status,
    member.strengths.length ? `good with ${member.strengths.join(', ')}` : '',
    member.groups.length ? `in ${member.groups.join(', ')}` : ''
  ].filter(Boolean)

  return `- ${bits.join(' · ')}${member.role ? ` — ${member.role}` : ''}`
}

/** Whether the bot has Hermes's memory toolset (assumed yes until its config is loaded). */
function canRemember(name: string) {
  const cfg = ownValue($botConfig.get(), name)
  const tool = isLoaded(cfg) ? cfg.toolsets.find(item => item.name === 'memory') : undefined

  return tool ? tool.enabled : true
}

/** Whether the bot has Hermes's cronjob toolset on. Unlike memory, unknown counts as no. */
function canSchedule(name: string) {
  const cfg = ownValue($botConfig.get(), name)

  return isLoaded(cfg) && cfg.toolsets.some(item => item.name === 'cronjob' && item.enabled)
}

/** Whether the bot has the app's own tools (group posts, profile edits): its config is loaded and the server is on. */
function hasAppTools(name: string) {
  const cfg = ownValue($botConfig.get(), name)

  return isLoaded(cfg) && cfg.mcp.some(item => item.name === GROUPS_SERVER && item.enabled)
}

/** Hermes's name for an MCP tool: `mcp__<server>__<tool>`, non-word characters as underscores. */
const appTool = (tool: string) => `mcp__${GROUPS_SERVER.replace(/[^A-Za-z0-9_]/g, '_')}__${tool}`
export const GROUP_POST_TOOL = appTool('post_to_group')
export const PROFILE_TOOL = appTool('update_profile')
export const REACT_TOOL = appTool('react_to_message')
export const ASK_TOOL = appTool('ask_user')
export const SECRET_TOOL = appTool('request_secret')
export const HELP_TOOL = appTool('request_user_help')
export const FILE_TOOL = appTool('send_file')
export const THREAD_TOOL = appTool('reply_in_thread')

export interface DirectoryInput {
  me: string
  bots: Bot[]
  rooms: Room[]
  busy: Record<string, boolean>
  /** What each busy bot's current turn is about. The app records it; a bot never writes it itself. */
  status?: Record<string, TurnStatus>
  online: boolean
  machine: string
  user: string
  /** Shared memory about the user, as bullet lines. */
  facts: string[]
  /** False when this bot's memory tool is known to be off. */
  canRemember: boolean
  /** The user's recent edits to this bot's own memory files, in the app. */
  memoryEdits: string[]
  /** True only when this bot's config is loaded and its Scheduled jobs (cronjob) toolset is on. */
  canSchedule: boolean
  /** True only when this bot's config is loaded and the app's own tools are on for it. */
  appTools: boolean
  /** The team's shared folder on the Hermes host (absolute), once the app has made sure it exists. */
  sharedFolder: string
  /**
   * Which kind of session this block is for. Tools are session-scoped: Hermes exposes
   * `message_agent` in a bot's own 1:1 Bot Chat, but not in a group's member session,
   * so the directory only offers the route that actually exists here.
   */
  scope?: 'dm' | 'group'
  /**
   * Profile names of the members of the group this session is running in. Only those can be
   * woken from here, so the actionable route list is filtered to exactly them — the scheduler
   * only ever dispatches `roomBots(room)` — while the rest stay in the roster for awareness.
   * Left out when the app cannot tell, which then advertises nobody as locally reachable.
   */
  groupMembers?: string[]
}

/** The stable part (no time, no status): what's resent only when it changes. */
export function directoryText(input: DirectoryInput): string {
  const members = input.bots.map(bot => memberOf(bot, input.rooms, {}, true))
  const them = !input.user || input.user === 'You' ? 'the user' : input.user
  const self = members.find(m => m.bot.name === input.me)
  const others = members.filter(m => m.bot.name !== input.me)
  const myRooms = input.rooms.filter(room => room.members.some(m => m.name === input.me))
  const inGroup = input.scope === 'group'
  /**
   * The scheduler only dispatches the members of this very room, so in a group only those are
   * routable. An unknown membership claims nothing rather than advertising the whole roster.
   */
  const here = inGroup ? new Set(input.groupMembers || []) : null
  const routable = others.filter(m => !here || here.has(m.bot.name))
  const elsewhere = others.filter(m => !routable.includes(m))
  /** Where each teammate is reached: the group handle, and the private target when it differs. */
  const reach = (bot: Bot) => {
    const handle = `@${groupHandleOf(bot)}`
    const target = targetOf(bot)

    if (target === groupHandleOf(bot)) {
      return `${handle}`
    }

    return inGroup ? `${handle} (there is no private message here)` : `${handle} in a group, private target "${target}"`
  }
  /**
   * A roster bot that is not in this room cannot be woken from here, whatever the roster says.
   * Say so plainly, and point at the routes that do exist — never one that does not.
   */
  const outsiderLine =
    inGroup && routable.length && elsewhere.length
      ? `Not in this group: ${elsewhere
          .map(m => `${m.bot.display} (@${groupHandleOf(m.bot)})`)
          .join(', ')}. ${input.groupMembers ? 'A @mention of them here reaches nobody, and you cannot post into a group you are not a member of' : 'This session cannot confirm which group it is in, so do not promise anyone a @mention from here'}. If the work needs one of them, name that in your answer and ask ${them} to take it to them in that bot's private Bot Chat, or to add them both to a group you share — do not claim to have reached them from here.`
      : ''

  const selfBits = self
    ? [
        inGroup
          ? `You are ${self.bot.display} (@${groupHandleOf(self.bot)} here)`
          : `You are ${self.bot.display} (@${groupHandleOf(self.bot)} in a group, private target "${targetOf(self.bot)}")`,
        self.bot.lead ? 'the Lead' : '',
        self.label ? `label "${self.label}"` : '',
        self.model ? `model ${self.model}` : '',
        `running on ${input.machine}`
      ].filter(Boolean)
    : []

  return [
    '[Team directory — from the NexurBots app]',
    selfBits.length ? `${selfBits.join(', ')}.${self?.role ? ` Your role: ${self.role}` : ''}` : '',
    input.appTools && self
      ? `If ${them} asks you to change your name, label or description, use ${PROFILE_TOOL}, only when they ask. Your Hermes profile stays the same.`
      : '',
    `The user is ${input.user}.`,
    others.length ? 'Teammates:' : 'No teammates yet.',
    ...others.map(m => line({ ...m, status: 'idle' }).replace(/ · idle/, '')),
    routable.length
      ? `Reach a teammate: ${routable.map(m => `${m.bot.display} — ${reach(m.bot)}`).join('; ')}. ${inGroup ? `In this group, writing @their handle in your reply is the only way to reach them — that is what starts their turn. Writing their plain name in prose reaches nobody, so never hand work over that way: @mention them and say the concrete ask, or keep the result to yourself. message_agent is not available in a group, so if a teammate must be reached privately, tell ${them} in your answer here and it can be sent from a 1:1 chat.` : `In a group, writing @their handle is what makes them answer; writing their plain name in prose reaches nobody. For a private message outside any group, use message_agent with their private target instead.`}`
      : inGroup && others.length
        ? input.groupMembers
          ? 'Nobody else is in this group, so there is no @mention route from here. Say what you found and stop; do not hand work to a teammate in prose.'
          : 'This session cannot confirm which bots share its group, so it offers no @mention route from here. Say what you found and stop; do not hand work to a teammate in prose.'
        : '',
    outsiderLine,
    myRooms.length
      ? `Your groups: ${myRooms.map(room => `${room.name} (${room.members.map(m => input.bots.find(b => b.name === m.name)?.display || m.name).join(', ')})`).join('; ')}.`
      : '',
    input.facts.length ? `What the team knows about ${them} (shared memory, every bot sees this):` : '',
    ...input.facts,
    input.canRemember
      ? `To remember something about ${them} for the whole team, save it with your memory tool (target "user"); the app shares it with every bot. Keep notes only you need in target "memory".`
      : // Hermes's profile snapshot reports the toolsets of its "cli" platform, which can differ from
        // the session's own tools, so "off" here isn't certain: never tell the bot its memory is off.
        `If your memory tool is available, save things worth remembering about ${them} with it (target "user"); if it isn't, suggest they add it under Shared memory in the app.`,
    input.memoryEdits.length
      ? `${them[0].toUpperCase()}${them.slice(1)} recently edited your saved memory in the app (your memory as shown at the start of this chat may be older): ${input.memoryEdits.join('; ')}.`
      : '',
    input.canSchedule
      ? `For routines (a task on a schedule or once, like "every weekday at 9am"), use cronjob_manage with deliver="bot-chat" so the result comes back to your chat with ${them}; they can see, pause and delete routines in the app.`
      : '',
    input.appTools && myRooms.length
      ? `To post into one of your groups from your 1:1 chat with ${them} (when they ask you to tell a group something), call ${GROUP_POST_TOOL} with the group's exact name: ${myRooms.map(room => `"${room.name}"`).join(', ')}. It posts as you, and teammates you @mention in it answer in that group. Inside a group chat just reply normally.`
      : '',
    input.sharedFolder
      ? `Shared folder: ${input.sharedFolder} on the Hermes machine. Every bot can read and write files there, and ${them} can see them in the app. Put files you make for others there and give their full path.`
      : '',
    input.appTools
      ? `Reactions: each message from ${them} comes with an id ("Message id: u…" in your 1:1 chat, [g…] before each line in a group). To react with one emoji, call ${REACT_TOOL} with that message_id; the same emoji again removes it. For a simple "thanks" or "ok", a reaction can be your whole reply: react, then end your turn without writing anything (in a group reply exactly (pass)). When ${them} reacts to one of your messages you get a short note; you don't need to answer it.`
      : '',
    input.appTools
      ? `When you need ${them} to choose between a few options (confirm, pick one), call ${ASK_TOOL} so they can click instead of typing, then end your turn: their answer comes as their next message.`
      : '',
    input.appTools
      ? `If you need an API key, token or password from ${them}, call ${SECRET_TOOL} (they type it into a masked card; it goes to your profile's .env) and end your turn. Never ask them to paste secrets into chat.`
      : '',
    input.appTools
      ? `If you hit a login, 2FA, captcha or anything only ${them} can do on your computer, leave the screen at that step, call ${HELP_TOOL} with one sentence of instructions, and end your turn until they hand it back.`
      : '',
    input.appTools
      ? `To keep a long digest or details about one message out of the main chat, call ${THREAD_TOOL} with that message's id (or ${GROUP_POST_TOOL} with reply_to in a group). Messages marked "(in thread on …)" or "[In thread on message …]" are thread replies; your reply to them lands in that thread.`
      : '',
    input.appTools
      ? `To give ${them} a file they asked for (chart, image, PDF, spreadsheet…), call ${FILE_TOOL} with its full path. It shows in the chat you are answering in. Do not use it to drop logs, test output, or handoff notes into the 1:1 chat.`
      : '',
    'Your 1:1 chat with the user is private: teammates never see it, so pass on only what they need.',
    others.length && !inGroup
      ? `To hand work to a teammate privately, call message_agent with their private target. Say one concrete ask: what to do, what you already tried, and what a reply should contain${input.sharedFolder ? ` (put the files in ${input.sharedFolder} and give the full path)` : ''}. It does not block: keep working, and the reply arrives later — a queued message is not a delivered one, so don't assume they have seen it.`
      : '',
    others.length && inGroup && routable.length
      ? `If you do hand work to a teammate here, @mention them and give the task${input.sharedFolder ? `, the full path of any file you wrote in ${input.sharedFolder}, and what a reply should contain` : ' and what a reply should contain'}. A queued turn is not a finished one, so don't assume they have seen it.`
      : '',
    others.length
      ? `Don't trade acknowledgements with a teammate: no "thanks", "got it", or "on it" just to answer one. Hand over work or a result, not a receipt, so two bots can't ping-pong.`
      : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** The per-turn part: the time and who is busy right now, and what they are working on. One short line. */
export function liveLine(input: DirectoryInput): string {
  const busy = input.bots
    .filter(bot => bot.name !== input.me && ownValue(input.busy, bot.name))
    .map(bot => {
      const turn = input.status ? ownValue(input.status, bot.name) : undefined

      return turn ? `${bot.display} (${statusLine(turn)})` : bot.display
    })
  const status = !input.online ? 'Teammates may be offline.' : busy.length ? `Busy right now: ${busy.join('; ')}.` : 'All teammates are idle.'

  // message_agent exists only in a 1:1 chat; a group reaches teammates by @mention.
  const reach =
    input.scope === 'group'
      ? 'In this group, reach a teammate by @mentioning them in your reply. A plain name reaches nobody.'
      : 'An @mention in your 1:1 chat reaches nobody. Do not write @teammate there, and do not attach logs there unless the user asked for that file. Use message_agent to reach a teammate.'

  return `[Now: ${nowLine()}. ${status}] ${reach}`
}

// ── per-session dedupe ─────────────────────────────────────────────────────
const sentKey = (session: string) => `team:${session}`

function hash(text: string) {
  let h = 5381

  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }

  return (h >>> 0).toString(36)
}

// rooms.ts imports chat.ts, so it registers its rooms here rather than being imported.
let roomsSource: () => Room[] = () => []

export function setRoomsSource(source: () => Room[]) {
  roomsSource = source
}

export const allRooms = () => roomsSource()

/** Live state the directory reads from. `scope` decides which routes this session can offer. */
export function directoryInput(me: string, scope: 'dm' | 'group' = 'dm'): DirectoryInput {
  return {
    me,
    bots: $allBots.get().filter(bot => !bot.meta.hidden),
    rooms: roomsSource(),
    busy: $busy.get(),
    status: $turnStatus.get(),
    online: isHostOnline(hostOf(me)),
    // A bot on an added machine (hosts.ts) runs there; the shared folder is on the main machine only.
    machine: (hostOf(me) ? machineLabel(hostOf(me)) : $active.get()?.label) || 'your Hermes server',
    user: $userName.get(),
    facts: sharedFactLines($sharedFacts.get()),
    canRemember: canRemember(me),
    memoryEdits: ownValue($memoryEdits.get(), me) || [],
    canSchedule: canSchedule(me),
    appTools: hasAppTools(me),
    sharedFolder: $sharedFolder.get().ready && !hostOf(me) ? $sharedFolder.get().path : '',
    scope
  }
}

/**
 * The context block for one turn of `session`: the full directory the first time and whenever
 * it changed since that session last saw it, otherwise just the live line.
 */
export function teamContext(session: string, input: DirectoryInput): string {
  const directory = directoryText(input)
  const digest = hash(directory)
  let fresh = true

  try {
    fresh = localStorage.getItem(sentKey(session)) !== digest

    if (fresh) {
      localStorage.setItem(sentKey(session), digest)
    }
  } catch {
    /* send it */
  }

  return [fresh ? directory : '', liveLine(input)].filter(Boolean).join('\n')
}

/** Forget what a session was sent, e.g. after its history was compressed or reset. */
export function resendDirectory(session: string) {
  try {
    localStorage.removeItem(sentKey(session))
  } catch {
    /* fine */
  }
}

// ── 1:1 prompts carry the block in a fence the chat view strips back out ───
export const CONTEXT_OPEN = '<hermes-bots-context>'
export const CONTEXT_CLOSE = '</hermes-bots-context>'

export const wrapContext = (context: string, text: string) => (context ? `${CONTEXT_OPEN}\n${context}\n${CONTEXT_CLOSE}\n\n${text}` : text)

export function stripContext(text: string) {
  const start = text.indexOf(CONTEXT_OPEN)

  if (start !== 0) {
    return text
  }

  const end = text.indexOf(CONTEXT_CLOSE)

  return end < 0 ? text : text.slice(end + CONTEXT_CLOSE.length).replace(/^\s+/, '')
}

/** Loads every bot's setup once so the directory and Team view can show models and strengths. */
export function warmTeam() {
  for (const bot of $allBots.get()) {
    void loadBotConfig(bot.name)
  }
}

export const $teamOnline = computed(gateway.state, state => state === 'open')
