import { describe, expect, test } from 'bun:test'

import { groupSecrets, secretKind } from '../src/lib/secret-kinds'

describe('secrets list grouping', () => {
  test('app-managed tool tokens are locked', () => {
    expect(secretKind({ name: 'MCP_HERMES_BOTS_THIS_PC_TOKEN', custom: true })).toBe('app')
    expect(secretKind({ name: 'MCP_HERMES_BOTS_GROUPS_TOKEN', custom: false, password: true })).toBe('app')
  })
  test('Hermes non-secret defaults fold away', () => {
    expect(secretKind({ name: 'BROWSER_INACTIVITY_TIMEOUT', custom: false, password: false })).toBe('setting')
    expect(secretKind({ name: 'TERMINAL_ENV', custom: false })).toBe('setting')
  })
  test('real keys stay visible', () => {
    expect(secretKind({ name: 'MINIMAX_API_KEY', custom: false, password: true })).toBe('secret')
    expect(secretKind({ name: 'GITHUB_TOKEN', custom: false, password: false })).toBe('secret')
    expect(secretKind({ name: 'MY_THING', custom: true })).toBe('secret')
  })
  test('groupSecrets splits', () => {
    const g = groupSecrets([{ name: 'MINIMAX_API_KEY', custom: false, password: true }, { name: 'MCP_HERMES_BOTS_X', custom: true }, { name: 'BROWSER_INACTIVITY_TIMEOUT', custom: false, password: false }])
    expect([g.secret.length, g.app.length, g.setting.length]).toEqual([1, 1, 1])
  })
})

test("Hermes's template settings fold away even though /api/env calls them custom", () => {
  expect(secretKind({ name: 'BROWSER_INACTIVITY_TIMEOUT', custom: true, password: true })).toBe('setting')
  expect(secretKind({ name: 'TERMINAL_TIMEOUT', custom: true, password: true })).toBe('setting')
  expect(secretKind({ name: 'MY_TIMEOUT', custom: true, password: true })).toBe('secret')
})
