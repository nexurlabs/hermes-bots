/**
 * Math in replies, rendered with KaTeX. KaTeX is large, so it isn't in the app bundle: build.ts
 * copies it next to the app, and it's loaded the first time a reply has math in it.
 */
import { atom } from 'nanostores'

interface Katex {
  renderToString(tex: string, options: Record<string, unknown>): string
}

/** 'idle' until a reply needs it; the math in replies re-renders when it turns 'ready'. */
export const $katex = atom<'idle' | 'loading' | 'ready' | 'failed'>('idle')

const katex = () => (window as unknown as { katex?: Katex }).katex

export function loadKatex() {
  if ($katex.get() !== 'idle' || typeof document === 'undefined') {
    return
  }

  if (katex()) {
    $katex.set('ready')

    return
  }

  $katex.set('loading')
  const css = document.createElement('link')
  css.rel = 'stylesheet'
  css.href = 'katex/katex.min.css'
  document.head.appendChild(css)
  const script = document.createElement('script')
  script.src = 'katex/katex.min.js'
  script.onload = () => $katex.set(katex() ? 'ready' : 'failed')
  script.onerror = () => $katex.set('failed')
  document.head.appendChild(script)
}

const cache = new Map<string, string>()

/**
 * KaTeX's HTML for one formula, or null while KaTeX isn't loaded. `trust: false` keeps out
 * `\href`, `\url` and friends; a formula that doesn't parse comes back as red source text.
 */
export function renderMath(tex: string, display: boolean): null | string {
  const engine = katex()

  if (!engine) {
    return null
  }

  const key = `${display ? 'D' : 'I'}${tex}`
  const hit = cache.get(key)

  if (hit !== undefined) {
    return hit
  }

  let html: string

  try {
    html = engine.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', maxSize: 50, maxExpand: 500, output: 'htmlAndMathml' })
  } catch {
    return null
  }

  if (cache.size > 500) {
    cache.clear()
  }

  cache.set(key, html)

  return html
}
