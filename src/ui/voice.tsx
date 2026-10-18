/**
 * Voice UI: the composer's mic (record → transcribe → send), voice bubbles with play/scrub, the
 * per-message Read aloud button, and the Voice settings (mic and read-aloud voice).
 */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useMemo, useRef, useState } from 'react'

import { blobOf, makePending, type Pending } from '../lib/attachments'
import { fetchBotFile } from '../lib/bot-files'
import { toast } from '../lib/store'
import type { BotFile, MsgAttachment } from '../lib/types'
import {
  $micDevice,
  $readVoice,
  $speaking,
  canReadAloud,
  clock,
  MAX_RECORD_SECONDS,
  readAloud,
  recorderMime,
  sampleVoice,
  transcribe,
  voiceNoteName,
  voiceNoteText,
  voices
} from '../lib/voice'
import { Icon } from './icons'

/** Demo: shows the recorder mid-recording without a microphone. */
export const $recorderDemo = atom(false)

const BARS = 40

type Phase = 'idle' | 'recording' | 'transcribing'

/** The mic button; while recording it covers the composer with timer, live waveform and cancel/send. */
export function MicButton({ profile, disabled, onSend }: { profile: string; disabled?: boolean; onSend: (text: string, files: Pending[]) => void }) {
  const demo = useStore($recorderDemo)
  const device = useStore($micDevice)
  const [phase, setPhase] = useState<Phase>('idle')
  const [seconds, setSeconds] = useState(0)
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0.06))
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; ctx: AudioContext; chunks: Blob[]; started: number; raf: number; cancel: boolean } | null>(null)
  const hold = useRef<{ timer: number; held: boolean } | null>(null)

  useEffect(() => {
    if (!demo) return
    setPhase('recording')
    setSeconds(7)
    setLevels(Array.from({ length: BARS }, (_, i) => 0.15 + 0.75 * Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.17))))
  }, [demo])

  useEffect(() => () => stopAll(true), [])

  const stopAll = (cancel: boolean) => {
    const r = rec.current

    if (!r) return
    r.cancel = cancel
    cancelAnimationFrame(r.raf)
    if (r.recorder.state !== 'inactive') r.recorder.stop()
    r.stream.getTracks().forEach(track => track.stop())
    void r.ctx.close().catch(() => undefined)
  }

  const start = async () => {
    if (phase !== 'idle' || disabled) return

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast("This app can't record audio here.", 'bad')

      return
    }

    let stream: MediaStream

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: device ? { deviceId: { exact: device } } : true })
    } catch (error) {
      const name = (error as DOMException)?.name

      if (device && name === 'OverconstrainedError') {
        $micDevice.set('')
        toast('That microphone is gone; using the default one. Try again.', 'bad')
      } else {
        toast(name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your system privacy settings.' : `No microphone: ${(error as Error).message || name}`, 'bad')
      }

      return
    }

    const mimeType = recorderMime()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(analyser)
    const data = new Uint8Array(analyser.fftSize)
    const r = { recorder, stream, ctx, chunks: [] as Blob[], started: Date.now(), raf: 0, cancel: false }
    rec.current = r
    let lastPush = 0
    const history: number[] = Array(BARS).fill(0.06)

    const tick = () => {
      analyser.getByteTimeDomainData(data)
      let peak = 0
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128)
      const now = Date.now()

      if (now - lastPush > 80) {
        lastPush = now
        history.push(Math.max(0.06, Math.min(1, peak * 1.8)))
        history.shift()
        setLevels([...history])
        const s = (now - r.started) / 1000
        setSeconds(s)
        if (s >= MAX_RECORD_SECONDS) return void finish()
      }
      r.raf = requestAnimationFrame(tick)
    }

    recorder.ondataavailable = event => event.data.size && r.chunks.push(event.data)
    recorder.onstop = () => void done(r, recorder.mimeType || mimeType || 'audio/webm')
    recorder.start(250)
    setSeconds(0)
    setPhase('recording')
    r.raf = requestAnimationFrame(tick)
  }

  const done = async (r: NonNullable<typeof rec.current>, mime: string) => {
    rec.current = null

    if (r.cancel) {
      setPhase('idle')

      return
    }

    const length = (Date.now() - r.started) / 1000

    if (length < 0.7) {
      setPhase('idle')
      toast('Too short. Hold the mic, or click it to start and again to send.', 'bad')

      return
    }

    const blob = new Blob(r.chunks, { type: mime })
    const made = await makePending(new File([blob], voiceNoteName(mime), { type: mime.split(';')[0] }))

    if ('error' in made) {
      setPhase('idle')
      toast(made.error, 'bad')

      return
    }

    setPhase('transcribing')

    try {
      const { transcript } = await transcribe(profile, blob)
      onSend(voiceNoteText(transcript, transcript ? '' : 'Hermes heard no speech'), [made.pending])
    } catch (error) {
      const why = (error as Error).message || String(error)
      toast(`Sent the recording without a transcript: ${why}`, 'bad')
      onSend(voiceNoteText('', `Hermes couldn't transcribe it here (${why})`), [made.pending])
    } finally {
      setPhase('idle')
    }
  }

  const finish = () => {
    if (demo) {
      $recorderDemo.set(false)
      setPhase('idle')

      return
    }
    stopAll(false)
  }

  const cancel = () => {
    if (demo) {
      $recorderDemo.set(false)
      setPhase('idle')

      return
    }
    stopAll(true)
  }

  useEffect(() => {
    if (phase !== 'recording') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        finish()
      }
    }
    window.addEventListener('keydown', onKey, true)

    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase])

  return (
    <>
      <button
        aria-label="Record a voice note"
        className="composer-mic"
        data-on={phase !== 'idle' || undefined}
        disabled={disabled || phase === 'transcribing'}
        onPointerDown={event => {
          if (event.button !== 0 || phase !== 'idle') return
          // Hold to talk: released after 350 ms sends; a quick click toggles recording instead.
          hold.current = { held: false, timer: window.setTimeout(() => hold.current && (hold.current.held = true), 350) }
          void start()
        }}
        onPointerUp={() => {
          const h = hold.current
          hold.current = null
          if (h) clearTimeout(h.timer)
          if (h?.held) finish()
        }}
        title="Voice note: hold to talk, or click to start and stop"
        type="button"
      >
        {phase === 'transcribing' ? <span className="spinner xs" /> : <Icon name="mic" size={16} />}
      </button>
      {phase !== 'idle' ? (
        <div className="voice-rec" data-phase={phase} role="status">
          <button aria-label="Cancel recording" className="icon-btn sm ghost" disabled={phase === 'transcribing'} onClick={cancel} title="Cancel (Esc)" type="button">
            <Icon name="close" size={15} />
          </button>
          <span className="rec-dot" />
          <span className="rec-time">{clock(seconds)}</span>
          <span className="rec-wave" aria-hidden>
            {levels.map((level, i) => (
              <i key={i} style={{ height: `${Math.round(level * 100)}%` }} />
            ))}
          </span>
          {phase === 'transcribing' ? (
            <span className="rec-note">
              <span className="spinner xs" /> Transcribing…
            </span>
          ) : (
            <span className="rec-note">{hold.current ? 'Release to send' : 'Enter to send'}</span>
          )}
          <button aria-label="Send voice note" className="composer-send" disabled={phase === 'transcribing'} onClick={finish} title="Stop and send" type="button">
            <Icon name="arrow-up" size={17} />
          </button>
        </div>
      ) : null}
    </>
  )
}

// ── playing ───────────────────────────────────────────────────────────────
/** Stable bar heights from a name, so a clip looks the same every time. */
function shape(seed: string, count = 36) {
  let h = 2166136261

  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)

  return Array.from({ length: count }, (_, i) => {
    h = Math.imul(h ^ (h >>> 13), 1274126177) + i
    const r = ((h >>> 0) % 1000) / 1000

    return 0.22 + 0.78 * r * (0.55 + 0.45 * Math.sin((i / count) * Math.PI))
  })
}

/** A voice bubble: play/pause, a waveform you can click or drag to scrub, and the time. */
export function VoiceClip({ load, seed, seconds: known, mine, eager }: { load: () => Promise<string>; seed: string; seconds?: number; mine?: boolean; eager?: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const wave = useRef<HTMLSpanElement | null>(null)
  const [src, setSrc] = useState('')
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(known || 0)
  const bars = useMemo(() => shape(seed), [seed])

  const ensure = async () => {
    if (src) return src
    setBusy(true)
    try {
      const url = await load()
      setSrc(url)

      return url
    } catch (error) {
      toast(`Can't play it: ${(error as Error).message || error}`, 'bad')

      return ''
    } finally {
      setBusy(false)
    }
  }

  const toggle = async () => {
    const el = audio.current

    if (!el) return
    if (playing) return el.pause()
    if (!(await ensure())) return
    await new Promise(resolve => setTimeout(resolve, 0))
    void el.play().catch(() => undefined)
  }

  const seek = async (clientX: number) => {
    const box = wave.current?.getBoundingClientRect()
    const el = audio.current

    if (!box || !el) return
    if (!(await ensure())) return
    const at = Math.max(0, Math.min(1, (clientX - box.left) / box.width))
    const go = () => {
      if (Number.isFinite(el.duration)) el.currentTime = at * el.duration
    }
    if (el.readyState >= 1) go()
    else el.addEventListener('loadedmetadata', go, { once: true })
  }

  useEffect(() => {
    if (eager) void load().then(setSrc).catch(() => undefined)
  }, [eager, seed])

  const progress = length ? Math.min(1, time / length) : 0

  return (
    <div className="voice-clip" data-mine={mine || undefined}>
      <button aria-label={playing ? 'Pause' : 'Play'} className="voice-play" onClick={() => void toggle()} type="button">
        {busy ? <span className="spinner xs" /> : playing ? <span className="pause-glyph" /> : <Icon name="play" size={14} />}
      </button>
      <span
        aria-label="Seek"
        aria-valuemax={Math.round(length)}
        aria-valuenow={Math.round(time)}
        className="voice-wave"
        onKeyDown={event => {
          const el = audio.current
          if (!el || !src) return
          if (event.key === 'ArrowRight') el.currentTime = Math.min(el.duration || 0, el.currentTime + 5)
          if (event.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 5)
        }}
        onPointerDown={event => {
          ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
          void seek(event.clientX)
        }}
        onPointerMove={event => event.buttons === 1 && void seek(event.clientX)}
        ref={wave}
        role="slider"
        tabIndex={0}
      >
        {bars.map((h, i) => (
          <i data-done={i / bars.length < progress || undefined} key={i} style={{ height: `${Math.round(h * 100)}%` }} />
        ))}
      </span>
      <span className="voice-time">{clock(playing || time ? time : length)}</span>
      <audio
        onDurationChange={event => Number.isFinite(event.currentTarget.duration) && setLength(event.currentTarget.duration)}
        onEnded={() => {
          setPlaying(false)
          setTime(0)
        }}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
        preload="metadata"
        ref={audio}
        src={src || undefined}
      />
    </div>
  )
}

/** The user's voice note: the recording (this device's copy) and the transcript under it. */
export function VoiceNote({ att, copyId, transcript, transcribed }: { att: MsgAttachment; copyId?: string; transcript: string; transcribed: boolean }) {
  const load = async () => {
    const blob = copyId ? await blobOf(copyId) : null

    if (!blob || !blob.size) throw new Error('the recording is no longer on this device')

    return URL.createObjectURL(blob)
  }

  return (
    <div className="voice-note mine">
      <VoiceClip eager load={load} mine seed={att.name} />
      <div className="voice-transcript" data-raw={!transcribed || undefined}>
        {transcribed ? transcript : 'Not transcribed. The recording went to the bot.'}
      </div>
    </div>
  )
}

/** A bot's voice memo: audio from the Hermes machine and its text as the caption. */
export function VoiceMemo({ file, caption }: { file: BotFile; caption: string }) {
  return (
    <div className="voice-note">
      <VoiceClip load={() => fetchBotFile(file)} seconds={file.seconds} seed={file.name} />
      {caption ? <div className="voice-transcript">{caption}</div> : null}
    </div>
  )
}

export function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const speaking = useStore($speaking) === id

  if (!canReadAloud()) return null

  return (
    <button aria-label={speaking ? 'Stop reading' : 'Read aloud'} className="icon-btn xs ghost" data-on={speaking || undefined} onClick={() => readAloud(id, text)} title={speaking ? 'Stop reading' : 'Read aloud'} type="button">
      {speaking ? <Icon name="stop" size={13} /> : <Icon name="volume" size={14} />}
    </button>
  )
}

// ── settings ──────────────────────────────────────────────────────────────
export function VoiceSettings() {
  const mic = useStore($micDevice)
  const voice = useStore($readVoice)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [list, setList] = useState<SpeechSynthesisVoice[]>(voices())

  useEffect(() => {
    const read = () =>
      navigator.mediaDevices
        ?.enumerateDevices()
        .then(all => setMics(all.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')))
        .catch(() => undefined)
    void read()
    navigator.mediaDevices?.addEventListener?.('devicechange', read)
    const onVoices = () => setList(voices())
    if (canReadAloud()) window.speechSynthesis.addEventListener('voiceschanged', onVoices)

    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', read)
      if (canReadAloud()) window.speechSynthesis.removeEventListener('voiceschanged', onVoices)
    }
  }, [])

  return (
    <div className="field voice-settings">
      <span>Voice</span>
      <label className="sub-field">
        <small>Microphone for voice notes</small>
        <select className="input" onChange={e => $micDevice.set(e.target.value)} value={mic}>
          <option value="">System default</option>
          {mics.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Microphone ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
      <label className="sub-field">
        <small>Voice for Read aloud</small>
        <span className="inline-field">
          <select className="input" onChange={e => $readVoice.set(e.target.value)} value={voice}>
            <option value="">System default</option>
            {list.map(v => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
          <button className="btn sm ghost" disabled={!canReadAloud()} onClick={() => sampleVoice(voice)} type="button">
            <Icon name="volume" size={14} /> Try
          </button>
        </span>
      </label>
      <small>Voice notes are transcribed and spoken replies made by Hermes, with each bot's own speech settings. Read aloud uses this computer's voices.</small>
    </div>
  )
}
