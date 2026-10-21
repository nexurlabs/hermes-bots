import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const window = new Window({ url: 'http://localhost' })
;(globalThis as any).window ??= window
;(globalThis as any).localStorage ??= window.localStorage
const { ThinkSlider } = await import('../src/ui/thread')

describe('composer thinking slider', () => {
  test('starts at the default level with an accessible label, no sparkle menu', () => {
    const html = renderToStaticMarkup(createElement(ThinkSlider, { value: '', onChange: () => {} }))
    expect(html).toContain('type="range"')
    expect(html).toContain('aria-label="Thinking effort for this message"')
    expect(html).toContain('Medium (default)')
    expect(html).toContain('max="5"')
    expect(html).not.toContain('composer-think')
  })
  test('shows the picked level', () => {
    const html = renderToStaticMarkup(createElement(ThinkSlider, { value: 'xhigh', onChange: () => {} }))
    expect(html).toContain('value="4"')
    expect(html).toContain('Extra high')
  })
})
