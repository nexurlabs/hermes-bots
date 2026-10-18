import { atom } from 'nanostores'

/** The picture shown full-size over the app (attachments, images in replies). */
export const $lightbox = atom<{ name: string; src: string } | null>(null)
