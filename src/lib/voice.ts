/**
 * Voice: voice notes from the user, spoken replies from bots, and "Read aloud".
 *
 * Both directions use Hermes's own voice pipeline (the one the Hermes desktop app and the
 * Telegram/Discord voice memos use), through its dashboard API and with the bot's profile, so its
 * configured providers apply:
 *  - `POST /api/audio/transcribe` (`{ data_url, mime_type }` → `{ transcript, provider }`), the
 *    `stt.*` providers: local faster-whisper, whisper.cpp, OpenAI, Groq, Mistral, xAI, a command.
 *  - `POST /api/audio/speak` (`{ text }` → `{ data_url, mime_type, provider }`), `tts.*`:
 *    Edge TTS (free, the default), ElevenLabs, OpenAI, NeuTTS, a command...
 *
 * A voice note is sent as an audio attachment named `voice-note-….webm` plus the transcript as the
 * message text, after a marker line so the bot knows it was spoken. If Hermes can't transcribe, the
 * note still goes with the audio attached and the marker says so, so the bot can use its own tools.
 *
 * "Read aloud" is zero-config: the OS voices through the Web Speech API (speechSynthesis).
 */
import { atom } from 'nanostores'

import { native } from './native'
import { hostHttp } from './hosts'
import { $active } from './store'

export const VOICE_MARK = '[Voice note, transcribed]'
export const VOICE_MARK_RAW = '[Voice note, not transcribed]'
export const VOICE_NOTE_NAME = /^voice-note-[\w-]+\.(webm|ogg|m4a|mp4|mp3|wav)$/i
export const MAX_RECORD_SECONDS = 5 * 60

const MIC_KEY = 'hb.voice.mic'
const READ_KEY = 'hb.voice.read'

const stored = (key: string) => {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

const keep = (key: string, value: string) => {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* private mode */
  }
}

/** The microphone to record with (a MediaDeviceInfo id; empty is the system default). */
export const $micDevice = atom(stored(MIC_KEY))
$micDevice.listen(value => keep(MIC_KEY, value))

/** The OS voice "Read aloud" uses (a SpeechSynthesisVoice voiceURI; empty is the default). */
export const $readVoice = atom(stored(READ_KEY))
$readVoice.listen(value => keep(READ_KEY, value))

let preview = false
export const setVoicePreview = (on: boolean) => {
  preview = on
}

// ── voice notes ───────────────────────────────────────────────────────────
/** The text a voice note is sent with, and how it reads back. */
export const voiceNoteText = (transcript: string, error = '') =>
  transcript ? `${VOICE_MARK}\n${transcript}` : `${VOICE_MARK_RAW}\n(${error || 'No speech was recognised'}. The recording is attached; transcribe it with your own tools if you can.)`

export function splitVoiceText(text: string): null | { transcript: string; transcribed: boolean } {
  for (const [mark, transcribed] of [
    [VOICE_MARK, true],
    [VOICE_MARK_RAW, false]
  ] as const) {
    const at = text.indexOf(mark)

    if (at >= 0 && !text.slice(0, at).trim().replace(/^>.*$/gm, '').trim()) {
      return { transcript: text.slice(at + mark.length).trim(), transcribed }
    }
  }

  return null
}

export const voiceNoteName = (mime: string) => `voice-note-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${/ogg/.test(mime) ? 'ogg' : /mp4|m4a|aac/.test(mime) ? 'm4a' : 'webm'}`

/** What MediaRecorder can make here, best first (Hermes accepts all of these). */
export function recorderMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']

  return options.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(type)) || ''
}

async function call(method: string, path: string, body: unknown, timeoutMs: number) {
  const active = $active.get()

  if (!active) {
    throw new Error('Not connected to Hermes')
  }

  const res = await hostHttp({ baseUrl: active.baseUrl, token: active.token, method, path, body, timeoutMs })

  if (res.status === 404 && /not found/i.test(String(res.json?.detail || res.text || 'not found'))) {
    throw new Error('This Hermes is too old for voice (no /api/audio). Update Hermes')
  }

  if (!res.ok) {
    throw new Error(String(res.json?.detail || res.text || `Hermes answered ${res.status}`))
  }

  return res.json as any
}

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

/** Hermes STT with the bot's profile (its configured `stt` provider). */
export async function transcribe(profile: string, blob: Blob): Promise<{ transcript: string; provider?: string }> {
  if (preview) {
    await new Promise(resolve => setTimeout(resolve, 900))

    return { transcript: 'Can you check why the deploy failed last night and tell me if it is safe to retry?', provider: 'local' }
  }

  const mime = (blob.type || 'audio/webm').split(';')[0]
  const json = await call('POST', `api/audio/transcribe?profile=${encodeURIComponent(profile)}`, { data_url: await blobToDataUrl(blob), mime_type: mime }, 5 * 60_000)

  return { transcript: String(json?.transcript || '').trim(), provider: json?.provider ? String(json.provider) : undefined }
}

/** Hermes TTS with the bot's profile (its configured `tts` provider); a data URL. */
export async function synthesize(profile: string, text: string): Promise<{ dataUrl: string; mime: string; provider?: string }> {
  const json = await call('POST', `api/audio/speak?profile=${encodeURIComponent(profile)}`, { text }, 3 * 60_000)
  const dataUrl = String(json?.data_url || '')

  if (!dataUrl.startsWith('data:')) {
    throw new Error('Hermes returned no audio')
  }

  return { dataUrl, mime: String(json?.mime_type || 'audio/mpeg'), provider: json?.provider ? String(json.provider) : undefined }
}

// ── read aloud ────────────────────────────────────────────────────────────
/** Which message is being read aloud right now. */
export const $speaking = atom('')

export const canReadAloud = () => typeof window !== 'undefined' && 'speechSynthesis' in window

/** Markdown to something worth hearing: no code blocks, links read as their text. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\s+/g, ' ')
    .trim()
}

export function voices(): SpeechSynthesisVoice[] {
  return canReadAloud() ? window.speechSynthesis.getVoices() : []
}

/** Reads a message with the OS voice; calling it again for the same message stops. */
export function readAloud(id: string, text: string) {
  if (!canReadAloud()) {
    return
  }

  const synth = window.speechSynthesis
  const again = $speaking.get() === id
  synth.cancel()
  $speaking.set('')

  if (again) {
    return
  }

  const utter = new SpeechSynthesisUtterance(speakable(text).slice(0, 12_000))
  const chosen = voices().find(voice => voice.voiceURI === $readVoice.get())

  if (chosen) {
    utter.voice = chosen
    utter.lang = chosen.lang
  }

  utter.onend = utter.onerror = () => {
    if ($speaking.get() === id) $speaking.set('')
  }
  $speaking.set(id)
  synth.speak(utter)
}

export function sampleVoice(uri: string) {
  if (!canReadAloud()) return
  window.speechSynthesis.cancel()
  const utter = new SpeechSynthesisUtterance('Hi, this is how I sound when I read a message aloud.')
  const chosen = voices().find(voice => voice.voiceURI === uri)
  if (chosen) utter.voice = chosen
  window.speechSynthesis.speak(utter)
}

export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
