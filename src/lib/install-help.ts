/**
 * What to tell someone whose computer doesn't have Hermes Agent yet. Pure (no app imports) so it
 * is unit-tested directly. The install one-liners are the official ones from
 * https://github.com/NousResearch/hermes-agent (README "Quick Install").
 */

/** Marker the main process puts in a local:start failure when the Hermes binary can't be run. */
export const MISSING_AGENT = 'HERMES_AGENT_NOT_INSTALLED'

export const INSTALL_DOCS = 'https://hermes-agent.nousresearch.com/docs/getting-started/installation'

/** Oldest Hermes Agent this app is tested against. */
export const MIN_HERMES_VERSION = '0.22.3'

export interface InstallCommand {
  shell: string
  command: string
}

export function installCommand(platform: string): InstallCommand {
  if (platform === 'win32') {
    return { shell: 'PowerShell', command: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)' }
  }

  return { shell: 'Terminal', command: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash' }
}

/** True when a connect error means "Hermes Agent isn't installed here" rather than any other failure. */
export function isMissingAgentError(error: unknown): boolean {
  const text = String((error as Error)?.message ?? error ?? '')

  return text.includes(MISSING_AGENT) || /\bspawn\s+\S*hermes\S*\s+ENOENT\b/i.test(text)
}
