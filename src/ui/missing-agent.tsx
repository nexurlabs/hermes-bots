import { useState } from 'react'

import { INSTALL_DOCS, MIN_HERMES_VERSION, installCommand } from '../lib/install-help'
import { native } from '../lib/native'
import { Icon } from './icons'

/** Shown on the connect screen when "This computer" can't find or start Hermes Agent. */
export function MissingAgent({ platform, logPath, onRetry }: { platform: string; logPath?: string; onRetry: () => void }) {
  const { shell, command } = installCommand(platform)
  const [copied, setCopied] = useState(false)

  const copy = () =>
    void native.copyText(command).then(ok => {
      setCopied(Boolean(ok))
      setTimeout(() => setCopied(false), 1800)
    })

  return (
    <div className="missing-agent" data-testid="missing-agent">
      <h2>Hermes Agent isn't installed on this computer</h2>
      <p>
        Hermes Bots needs Hermes Agent (v{MIN_HERMES_VERSION} or newer) running on this PC. Open {shell}, paste this command and press Enter. When it
        finishes, come back and press Retry.
      </p>
      <div className="install-cmd">
        <code>{command}</code>
        <button className="btn sm" onClick={copy} type="button">
          <Icon name="copy" size={14} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="missing-links">
        <a
          href={INSTALL_DOCS}
          onClick={event => {
            event.preventDefault()
            void native.openExternal(INSTALL_DOCS)
          }}
        >
          Install guide
        </a>
        {' · '}Already installed somewhere else? Pick "Remote server" or "Over SSH" below.
      </p>
      <button className="btn primary block" onClick={onRetry} type="button">
        Retry
      </button>
      {logPath ? <small className="banner-hint">Details are in {logPath}</small> : null}
    </div>
  )
}
