import { describe, expect, test } from 'bun:test'

import { $providerNotice, isNoProviderError, needsProvider, noteProviderError } from '../src/lib/provider-notice'

describe('no-AI-provider notice', () => {
  test('detects Hermes no-provider errors', () => {
    expect(isNoProviderError('Error: not connected to any AI provider')).toBe(true)
    expect(isNoProviderError('rate limited')).toBe(false)
  })
  test('needsProvider only when every row is unauthenticated', () => {
    expect(needsProvider([])).toBe(false)
    expect(needsProvider([{ authenticated: false }])).toBe(true)
    expect(needsProvider([{ authenticated: false }, { authenticated: true }])).toBe(false)
  })
  test('a no-provider error shows the notice', () => {
    $providerNotice.set(false)
    noteProviderError('other')
    expect($providerNotice.get()).toBe(false)
    noteProviderError('not connected to any AI provider')
    expect($providerNotice.get()).toBe(true)
  })
})
