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

/**
 * Non-secret settings Hermes's own `.env` template writes into every new profile. Hermes's /api/env
 * lists them as `custom` (they're in no key catalog), so `custom` alone can't tell them from a key
 * the user added. Seen on a fresh 1.8.7 profile: TERMINAL_TIMEOUT, BROWSER_INACTIVITY_TIMEOUT, …
 */
const HERMES_TEMPLATE_SETTINGS = new Set([
  'TERMINAL_ENV', 'TERMINAL_DOCKER_IMAGE', 'TERMINAL_MODAL_IMAGE', 'TERMINAL_CWD', 'TERMINAL_TIMEOUT', 'TERMINAL_LIFETIME_SECONDS',
  'BROWSERBASE_PROXIES', 'BROWSERBASE_ADVANCED_STEALTH', 'AGENT_BROWSER_ENGINE', 'BROWSER_SESSION_TIMEOUT', 'BROWSER_INACTIVITY_TIMEOUT',
  'WEB_TOOLS_DEBUG', 'VISION_TOOLS_DEBUG', 'MOA_TOOLS_DEBUG', 'IMAGE_TOOLS_DEBUG',
  'CONTEXT_COMPRESSION_ENABLED', 'CONTEXT_COMPRESSION_THRESHOLD',
  'HERMES_HUMAN_DELAY_MODE', 'HERMES_HUMAN_DELAY_MIN_MS', 'HERMES_HUMAN_DELAY_MAX_MS'
])

const APP_PREFIX = /^MCP_HERMES_BOTS_/
const LOOKS_SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|PRIVATE)/

export function secretKind(item: SecretName): SecretKind {
  if (APP_PREFIX.test(item.name)) return 'app'
  if (HERMES_TEMPLATE_SETTINGS.has(item.name)) return 'setting'
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
