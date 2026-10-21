/**
 * "Hermes has no AI provider" notice. The app never asks for or stores API keys: keys are set up
 * with Hermes's own onboarding (`/login` in chat, or `hermes model` / `hermes setup` on the Hermes
 * machine). Pure (no app imports) so it is unit-tested directly.
 */
import { atom } from 'nanostores'

/** Hermes's error when a turn starts with no provider configured. */
export function isNoProviderError(text: unknown): boolean {
  const s = String(text ?? '')

  return /not connected to any AI provider/i.test(s) || /no (?:inference |LLM )?provider (?:is )?configured/i.test(s)
}

/** Given model.options' provider rows: true when Hermes has none it can actually use. */
export function needsProvider(rows: { authenticated?: boolean }[] | null | undefined): boolean {
  if (!Array.isArray(rows) || !rows.length) {
    return false
  }

  return !rows.some(r => r.authenticated !== false)
}

export const PROVIDER_NOTICE_TEXT =
  'Hermes isn\u2019t connected to an AI provider yet. Type /login in this chat, or run `hermes model` (or `hermes setup`) on the Hermes machine.'

/** True while the banner is shown. Non-blocking; the user can dismiss it. */
export const $providerNotice = atom(false)

/** Show the notice if `text` is Hermes's "no provider" error. */
export function noteProviderError(text: unknown) {
  if (isNoProviderError(text) && !$providerNotice.get()) {
    $providerNotice.set(true)
  }
}
