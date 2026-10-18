// Design preview of the Computer tab (`#computer`, `#computer-open`, `#computer-openhold`, `#computer-thispc`, `#computer-thispcopen`).
// Set only by demo.ts in a plain browser; null in the app, where the tab talks to Hermes and Electron as usual.
import { atom } from 'nanostores'

export interface ComputerDemo {
  mode: 'sandbox' | 'thispc'
  open: boolean
  /** Freeze the large view's hold-Esc-to-close hint part-way (`#computer-openhold`). */
  hold?: boolean
  /** Show the preview as if hovered (`#computer-hover`, `#computer-thispchover`): headless screenshots can't hover. */
  hover?: boolean
  /** Stand-in for the remote screen (sandbox) or the last screenshot (This PC). */
  screen: string
  width: number
  height: number
}

export const $computerDemo = atom<ComputerDemo | null>(null)
