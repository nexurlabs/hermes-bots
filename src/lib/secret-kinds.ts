/**
 * How a name from the bot's profile `.env` shows in Details > Secrets:
 * - 'app': written by NexurBots itself (MCP_HERMES_BOTS_*, the This PC / groups tool-server tokens).
 *   Deleting one breaks the bot's link to the app, so it's shown locked, with no delete button.
 * - 'setting': a Hermes default that isn't a secret at all (BROWSER_INACTIVITY_TIMEOUT, …). Hermes
 *   marks these is_password=false; they're folded under "Hermes settings" so real keys stand out.
 * - 'secret': everything else (API keys, tokens, and any custom var the user or a bot added).
 */
export type SecretKind = 'app' | 'setting' | 'secret'

export interface SecretName {
  name: string
  custom: boolean
  /** Hermes's own flag; undefined on an older Hermes that doesn't send it. */
  password?: boolean
}

const APP_PREFIX = /^MCP_HERMES_BOTS_/
const LOOKS_SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|PRIVATE)/

export function secretKind(item: SecretName): SecretKind {
  if (APP_PREFIX.test(item.name)) return 'app'
  if (item.custom) return 'secret'
  if (item.password === false && !LOOKS_SECRET.test(item.name)) return 'setting'
  if (item.password === undefined && !LOOKS_SECRET.test(item.name)) return 'setting'

  return 'secret'
}

export function groupSecrets(items: SecretName[]) {
  const out: Record<SecretKind, SecretName[]> = { secret: [], app: [], setting: [] }

  for (const item of items) out[secretKind(item)].push(item)

  return out
}
