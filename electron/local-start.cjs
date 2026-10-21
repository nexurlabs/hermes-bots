'use strict'
/**
 * Turns a failure to launch the local Hermes Agent into something a person can act on.
 * `spawn hermes ENOENT` (or a missing/unexecutable binary) means Hermes Agent isn't installed;
 * the renderer recognizes MISSING_AGENT and shows the install screen instead of the raw error.
 */
const MISSING_AGENT = 'HERMES_AGENT_NOT_INSTALLED'

function isMissingAgent(error) {
  if (!error) return false
  const code = error.code || ''
  const text = String(error.message || error)
  if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') return true
  return /\bspawn\b.*\b(ENOENT|EACCES)\b/.test(text) || /is not recognized as an internal or external command/i.test(text)
}

function explainLocalStartError(error) {
  if (isMissingAgent(error)) {
    const wrapped = new Error(`${MISSING_AGENT}: Hermes Agent isn't installed on this computer.`)
    wrapped.code = MISSING_AGENT
    return wrapped
  }
  return error instanceof Error ? error : new Error(String(error))
}

module.exports = { MISSING_AGENT, isMissingAgent, explainLocalStartError }
