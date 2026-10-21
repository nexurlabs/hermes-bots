/**
 * A bot changing its own name, label or description when the user asks. Through the app's tool
 * server (`get_profile` / `update_profile`, see app-tools.ts), always for the calling bot only, and
 * through the same `updateBot` the Edit bot sheet and the label field use, so the roster, the
 * Team view and every bot's team directory pick the change up.
 *
 * The bot's Hermes profile id (its folder, and its `message_agent` target) never changes: the name
 * is the app's display name (`ui_meta['hermes-bots'].title`).
 */
import { atom } from 'nanostores'

import { $chats } from './chat'
import { isMemberTypingInRoom } from './rooms'
import { $allBots, handleOf, slugify, updateBot } from './store'

export const NAME_MAX = 40
export const LABEL_MAX = 40
export const DESCRIPTION_MAX = 200
const CHANGES_PER_10_MIN = 3
const NOTES_KEY = 'self-edits'
const MAX_NOTES = 30

/** A line in the bot's 1:1 chat saying what it changed. */
export interface SelfEditNote {
  id: string
  at: number
  text: string
}

function loadNotes(): Record<string, SelfEditNote[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTES_KEY) || '{}')

    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export const $selfEditNotes = atom<Record<string, SelfEditNote[]>>(typeof localStorage === 'undefined' ? {} : loadNotes())

function addNote(bot: string, text: string) {
  const note = { id: `se${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), text }
  const all = { ...$selfEditNotes.get(), [bot]: [...($selfEditNotes.get()[bot] || []), note].slice(-MAX_NOTES) }
  $selfEditNotes.set(all)

  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(all))
  } catch {
    /* the line still shows until the app restarts */
  }
}

/** Design preview: sample lines, not saved. */
export function seedSelfEditNotes(notes: Record<string, SelfEditNote[]>) {
  $selfEditNotes.set(notes)
}

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()
const recent: { bot: string; at: number }[] = []

/** `get_profile`: what the bot is called in the app, and what it may change. */
export function profileText(member: string): { ok: boolean; text: string } {
  const bot = $allBots.get().find(b => b.name === member)

  if (!bot) {
    return { ok: false, text: 'This bot is not in the NexurBots app.' }
  }

  return {
    ok: true,
    text: [
      'Your profile in the NexurBots app:',
      `- name: ${bot.display} (teammates @mention you as @${bot.handle})`,
      `- label: ${String(bot.meta.label || '').trim() || '(none)'}`,
      `- description: ${String(bot.meta.description || bot.row.description || '').trim() || '(none)'}`,
      `- profile id: ${bot.name} (your Hermes profile; it can't be changed)`,
      `Only when the user asks, change these with update_profile. The limits are: name 1-${NAME_MAX} characters and not used by a teammate, label up to ${LABEL_MAX} characters (empty removes it), description up to ${DESCRIPTION_MAX} characters.`
    ].join('\n')
  }
}

const fail = (text: string) => ({ ok: false, text })

/** `update_profile`: changes the calling bot's own name, label and/or description. */
export async function updateOwnProfile(member: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const bot = $allBots.get().find(b => b.name === member)

  if (!bot) {
    return fail('This bot is not in the NexurBots app.')
  }

  // The user has to ask, so it must be answering them in its 1:1 chat right now, not a teammate or a group.
  const inRoom = isMemberTypingInRoom(member)

  if (inRoom || !$chats.get()[member]?.running) {
    return fail("Profile changes only work while you're answering the user in your 1:1 chat, when they asked for the change.")
  }

  const given = (key: string) => (typeof args[key] === 'string' ? oneLine(args[key] as string) : args[key] === null ? '' : undefined)
  const name = given('name')
  const label = given('label')
  const description = given('description')

  if (name === undefined && label === undefined && description === undefined) {
    return fail('Nothing to change. Give name, label or description.')
  }

  if (name !== undefined) {
    if (!name) {
      return fail("Your name can't be empty.")
    }

    if (name.length > NAME_MAX) {
      return fail(`That name is too long (${name.length} characters, the limit is ${NAME_MAX}).`)
    }

    if (!/[\p{L}\p{N}]/u.test(name) || name.includes('@')) {
      return fail('A name needs at least one letter or number, and no @.')
    }

    if (['everyone', 'all', 'team'].includes(slugify(name))) {
      return fail(`"${name}" is how the user @mentions the whole group, so it can't be a name.`)
    }

    const lower = name.toLowerCase()
    // Only the default profile's @handle follows its name; the others keep their profile id.
    const handle = bot.name === 'default' ? handleOf(bot.name, name) : ''
    const taken = $allBots
      .get()
      .filter(other => other.name !== bot.name)
      .find(other => [other.display, other.name, other.handle].some(value => value.toLowerCase() === lower || (handle && value.toLowerCase() === handle)))

    if (taken) {
      return fail(`${taken.display} (@${taken.handle}) already goes by that name. Pick another one.`)
    }
  }

  if (label !== undefined && label.length > LABEL_MAX) {
    return fail(`That label is too long (${label.length} characters, the limit is ${LABEL_MAX}).`)
  }

  if (description !== undefined && description.length > DESCRIPTION_MAX) {
    return fail(`That description is too long (${description.length} characters, the limit is ${DESCRIPTION_MAX}).`)
  }

  const was = {
    name: bot.display,
    label: String(bot.meta.label || '').trim(),
    description: String(bot.meta.description || bot.row.description || '').trim()
  }
  const change = {
    ...(name !== undefined && name !== was.name ? { display: name } : {}),
    ...(label !== undefined && label !== was.label ? { label } : {}),
    ...(description !== undefined && description !== was.description ? { description } : {})
  }

  if (!Object.keys(change).length) {
    return { ok: true, text: 'Nothing changed: that is already your profile.' }
  }

  const now = Date.now()

  while (recent.length && now - recent[0].at > 10 * 60_000) {
    recent.shift()
  }

  if (recent.filter(item => item.bot === member).length >= CHANGES_PER_10_MIN) {
    return fail('You changed your profile several times in the last few minutes. Wait a while before changing it again.')
  }

  recent.push({ bot: member, at: now })
  await updateBot(member, change)

  const changed = [change.display !== undefined ? `its name to ${change.display}` : '', change.label ? `its label to ${change.label}` : ''].filter(Boolean)
  const clauses = [
    changed.length ? `changed ${changed.join(' and ')}` : '',
    change.label === '' ? 'removed its label' : '',
    change.description !== undefined ? 'updated its description' : ''
  ].filter(Boolean)
  const said = clauses.length > 1 ? `${clauses.slice(0, -1).join(', ')} and ${clauses.at(-1)}` : clauses[0]
  addNote(member, `${was.name} ${said}`)

  const handle = handleOf(bot.name, change.display ?? was.name)

  return {
    ok: true,
    text: `Done. ${[
      change.display !== undefined ? `You're now called ${change.display}${handle !== bot.handle ? `, and teammates @mention you as @${handle}` : ''}.` : '',
      change.label !== undefined ? (change.label ? `Your label is now "${change.label}".` : 'Your label is removed.') : '',
      change.description !== undefined ? 'Your description is updated.' : ''
    ]
      .filter(Boolean)
      .join(' ')} The user sees a note about it in your chat, and teammates see the change with their next message.`
  }
}
