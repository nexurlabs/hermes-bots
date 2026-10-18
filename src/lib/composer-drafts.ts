/**
 * Unsent composer work, kept per chat.
 *
 * Switching chats must never eat what someone was in the middle of writing, so the composer parks
 * its text, picked files and reply recipient here — keyed by the stable scope the app already hands
 * it (`bot:<profile>` / `room:<room id>`) — instead of holding them in component state alone.
 *
 * In memory, on purpose: drafts are private message text and file handles, so they never touch
 * localStorage, IndexedDB or the disk. They last exactly as long as the window does.
 *
 * Nothing is ever evicted on a count: only sending or deliberately cancelling a draft frees it, so
 * visiting many chats can never silently drop what someone was writing.
 */
import type { Pending } from './attachments'

/** Structurally the quote the composer replies to; declared here so this module stays free of UI imports. */
export interface DraftQuote {
  who: string
  text: string
  /** Stable profile id; a display name or editable quote is not an address. */
  member?: string
  scope?: string
}

export interface ComposerDraft {
  text: string
  files: Pending[]
  quote: DraftQuote | null
}

const empty = (): ComposerDraft => ({ text: '', files: [], quote: null })

/** A chat with nothing unsent in it. */
export const emptyDraft = empty

const drafts = new Map<string, ComposerDraft>()

type DraftListener = (scope: string, draft: ComposerDraft) => void

const listeners = new Set<DraftListener>()

/** Tells a mounted composer that its chat's draft changed underneath it. */
export function onDraftChanged(listener: DraftListener): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

const announce = (scope: string, draft: ComposerDraft) => {
  listeners.forEach(listener => listener(scope, draft))
}

/** A composer without a chat key has nothing to key a draft on, so it simply never retains one. */
export function readDraft(scope?: string): ComposerDraft {
  return (scope && drafts.get(scope)) || empty()
}

/** Stores a draft, or forgets the chat entirely once nothing unsent is left in it. */
export function saveDraft(scope: string | undefined, draft: ComposerDraft): void {
  if (!scope) {
    return
  }

  if (!draft.text && !draft.files.length && !draft.quote) {
    // Only a chat that actually had something unsent is worth reporting as emptied.
    if (drafts.delete(scope)) {
      announce(scope, empty())
    }

    return
  }

  if (drafts.get(scope) === draft) {
    return
  }

  drafts.set(scope, draft)
  announce(scope, draft)
}

/** Called when a draft was actually sent or deliberately cancelled. */
export function clearDraft(scope: string | undefined): void {
  if (scope && drafts.delete(scope)) {
    announce(scope, empty())
  }
}