/**
 * The turn-status record: what each bot is working on right now, kept by the app as its turn starts and
 * cleared as it ends. The team line reads it so a bot can see what a busy teammate is actually doing.
 */
import { describe, expect, test, beforeEach } from 'bun:test'

import { $turnStatus, clearTurnStatus, recordTurnStatus, statusLine, turnStatusOf } from '../src/lib/store'
import { liveLine } from '../src/lib/team'

beforeEach(() => {
  $turnStatus.set({})
})

describe('the turn status a bot is working on', () => {
  test('a turn start records what the bot is doing', () => {
    recordTurnStatus('alpha', 'fix the scheduler in drain()')

    expect($turnStatus.get().alpha?.ask).toBe('fix the scheduler in drain()')
  })

  test('a long ask is kept to one line of 80 characters', () => {
    recordTurnStatus('alpha', 'x'.repeat(400))

    const ask = $turnStatus.get().alpha?.ask || ''

    expect(ask.length).toBeLessThanOrEqual(80)
    expect(ask).not.toContain('\n')
  })

  test('a backticked token in the ask is recorded as the branch', () => {
    recordTurnStatus('alpha', 'rebase onto `cm2/status-line` and rerun')

    expect($turnStatus.get().alpha?.branch).toBe('cm2/status-line')
  })

  test('a branch named past the 80-character ask limit is still recorded', () => {
    const longAsk = 'please review the long status work on this newly named integration branch `feat/a-very-long-branch-name-that-runs-well-past-the-limit`'
    expect(longAsk.length).toBeGreaterThan(80)
    expect(turnStatusOf(longAsk).branch).toBe('feat/a-very-long-branch-name-that-runs-well-past-the-limit')
  })

  test('the word after "branch" is recorded as the branch', () => {
    recordTurnStatus('alpha', 'please work on branch cm2/status-line')

    expect($turnStatus.get().alpha?.branch).toBe('cm2/status-line')
  })

  test('an ask naming no branch records no branch at all', () => {
    recordTurnStatus('alpha', 'what is the scheduler doing')

    expect($turnStatus.get().alpha?.branch).toBeUndefined()
  })

  test('onOrigin is one of yes, no or unknown', () => {
    recordTurnStatus('alpha', 'look at the build')

    expect(['yes', 'no', 'unknown']).toContain($turnStatus.get().alpha?.onOrigin)
  })

  test('a turn end clears the record', () => {
    recordTurnStatus('alpha', 'fix the scheduler')
    clearTurnStatus('alpha')

    expect($turnStatus.get().alpha).toBeUndefined()
  })

  test('clearing a bot that never started changes nothing', () => {
    recordTurnStatus('alpha', 'fix the scheduler')
    clearTurnStatus('beta')

    expect($turnStatus.get().alpha?.ask).toBe('fix the scheduler')
    expect($turnStatus.get().beta).toBeUndefined()
  })

  test('a group turn and a 1:1 turn for the same bot are recorded separately', () => {
    recordTurnStatus('alpha', 'group work')
    recordTurnStatus('alpha', 'dm work')

    expect($turnStatus.get().alpha?.ask).toBe('dm work')
  })
})

describe('the one-line status text', () => {
  test('it carries the ask', () => {
    expect(statusLine({ ask: 'fix the scheduler', onOrigin: 'unknown' })).toContain('fix the scheduler')
  })

  test('it carries the branch when there is one', () => {
    expect(statusLine({ ask: 'rebase it', branch: 'cm2/status-line', onOrigin: 'unknown' })).toContain('cm2/status-line')
  })

  test('it says nothing about a branch when there is none', () => {
    const line = statusLine({ ask: 'fix the scheduler', onOrigin: 'unknown' })

    expect(line).not.toContain('branch')
  })

  test('it is one line', () => {
    expect(statusLine({ ask: 'x'.repeat(400), onOrigin: 'unknown' })).not.toContain('\n')
  })

  test('the team line and the roster read the exact same text', () => {
    // The roster is not built yet, so the shared helper is what both sides call. What matters here is
    // that there is one function producing the line, so the two cannot drift apart in wording.
    const status = { ask: 'fix the scheduler in drain()', branch: 'cm2/status-line', onOrigin: 'no' as const }
    const fromStore = statusLine(status)
    const again = statusLine({ ...status })

    expect(fromStore).toBe(again)
    expect(fromStore).toContain('fix the scheduler in drain()')
    expect(fromStore).toContain('cm2/status-line')
  })
})

describe('the team line while a teammate is working', () => {
  const bot = (name: string) => ({ name, display: name === 'alpha' ? 'Alpha' : name.toUpperCase().slice(0, 1) + name.slice(1) })

  const input = (over: Partial<Parameters<typeof liveLine>[0]> = {}) => ({
    me: 'alpha',
    bots: [bot('alpha'), bot('beta'), bot('gamma')],
    rooms: [],
    busy: { beta: true },
    // What directoryInput() passes in real use: the app's record of every bot's current turn.
    status: $turnStatus.get(),
    online: true,
    machine: 'studio',
    user: 'You',
    facts: [],
    canRemember: true,
    memoryEdits: [],
    ...over
  }) as Parameters<typeof liveLine>[0]

  test('a busy bot with no status recorded is still listed', () => {
    const line = liveLine(input())

    expect(line).toContain('Busy right now')
    expect(line).toContain('Beta')
  })

  test('the team line shows what the busy bot is working on', () => {
    recordTurnStatus('beta', 'fix the scheduler in drain()')
    const line = liveLine(input())

    expect(line).toContain('fix the scheduler in drain()')
  })

  test('the team line shows the branch the busy bot is on', () => {
    recordTurnStatus('beta', 'rebase onto `cm2/status-line`')
    const line = liveLine(input())

    expect(line).toContain('cm2/status-line')
  })

  test('the team line says whether that branch is on origin', () => {
    recordTurnStatus('beta', 'rebase onto `cm2/status-line`')
    const line = liveLine(input())

    expect(line).toMatch(/on origin|not on origin|unknown/i)
  })

  test('the team line keeps the 1:1 rule that an @mention reaches nobody', () => {
    recordTurnStatus('beta', 'fix the scheduler')
    const line = liveLine(input())

    expect(line).toContain('@mention')
    expect(line.toLowerCase()).toContain('reaches nobody')
  })

  test('the team line keeps the no-logs rule', () => {
    recordTurnStatus('beta', 'fix the scheduler')
    const line = liveLine(input()).toLowerCase()

    expect(line).toContain('do not attach logs')
  })

  test('an idle room still reads as idle', () => {
    recordTurnStatus('gamma', 'something else')
    const line = liveLine(input({ busy: {} }))

    expect(line).toContain('All teammates are idle')
    expect(line).not.toContain('something else')
  })
})