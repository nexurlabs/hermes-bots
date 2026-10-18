/** `send_voice_memo` from a bot: Hermes TTS with its profile, saved to the shared folder, posted as a voice bubble. */
import { postBotFile } from './file-actions'
import { ensureSharedFolder, sharedPath } from './shared-folder'
import { native } from './native'
import { hostHttp, splitBot } from './hosts'
import { $active } from './store'
import { synthesize } from './voice'

type Answer = { ok: boolean; text: string }

const MAX_MEMO_CHARS = 4000

export async function botSendVoiceMemo(profile: string, args: Record<string, unknown>): Promise<Answer> {
  const text = String(args.text ?? '').trim()

  if (!text) {
    return { ok: false, text: 'text is required: what to say.' }
  }

  if (text.length > MAX_MEMO_CHARS) {
    return { ok: false, text: `That's ${text.length} characters; a voice memo can be at most ${MAX_MEMO_CHARS}. Say less, or send the rest as text.` }
  }

  let audio: Awaited<ReturnType<typeof synthesize>>

  try {
    audio = await synthesize(profile, text)
  } catch (error) {
    return { ok: false, text: `Hermes couldn't make the audio: ${(error as Error).message}. Check tts in your config (Edge TTS needs no key), or reply in text.` }
  }

  const ext = /ogg/.test(audio.mime) ? 'ogg' : /wav/.test(audio.mime) ? 'wav' : /flac/.test(audio.mime) ? 'flac' : 'mp3'
  // The plain profile name: a `@host` in the path would send the upload to that machine (hosts.ts).
  const name = `voice-memo-${splitBot(profile).profile}-${Date.now().toString(36)}.${ext}`
  const active = $active.get()

  if (!active) {
    return { ok: false, text: 'The app is not connected to Hermes.' }
  }

  let path: string

  try {
    path = sharedPath(await ensureSharedFolder(), 'voice-memos', name)
    const res = await hostHttp({ baseUrl: active.baseUrl, token: active.token, method: 'POST', path: 'api/files/upload', body: { path, data_url: audio.dataUrl, overwrite: true }, timeoutMs: 2 * 60_000 })

    if (!res.ok) {
      throw new Error(String(res.json?.detail || res.text || `Hermes answered ${res.status}`))
    }

    path = String(res.json?.path || path)
  } catch (error) {
    return { ok: false, text: `Couldn't store the voice memo: ${(error as Error).message}` }
  }

  const size = Math.round(((audio.dataUrl.length - audio.dataUrl.indexOf(',') - 1) * 3) / 4)
  const room = postBotFile(profile, { path, name, size, mime: audio.mime, voice: true }, text)

  return {
    ok: true,
    text: `Sent a voice memo${room ? ` in "${room.name}"` : ''}${audio.provider ? ` (Hermes TTS: ${audio.provider})` : ''}; the user sees your text under it. Don't repeat the text. If that's all, end your turn${room ? ' (or reply (pass))' : ''}.`
  }
}
