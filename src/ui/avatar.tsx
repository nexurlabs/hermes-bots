import { useStore } from '@nanostores/react'
import type { CSSProperties } from 'react'

import { $avatars, $busy } from '../lib/store'
import type { Bot } from '../lib/types'
import { avatarColor, botAppearance, BotFace } from './avatar-face'
import { Icon } from './icons'

export function Avatar({
  bot,
  size = 38,
  badge = true,
  float = false,
  activity = false
}: {
  bot: Bot | null | undefined
  size?: number
  badge?: boolean
  float?: boolean
/** Whether this face shows the working animation.
   *  `true`/`false` pins it — used by a message that is streaming right now, and by
   *  every settled message, which must stay still. `'global'` subscribes to the
   *  per-bot busy atom, for the handful of places that really are "this bot is
   *  working right now" (the roster row, the room header).
   *
   *  Defaulting to the busy atom here is what made EVERY past message of a working
   *  bot animate at once: one busy bot lit up every face it had ever posted under.
   *  So nothing implies `global` — a caller has to ask for it. */
  activity?: boolean | 'global'
}) {
  const avatars = useStore($avatars)
  const busy = useStore($busy)

  if (!bot) {
    return <span className="avatar ghost" style={{ width: size, height: size }} />
  }

  const image = avatars[bot.name] || (typeof bot.meta.image === 'string' ? bot.meta.image : null)
  const look = botAppearance(bot.name, bot.meta as never)
const working = activity === 'global' ? Boolean(Object.prototype.hasOwnProperty.call(busy, bot.name) && busy[bot.name]) : activity
  const star = Math.max(13, Math.round(size * 0.36))

  return (
    <span
      className="avatar"
      data-float={float || undefined}
      data-working={working || undefined}
      style={{ width: size, height: size, '--ring': avatarColor(look.color, bot.name) } as CSSProperties}
    >
      <span className="avatar-body">
        {image ? (
          <img alt="" className="avatar-img" src={image} style={{ width: size, height: size }} />
        ) : (
          <BotFace color={avatarColor(look.color, bot.name)} image={null} mood={working ? 'work' : 'idle'} name={bot.name} shape={look.shape} size={size} />
        )}
      </span>
      {badge && bot.lead ? (
        <span className="avatar-star" style={{ width: star, height: star }}>
          <Icon name="star" size={Math.round(star * 0.62)} />
        </span>
      ) : null}
    </span>
  )
}

/** A group's face: members tucked into a 2×2 cluster, the rest as "+N". */
export function AvatarStack({
  bots,
  size = 38,
  activity = false,
  activityFor
}: {
  bots: Bot[]
  size?: number
  activity?: boolean | 'global'
  activityFor?: (bot: Bot) => boolean
}) {
  const cell = Math.round(size * 0.54)
  const shown = bots.slice(0, bots.length > 4 ? 3 : 4)
  const extra = bots.length - shown.length
  const face = (bot: Bot) => (activityFor ? activityFor(bot) : activity)

  if (shown.length <= 1) {
return <Avatar activity={face(shown[0])} badge={false} bot={shown[0]} size={size} />
  }

  return (
    <span className="cluster" data-count={shown.length + (extra > 0 ? 1 : 0)} style={{ width: size, height: size }}>
      {shown.map(bot => (
        <span className="cluster-cell" key={bot.name}>
<Avatar activity={face(bot)} badge={false} bot={bot} size={cell} />
        </span>
      ))}
      {extra > 0 ? (
        <span className="cluster-cell cluster-more" style={{ fontSize: Math.round(cell * 0.72) }}>
          +{extra}
        </span>
      ) : null}
    </span>
  )
}
