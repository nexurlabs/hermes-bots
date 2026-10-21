import { useStore } from '@nanostores/react'

import { $providerNotice } from '../lib/provider-notice'

/** Small, non-blocking banner when Hermes reports no AI provider. No key fields: Hermes onboards keys itself. */
export function ProviderNotice() {
  const shown = useStore($providerNotice)

  if (!shown) {
    return null
  }

  return (
    <div className="provider-notice" role="status">
      <span>
        Hermes isn&rsquo;t connected to an AI provider yet. Type <code>/login</code> in chat, or run <code>hermes model</code> (or <code>hermes setup</code>) on the Hermes
        machine.
      </span>
      <button aria-label="Dismiss" className="btn ghost" onClick={() => $providerNotice.set(false)} type="button">
        Dismiss
      </button>
    </div>
  )
}
