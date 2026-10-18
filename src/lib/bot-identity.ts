/**
 * The conversation-identity barrier: before a bot's first real turn, prove that bot is registered as
 * ITS OWN groups route on the Hermes it is about to talk to.
 *
 * Why this exists. Every bot is its own Hermes profile, and each profile's tools ride on the app's
 * `hermes-bots-groups` MCP server at `/groups/<profile>` with a bearer derived from that profile. A
 * profile cloned from default arrives carrying default's URL *and* default's valid bearer, and the
 * inherited pair connects perfectly well — as default. So "the MCP connection works" and "the tools
 * will be attributed to this bot" are different claims, and only the second one protects the user's
 * conversation.
 *
 * This gate is deliberately separate from This PC. A bot can have a working computer-use server and
 * still not be proven to answer as itself; keeping the two apart means a PC fix can never stand in
 * for identity, and an identity refusal can never break the PC tools the user already has working.
 *
 * The gate is fail-closed: no answer, a refused answer, or an error all mean "not ready". The only
 * ready state is an affirmative one.
 *
 * ## What a proof is worth, and for how long
 *
 * An affirmative answer describes one link to one Hermes. It is worth nothing the moment that link is
 * replaced: a reconnect can land on a different gateway whose config says nothing about the old one,
 * and a rebuilt tunnel can point at a different address. So a proof is cached under a *scope* —
 * machine, address, socket generation, profile — and any change to that scope forces a fresh proof.
 *
 * The scope deliberately does NOT include `gateway.seq`. That is the event high-water mark: it moves
 * on every ordinary frame, so keying on it would re-ask Hermes (a DELETE/POST/read-back/test in
 * Electron) for every bot on every message while telling you nothing when a socket is genuinely
 * replaced at an unchanged seq. `Gateway.gen` is the transport generation that means that.
 *
 * ## Fencing
 *
 * A check takes time, so the world can change while one is in flight. Each bot carries an epoch,
 * bumped by every invalidation, and a check is only allowed to speak if it is still on the current
 * epoch. A late answer from a discarded check therefore can neither authorize a turn nor leave a
 * proof behind, and its cleanup only frees the in-flight slot it still owns, so a newer check in the
 * same slot survives.
 */
import { gateway, type Gateway } from './gateway'
import { gatewayForHost, onMachineReconnect, splitBot } from './hosts'
import { native } from './native'
import { $active } from './store'

type Verdict = { ready: boolean; error?: string }

/** What a cached affirmative answer was made against. */
interface Proof {
  scope: string
}

/** In-flight checks, so two messages racing to the same fresh bot wait on one answer. */
interface Pending {
  epoch: number
  scope: string
  run: Promise<Verdict>
}

const proofs = new Map<string, Proof>()
const checking = new Map<string, Pending>()
const epochs = new Map<string, number>()

/** The browser preview has no Hermes to ask, so there is nothing to prove and nothing to block. */
const canAsk = () => typeof native.groupsEnsureIdentity === 'function'

/**
 * Everything the answer depends on, for one addressed bot.
 *
 * `forge@hbbbbbbb` resolves to that added machine's own socket and address, never the main gateway's,
 * so two machines' identically-named profiles are two separate proofs. A bot on a host this app does
 * not have is scoped to that host id alone: there is no socket here to compare, and Electron refuses
 * it anyway.
 */
function scopeOf(who: string): string {
  const { profile, host } = splitBot(who)

  if (!host) {
    return `gen${gateway.connectionGen}|${$active.get()?.baseUrl || ''}|${profile}`
  }

  const target = gatewayForHost(host)

  if (!target) {
    return `host:${host}|${profile}`
  }

  return `host:${host}|gen${target.gw.connectionGen}|${target.endpoint?.baseUrl || ''}|${profile}`
}

/**
 * The bots whose proofs or in-flight checks just died with a socket.
 *
 * Matched by asking which machine actually carries each name, not by reading the scope string back:
 * that keeps `forge@hbbbbbbb` tied to its own machine's socket, so a main gateway's reconnect can
 * never retire it, while the remote machine's own reconnect does. A name on a machine this app does
 * not have resolves to no socket at all, so no reconnect can claim its link died — there is nothing
 * here that would know.
 *
 * In-flight checks are included because a check already asked on a dying socket is exactly as stale
 * as a cached answer, and it would otherwise resolve afterwards and authorize the next turn.
 */
function onScope(gw: Gateway): string[] {
  const carriedBy = (name: string) => gatewayForHost(splitBot(name).host)?.gw === gw
  const names = [...proofs.keys()].filter(carriedBy)

  for (const name of checking.keys()) {
    if (carriedBy(name) && !names.includes(name)) names.push(name)
  }

  return names
}

/** Drops a bot's proof and retires any check in flight, so the next turn asks Hermes again. */
function invalidate(who: string) {
  proofs.delete(who)
  epochs.set(who, (epochs.get(who) || 0) + 1)
}

/** Retires everything cached on one machine's socket generation. */
function invalidateScope(gw: Gateway) {
  for (const name of onScope(gw)) invalidate(name)
}

async function ask(who: string): Promise<Verdict> {
  if (!canAsk()) {
    return { ready: true }
  }

  try {
    const result = await native.groupsEnsureIdentity!(who)

    return result && result.ready === true ? { ready: true } : { ready: false, error: result?.error || '' }
  } catch (error) {
    // The check itself failed, which is unproven, not proven-good.
    return { ready: false, error: String((error as Error)?.message || error) }
  }
}

/**
 * Is this bot confirmed to be itself right now? Returns the verdict and does not throw, so callers
 * decide what a refusal means for them.
 */
export async function ensureBotIdentity(who: string): Promise<Verdict> {
  const name = String(who || 'default')

  if (!canAsk()) {
    return { ready: true }
  }

  const scope = scopeOf(name)
  const held = proofs.get(name)

  // A reconnected gateway, a rebuilt tunnel or a re-added machine can all move a profile's Hermes
  // out from under an affirmative answer, so a proof only stands for the scope it was made on.
  // Event movement is not part of that scope, so ordinary frames never retire anything.
  if (held && held.scope !== scope) {
    invalidate(name)
  } else if (proofs.has(name)) {
    return { ready: true }
  }

  const pending = checking.get(name)

  // Two messages racing to the same fresh bot wait on one answer, unless that answer belongs to an
  // epoch that has since been retired — then this caller must start its own check.
  if (pending && pending.scope !== scope) invalidate(name)
  if (pending && pending.scope === scope && (epochs.get(name) || 0) === pending.epoch) {
    return pending.run
  }

  const epoch = epochs.get(name) || 0
  const entry: Pending = { epoch, scope, run: null as unknown as Promise<Verdict> }

  entry.run = ask(name)
    .then(verdict => {
      // Only an answer from the current epoch may authorize this turn or cache anything. An
      // overtaken check reports a refusal: it proves nothing about the state that replaced it.
      if ((epochs.get(name) || 0) !== epoch || scopeOf(name) !== scope) {
        return { ready: false, error: 'the identity check was overtaken by a newer one' }
      }

      if (verdict.ready) {
        proofs.set(name, { scope })
      }

      return verdict
    })
    .finally(() => {
      // Free the slot only if it is still ours, so an old check's cleanup cannot delete a newer one.
      if (checking.get(name) === entry) {
        checking.delete(name)
      }
    })

  checking.set(name, entry)

  return entry.run
}

/**
 * Forgets every proof, or one bot's, so the next turn asks Hermes again.
 *
 * It retires the in-flight check as well as the cached answer, so a reply already on the way cannot
 * arrive late and stand in for the fresh one. Wired to reconnect below; tests use it directly.
 */
export function forgetBotIdentity(who?: string) {
  if (typeof who === 'string') {
    invalidate(who)

    return
  }

  for (const name of new Set([...proofs.keys(), ...checking.keys()])) invalidate(name)
}

/**
 * The human-facing half of a refusal: what the user is told when their message could not be sent
 * safely. It says what happened without naming tokens or any private conversation content.
 */
export function identityRefusalText(who: string, verdict: Verdict): string {
  const why = verdict.error?.trim()

  return why || `${who} is not confirmed as its own bot on this Hermes yet, so nothing was sent.`
}

// A reconnect replaces the socket every proof on it was made against, so nothing cached on that
// machine survives one. This is the module's own subscription rather than a caller's: an affirmative
// answer outliving the connection it came from is exactly the failure this gate exists to prevent,
// and no other listener would catch it. Each machine reports its own reconnect (the main one here,
// an added one through hosts' hand-over), so one Hermes's re-dial never retires another's proofs.
gateway.onReconnect(() => invalidateScope(gateway))
onMachineReconnect((_host, gw) => invalidateScope(gw))