/** `send_file` from a bot: check the file, then post it in the group it's answering in or its 1:1 chat. */
import { hostOf } from './hosts'
import { addFilePost, baseName, cleanFileName, MAX_SEND_BYTES, pathProblem, statHermesFile } from './bot-files'
import { humanSize } from './attachments'
import { $chats, newId } from './chat'
import { addRoomFilePost, roomInTurn } from './rooms'
import type { BotFile } from './types'

type Answer = { ok: boolean; text: string }

export async function botSendFile(profile: string, args: Record<string, unknown>): Promise<Answer> {
  const path = String(args.path ?? '').trim()
  const problem = pathProblem(path)

  if (problem) {
    return { ok: false, text: problem }
  }

  let stat: { size: number; mime?: string }

  try {
    stat = await statHermesFile(path, profile)
  } catch (error) {
    return { ok: false, text: `Can't send ${path}: ${(error as Error).message}` }
  }

  if (stat.size > MAX_SEND_BYTES) {
    return { ok: false, text: `${baseName(path)} is ${humanSize(stat.size)}; the limit is ${humanSize(MAX_SEND_BYTES)}. Compress or split it.` }
  }

  const name = cleanFileName(String(args.filename ?? '')) || baseName(path)
  const caption = String(args.caption ?? '').trim().slice(0, 4000)
  const room = roomInTurn(profile)
  const asked = [...($chats.get()[profile]?.messages || [])].reverse().find(msg => msg.role === 'user')?.text.trim() || ''
  const fromTeammate = /^message from\b/i.test(asked)
  const logDump = /\.log$/i.test(name) || /investigation|test-output/i.test(name)

  // A teammate ping lands in this bot's 1:1, which the user also sees. Logs and
  // handoff files do not belong there, and an @mention in that chat wakes nobody.
  if (!room && (fromTeammate || (logDump && !/\blog\b/i.test(asked)))) {
    return {
      ok: false,
      text: `Not sent. ${name} would show up in the user's private chat, and they did not ask for it. An @mention in that chat reaches nobody. Put the file in the shared folder and use message_agent if a teammate needs the path.`
    }
  }

  const host = hostOf(profile)
  const file: BotFile = { path, name, size: stat.size, ...(stat.mime ? { mime: stat.mime } : {}), ...(host ? { host } : {}) }
  postBotFile(profile, file, caption)

  return {
    ok: true,
    text: `Sent ${name} (${humanSize(stat.size)}) to the user${room ? ` in "${room.name}"` : ''}; it shows as an attachment${caption ? ' with your caption' : ''}. Don't paste its contents too. If that's all you had to say, end your turn without more text${room ? ' (or reply (pass))' : ''}.`
  }
}

/** Posts one file from a bot where it's answering (its group turn, else its 1:1 chat, in the thread it's in). */
export function postBotFile(profile: string, file: BotFile, caption: string) {
  const post = { id: newId('f'), at: Date.now(), ...(caption ? { caption } : {}), files: [file] }
  const room = roomInTurn(profile)

  if (room) {
    addRoomFilePost(room.key, profile, post)
  } else {
    // Answering a thread message: the file goes into that thread.
    const lastUser = [...($chats.get()[profile]?.messages || [])].reverse().find(msg => msg.role === 'user')
    addFilePost(`bot:${profile}`, lastUser?.thread ? { ...post, thread: lastUser.thread } : post)
  }

  return room
}
