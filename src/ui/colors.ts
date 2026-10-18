import type { Bot } from '../lib/types'
import { avatarColor, blobatarSvg, botAppearance, isBlobShape, parseBlobShape } from './avatar-face'

const cache = new Map<string, string>()

/** The color a bot's face actually wears — used for its name in group chats. */
export function crewColor(bot: Bot): string {
  const { shape, color } = botAppearance(bot.name, bot.meta as never)

  if (isBlobShape(shape) && typeof blobatarSvg === 'function') {
    const { seed } = parseBlobShape(shape, bot.name)
    const hit = cache.get(seed)

    if (hit) {
      return hit
    }

    try {
      const fill = /fill="(#[0-9a-f]{3,8})"/i.exec(blobatarSvg(seed, { size: 16 }))?.[1]

      if (fill) {
        cache.set(seed, fill)

        return fill
      }
    } catch {
      /* fall through */
    }
  }

  return avatarColor(color, bot.name)
}
