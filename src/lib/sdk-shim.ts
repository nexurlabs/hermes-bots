// Stand-ins for the few Hermes SDK helpers the avatar renderer uses.
export { blobatar as blobatarSvg } from 'blobatar/blob'

/** The handle a budgeted loop hands back: tear it down, or nudge it awake. */
export interface BudgetedLoop {
  dispose: () => void
  wake: () => void
}

export type CreateBudgetedLoop = (
  paint: (now: number) => void,
  options: { fps?: number; idleWhen?: () => boolean }
) => BudgetedLoop

// Optional on older SDKs, so the type has to admit both shapes: the renderer
// feature-detects it and falls back to its own clock when it is missing.
export const createBudgetedLoop = undefined as unknown as CreateBudgetedLoop | undefined

function hashString(value: string): number {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }

  return hash
}

/** Same deterministic hue Hermes gives a profile, so avatars match. */
export function profileColor(name: null | string | undefined): null | string {
  const key = (name ?? '').trim()

  if (!key || key === 'default') {
    return null
  }

  return `hsl(${hashString(key) % 360} 68% 58%)`
}
