import { atom } from 'nanostores'

/**
 * A "see its screen" chip on a bot's own message asks for that bot's Computer
 * tab, the same way a sign-in handoff card does — so a screenshot the bot took
 * of its own desktop opens the live screen instead of sending the user off to
 * hunt for it (or to a raw VNC link).
 *
 * The Computer tab is the same server the bot drove, so the chip is a doorway
 * to the live thing rather than a second copy of the picture. Set the store and
 * the panel switches; it clears itself, so a stale click can't re-open a tab
 * for a bot you have since navigated away from.
 */
export const $screenChip = atom<null | { bot: string; at: number }>(null)

export function showComputerTab(bot: string) {
  $screenChip.set({ bot, at: Date.now() })
}
