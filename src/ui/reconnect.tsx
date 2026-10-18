/** Shown while the link to Hermes is down: what is happening, when the next try is, and a way to skip the wait. */
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { gateway } from '../lib/gateway'
import { Icon } from './icons'

export function ReconnectBar() {
  const state = useStore(gateway.state)
  const info = useStore(gateway.retrying)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (state !== 'reconnecting') {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), 500)

    return () => clearInterval(timer)
  }, [state])

  if (state !== 'reconnecting') {
    return null
  }

  const waiting = !!info && !info.trying
  const seconds = waiting ? Math.max(0, Math.ceil((info.nextAt - now) / 1000)) : 0
  const headline = waiting && seconds > 0 ? `Connection lost — trying again in ${seconds}s` : 'Reconnecting to Hermes…'

  return (
    <div className="offline-bar" role="status">
      <div className="line">
        <i className="spin" />
        <span>{headline}</span>
        {info && info.attempt > 1 ? <small>try {info.attempt}</small> : null}
        <button disabled={!waiting} onClick={() => gateway.retryNow()} type="button">
          <Icon name="refresh" size={12} /> Try now
        </button>
      </div>
      {info?.error && info.attempt > 1 ? <small className="why">{info.error}</small> : null}
    </div>
  )
}
