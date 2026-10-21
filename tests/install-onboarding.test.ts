import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const window = new Window()
;(globalThis as any).window ??= window
;(globalThis as any).localStorage ??= window.localStorage
;(globalThis as any).document ??= window.document

const help = await import('../src/lib/install-help')
const { MissingAgent } = await import('../src/ui/missing-agent')
const { ConnectScreen } = await import('../src/ui/connect')
const { $connectError, $connectLog } = await import('../src/lib/connection')
const { $phase } = await import('../src/lib/store')

describe('install help', () => {
  test('official one-liners per platform', () => {
    expect(help.installCommand('win32')).toEqual({ shell: 'PowerShell', command: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)' })
    expect(help.installCommand('linux').command).toBe('curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash')
    expect(help.installCommand('darwin').command).toBe('curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash')
  })

  test('recognizes the missing-agent error as it arrives over IPC, and raw ENOENT from older builds', () => {
    expect(help.isMissingAgentError(new Error(`Error invoking remote method 'local:start': Error: ${help.MISSING_AGENT}: Hermes Agent isn't installed on this computer.`))).toBe(true)
    expect(help.isMissingAgentError("Error invoking remote method 'local:start': Error: spawn hermes ENOENT")).toBe(true)
    expect(help.isMissingAgentError('Hermes took too long to start')).toBe(false)
    expect(help.isMissingAgentError("Can't reach http://x")).toBe(false)
  })
})

describe('missing-agent screen', () => {
  test('plain text, platform command with copy, docs link, retry, log path as detail', () => {
    const html = renderToStaticMarkup(createElement(MissingAgent, { platform: 'win32', logPath: 'C:\\Users\\you\\.hermes\\logs\\hermes-bots.log', onRetry: () => undefined }))
    expect(html).toContain('Hermes Agent isn&#x27;t installed on this computer')
    expect(html).toContain('iex (irm https://hermes-agent.nousresearch.com/install.ps1)')
    expect(html).toContain('Copy')
    expect(html).toContain(help.INSTALL_DOCS)
    expect(html).toContain('Retry')
    expect(html).toContain('hermes-bots.log')
    expect(html).not.toContain('ENOENT')
  })

  test('connect screen shows it instead of the raw error', () => {
    $phase.set('connect')
    $connectLog.set('/home/you/.hermes/logs/hermes-bots.log')
    $connectError.set(`${help.MISSING_AGENT}: Hermes Agent isn't installed on this computer.`)
    const html = renderToStaticMarkup(createElement(ConnectScreen))
    expect(html).toContain('data-testid="missing-agent"')
    expect(html).toContain('install.sh')
    expect(html).not.toContain(help.MISSING_AGENT)
  })

  test('other connect errors keep the normal banner', () => {
    $phase.set('connect')
    $connectError.set('Hermes took too long to start')
    const html = renderToStaticMarkup(createElement(ConnectScreen))
    expect(html).not.toContain('data-testid="missing-agent"')
    expect(html).toContain('Hermes took too long to start')
  })
})
