'use strict'
/**
 * The communication contract: how a bot reaches a teammate, and when a group member
 * answers. These are behavioural tests — they drive the app's own scheduling with a
 * fake gateway and assert on what it dispatched and stored.
 *
 * The bug this pins down: a bot that says "Scout will take it" in prose hands
 * nothing over. Only a real @mention dispatches, so a plain name is never a
 * transport, and the prompts must say so with the exact text a bot should send.
 */
const assert = require('node:assert/strict')
const { afterEach, test } = require('node:test')

const { rooms, team, store, profile, fakeGateway, roster, bots, directory, settle, forgetDirectory } = require('./helpers/bot-team-app.cjs')

let active = null

afterEach(() => {
  if (active) {
    active.restore()
    active = null
  }

  rooms.$rooms.set({})
})

function crew({ replies = [], settings = { reply: 'everyone', maxTurns: 6 } } = {}) {
  active = fakeGateway({ replies })
  roster([bots.kacy, bots.scout])

  return rooms.createRoom('test-crew', ['default', 'scout'], settings)
}

// ── the plain-name handoff ────────────────────────────────────────────────

test('a member that names a teammate in prose wakes nobody; only a real @mention does', async () => {
  const room = crew({ replies: ['(pass)', 'Sure — Scout will take it.'] })
  rooms.postToRoom(room.key, 'who can check the log?')
  await settle()
  const talked = active.seen.submits.filter(submit => submit.profile === 'scout')

  assert.equal(talked.length, 1, 'Scout was selected for the open-ended question and may answer it')
  const last = rooms.$rooms.get()[room.key].log.at(-1)

  assert.match(last.text, /Scout will take it/)
  assert.equal(
    active.seen.submits.filter(submit => submit.profile === 'scout').length,
    1,
    'Scout must not be woken again by her own message naming herself in prose'
  )
})

test('naming a teammate in prose still lets that teammate be woken later by a real @mention', async () => {
  const room = crew({ replies: ['(pass)', 'Sure — Scout will take it.'] })
  rooms.postToRoom(room.key, 'who can check the log?')
  await settle()
  rooms.postToRoom(room.key, '@scout can you check the log?')
  await settle()
  const scoutTurns = active.seen.submits.filter(submit => submit.profile === 'scout')

  assert.equal(scoutTurns.length, 2, 'the explicit mention is what dispatches Scout a second time')
  assert.match(scoutTurns[1].text, /@scout can you check the log\?/)
})

test('a group prompt tells the bot which @mention dispatches, and that a plain name does not', async () => {
  const room = crew({ replies: ['Checking'] })
  rooms.postToRoom(room.key, 'who can check the log?')
  await settle()
  const prompt = active.seen.submits[0].text

  assert.match(prompt, /@scout/)
  assert.match(prompt, /Scout/)
  assert.match(
    prompt,
    /writing Scout|plain name|name alone/,
    'the prompt must say a bare name is not a handoff, or bots keep narrating instead of dispatching'
  )
})

test('the handoff prompt names the exact @handle of each teammate, not a shared alias', async () => {
  const room = crew({ replies: ['(pass)'] })
  rooms.postToRoom(room.key, '@scout hello')
  await settle()
  const prompt = active.seen.submits.find(submit => submit.profile === 'scout').text

  assert.match(prompt, /@scout/, 'Scout answers to @scout here')
  assert.doesNotMatch(
    prompt,
    /@hermes/,
    '@hermes is the private-chat target, never a group @handle; promising it sends bots to a bot that cannot hear them'
  )
})

test('the default bot is addressed as its own group handle, not as the private-chat target', async () => {
  forgetDirectory()
  const room = crew({ replies: ['(pass)'] })
  rooms.postToRoom(room.key, '@kacy hello')
  await settle()
  const prompt = active.seen.submits.find(submit => submit.profile === 'default').text

  assert.match(prompt, /You are Kacy \(@kacy here\)/, 'Kacy answers to @kacy in the group')
})

test('the group prompt repeats the rule on the turn where a bot is woken to answer next', async () => {
  const room = crew({ replies: ['(pass)', 'Sure, Scout will take it.'] })
  rooms.postToRoom(room.key, 'who can check the log?')
  await settle()
  const [kacy, scout] = active.seen.submits
  assert.ok(kacy && scout)
  assert.match(
    scout.text,
    /You were addressed directly|pick it up|Nobody was addressed/,
    'Scout must know why she is speaking and who, if anyone, acts next'
  )
})

test('a real @mention from a member dispatches the teammate as a handoff, not an interjection', async () => {
  const room = crew({ replies: ['(pass)', 'Kacy, can you post the release note? @kacy'] })
  rooms.postToRoom(room.key, 'who can check the log?')
  await settle()
  const kacyTurns = active.seen.submits.filter(submit => submit.profile === 'default')

  assert.equal(kacyTurns.length, 2, 'the @kacy handoff must reach the default profile')
  assert.match(kacyTurns[1].text, /handed this to you|pick it up|addressed directly/)
})

// ── pass vs. answer ───────────────────────────────────────────────────────

test('a member that replies (pass) posts nothing and wakes nobody', async () => {
  const room = crew({ replies: ['(pass)', '(pass)'] })
  rooms.postToRoom(room.key, 'who can check the log?')
  await settle()
  const log = rooms.$rooms.get()[room.key].log
  const botPosts = log.filter(entry => entry.from.kind === 'member')

  assert.deepEqual(botPosts, [], '(pass) is not a message')
})

test('a member that says nothing new and passes still leaves the member that spoke alone in the log', async () => {
  const room = crew({ replies: ['(pass)', 'Log is clean: nothing from 14:00.'] })
  rooms.postToRoom(room.key, 'who can check the log?')
  await settle()
  const memberPosts = rooms.$rooms.get()[room.key].log.filter(entry => entry.from.kind === 'member')

  assert.equal(memberPosts.length, 1)
  assert.equal(memberPosts[0].text, 'Log is clean: nothing from 14:00.')
})

test('a member woken with nobody addressed is told to stay silent when it has nothing new', async () => {
  const room = crew({ replies: ['(pass)'] })
  rooms.postToRoom(room.key, 'who can check the log?')
  await settle()
  assert.match(active.seen.submits[0].text, /\(pass\)/)
})

test('an @mention wakes only that bot, even with "everyone replies" on', async () => {
  const room = crew({ replies: ['(pass)'] })
  rooms.postToRoom(room.key, '@scout what did you find?')
  await settle()

  assert.equal(active.seen.submits.filter(submit => submit.profile === 'scout').length, 1)
  assert.equal(active.seen.submits.filter(submit => submit.profile === 'default').length, 0)
})

// ── the private-chat target ───────────────────────────────────────────────

test('the directory tells a bot the private-message target for the default profile', () => {
  roster([bots.kacy, bots.scout])
  const text = directory('scout')

  assert.match(text, /message_agent/)
  assert.match(text, /hermes/, 'the default profile is addressed as "hermes" for a private message')
})

test('the directory separates each bot\'s group handle from its private target', () => {
  roster([bots.kacy, bots.scout])

  const own = directory('default')

  assert.match(own, /You are Kacy \(\@kacy in a group, private target "hermes"\)/, 'the default profile has two different addresses, not one')

  const other = directory('scout')

  assert.match(other, /Reach a teammate: Kacy — \@kacy in a group, private target "hermes"/, 'a teammate learns both addresses for Kacy')
  assert.doesNotMatch(other, /Reach a teammate:[^\n]*Scout/, 'the line routes teammates, not the reader itself')
})

test('the directory is explicit that a private handoff needs the tool, not a name in prose', () => {
  roster([bots.kacy, bots.scout])
  const text = directory('default')

  assert.match(text, /message_agent/)
  assert.match(
    text,
    /does not|never|only/,
    'the directory must rule out prose as a transport'
  )
})

test('the directory says what to hand over: the task, the shared paths, and the result', () => {
  roster([bots.kacy, bots.scout])
  const text = directory('default', { sharedFolder: '/home/user/.hermes/team-shared' })

  assert.match(text, /team-shared/)
  assert.match(text, /path/i)
  assert.match(
    text,
    /result|what you (want|finds)|reply/i,
    'a handoff must say what is being asked for, so the reply lands'
  )
})

test('the directory tells a bot not to ping-pong acknowledgements with a teammate', () => {
  roster([bots.kacy, bots.scout])
  const text = directory('default')

  assert.match(
    text,
    /ack|thank|confirm|back and forth|ping-pong|loop/i,
    'bots otherwise answer "thanks" forever'
  )
})

test('the directory tells a bot a queued message is not a delivered one', () => {
  roster([bots.kacy, bots.scout])
  const text = directory('default')

  assert.match(text, /queue/i)
})

test('the directory never quotes anyone\'s private 1:1 chat as group material', () => {
  roster([bots.kacy, bots.scout])
  const text = directory('default')

  assert.match(text, /private/i)
  assert.match(text, /never see|don't see|only what they need/i)
})

test('the directory offers no routine or group-post instructions when those tools are off', () => {
  roster([bots.kacy, bots.scout])
  const text = directory('default', { canSchedule: false, appTools: false })

  assert.doesNotMatch(text, /cronjob_manage/)
  assert.doesNotMatch(text, /post_to_group/)
})

test('the directory names the group-post tool and the exact group names when app tools are on', () => {
  const room = crew({ replies: ['(pass)'] })
  const text = directory('scout', { appTools: true })

  assert.match(text, /post_to_group/)
  assert.match(text, /test-crew/)
  assert.ok(room, 'the room exists, so the directory lists a real group')
})

// ── identity stays data-driven ────────────────────────────────────────────

test('group handles come from the roster, so a renamed bot answers to its own handle', () => {
  active = fakeGateway()
  roster([
    { ...bots.kacy },
    {
      name: 'scout',
      display_name: 'Scout',
      ui_meta: { 'hermes-bots': { title: 'Scout', custom: true } }
    }
  ])
  const room = rooms.createRoom('test-crew', ['default', 'scout'], { reply: 'mentions' })
  const found = rooms.mentionedIn('hey @scout and @kacy', rooms.roomBots(rooms.$rooms.get()[room.key]))

  assert.deepEqual(found.map(bot => bot.name).sort(), ['default', 'scout'])
})

// ── what must keep working ────────────────────────────────────────────────

test('a quiet member stays silent on an unaddressed message and answers when mentioned', async () => {
  const room = crew({ replies: ['(pass)', 'Here it is.'] })
  rooms.setQuiet(room.key, 'scout', true)
  rooms.postToRoom(room.key, 'anyone see the log?')
  await settle()
  assert.equal(active.seen.submits.filter(submit => submit.profile === 'scout').length, 0, 'quiet means silent unless named')
  rooms.postToRoom(room.key, '@scout see the log?')
  await settle()
  assert.equal(active.seen.submits.filter(submit => submit.profile === 'scout').length, 1, 'and an @mention still reaches it')
})

test('a member the user paused with a sticky "@bot stop" is not woken by another bot handing it work', async () => {
  // A turn-mode stop only interrupts that one turn, so the hold has to be sticky to survive.
  const room = crew({ replies: ['(pass)', 'Done.'], settings: { reply: 'everyone', maxTurns: 6, stop: 'sticky' } })
  rooms.postToRoom(room.key, '@scout stop')
  await settle()
  assert.deepEqual(active.seen.submits.filter(submit => submit.profile === 'scout'), [], 'the stop itself wakes nobody')
  rooms.postToRoom(room.key, 'who can check the log?')
  await settle()
  assert.equal(active.seen.submits.filter(submit => submit.profile === 'scout').length, 0, 'a sticky hold outranks a handoff')
})

test('a plain "@bot stop" in default mode only interrupts that turn, so the next message reaches it again', async () => {
  const room = crew({ replies: ['(pass)', '(pass)', '(pass)'] })
  rooms.postToRoom(room.key, '@scout stop')
  await settle()
  rooms.postToRoom(room.key, 'status?')
  await settle()
  assert.equal(active.seen.submits.filter(submit => submit.profile === 'scout').length, 1, 'a turn-mode stop is not a pause')
})

test('the group turn limit still caps a chain of handoffs', async () => {
  const room = crew({ replies: ['@scout check it', '@kacy post it', 'any more?'] })
  rooms.postToRoom(room.key, 'ship it')
  await settle(1500)
  assert.ok(active.seen.submits.length <= 6, `turns must stay within the room's cap, saw ${active.seen.submits.length}`)
})

test('only the Lead speaks when the group is set to lead-only and nobody is named', async () => {
  const room = crew({ replies: ['(pass)'], settings: { reply: 'lead', maxTurns: 4 } })
  rooms.postToRoom(room.key, 'status?')
  await settle()
  assert.deepEqual([...new Set(active.seen.submits.map(submit => submit.profile))], ['default'])
})

test('nothing at all is dispatched in a mentions-only group when nobody is named', async () => {
  const room = crew({ replies: ['(pass)'], settings: { reply: 'mentions', maxTurns: 4 } })
  rooms.postToRoom(room.key, 'status?')
  await settle()
  assert.deepEqual(active.seen.submits, [])
})

test('a group prompt states that 1:1 chats are private and must not be quoted', async () => {
  const room = crew({ replies: ['(pass)'] })
  rooms.postToRoom(room.key, 'status?')
  await settle()
  assert.match(active.seen.submits[0].text, /not anyone'?s private 1:1 chats/)
})

test('a bot posts into a group from its 1:1 chat only when app tools are on, and the mention there dispatches', async () => {
  const room = crew({ replies: ['(pass)'] })
  const listed = rooms.listGroupsText('scout')

  assert.match(listed, /test-crew/)
  assert.match(listed, /Kacy \(\@kacy\)/, 'the group address is the handle, not the private target')

  const posted = rooms.postFromBot('scout', 'test-crew', 'Release note is ready. @kacy can you post it?')

  assert.equal(posted.ok, true, posted.text)
  await settle()
  assert.equal(active.seen.submits.filter(submit => submit.profile === 'default').length, 1, 'the @kacy in a 1:1 group post dispatches')
})

test('a bot cannot post into a group it is not a member of', () => {
  crew({ replies: [] })
  const posted = rooms.postFromBot('scout', 'no-such-group', 'hello')

  assert.equal(posted.ok, false)
})

test('the directory keeps the shared folder an absolute path a teammate can open', () => {
  roster([bots.kacy, bots.scout])
  const text = directory('scout', { sharedFolder: '/home/user/.hermes/team-shared' })

  assert.match(text, /\/home\/user\/\.hermes\/team-shared/)
  assert.match(text, /give the full path/i)
})

test('the directory does not claim work continues when the app is closed', () => {
  roster([bots.kacy, bots.scout])
  const text = directory('scout', { online: false })

  assert.doesNotMatch(text, /when the app is closed|always running|runs even/i)
})

// ── a group session has no private tool, so it must not be told to use one ──

test('a group prompt never tells a bot to reach a teammate with message_agent', async () => {
  forgetDirectory()
  const room = crew({ replies: ['(pass)'] })
  rooms.postToRoom(room.key, 'status?')
  await settle()
  const prompt = active.seen.submits[0].text
  const groupPart = prompt.slice(0, prompt.indexOf('[Group chat'))

  assert.doesNotMatch(
    groupPart,
    /(call|use|invoke|try) message_agent/i,
    'the group session has no message_agent; instructing a call there makes bots try a tool they cannot make'
  )
  assert.match(groupPart, /@scout/, 'the group route is an @mention and nothing else')
})

test('a group prompt says a private tool is not available here and names the group route instead', async () => {
  forgetDirectory()
  const room = crew({ replies: ['(pass)'] })
  rooms.postToRoom(room.key, 'status?')
  await settle()
  const prompt = active.seen.submits[0].text

  assert.match(prompt, /message_agent is not available|not available in a group|only in your 1:1/i)
  assert.match(prompt, /@mention/i)
})

test('a 1:1 turn still offers the private handoff, so the tool is only withheld where it is missing', async () => {
  roster([bots.kacy, bots.scout])
  const text = directory('default')

  assert.match(text, /message_agent/, 'the private route is real and must stay')
  assert.match(text, /1:1|outside any group/i)
})

test('the group directory does not advertise a nonmember as a reachable handoff target', async () => {
  forgetDirectory()
  const room = crew({ replies: ['(pass)'] })
  roster([bots.kacy, bots.scout, profile('scribe', 'Scribe')])
  rooms.postToRoom(room.key, '@scout status?')
  await settle()
  const prompt = active.seen.submits.find(submit => submit.profile === 'scout').text
  const directoryPart = prompt.slice(0, prompt.indexOf('[Group chat'))
  const reach = directoryPart.split('\n').find(line => line.startsWith('Reach a teammate:'))

  assert.ok(reach, 'the current room must still offer an actionable handoff route')
  assert.match(reach, /Kacy/)
  assert.doesNotMatch(reach, /Scribe|@scribe/, 'roster awareness is not room membership')
  assert.match(directoryPart, /Scribe/, 'nonmembers remain known in the full team roster')
  assert.equal(active.seen.submits.some(submit => submit.profile === 'scribe'), false)
})

test('a teammate who shares a different group is still not a route in this one', async () => {
  forgetDirectory()
  const room = crew({ replies: ['(pass)'] })
  roster([bots.kacy, bots.scout, profile('scribe', 'Scribe')])
  // Scribe and the reader, Scout, share another group; that says nothing about this room.
  rooms.createRoom('other-crew', ['scout', 'scribe'], { reply: 'mentions' })
  rooms.postToRoom(room.key, '@scout status?')
  await settle()
  const prompt = active.seen.submits.find(submit => submit.profile === 'scout').text
  const directoryPart = prompt.slice(0, prompt.indexOf('[Group chat'))
  const reach = directoryPart.split('\n').find(line => line.startsWith('Reach a teammate:'))

  assert.ok(reach, 'the current room still offers its own members')
  assert.match(directoryPart, /Your groups:.*other-crew/, 'the reader really belongs to the second group')
  assert.match(reach, /Kacy/)
  assert.doesNotMatch(reach, /Scribe|@scribe/, 'sharing some other group is not membership here')
  assert.match(
    directoryPart,
    /private Bot Chat|a group you share/,
    'an outside-room teammate still needs a route that really works'
  )
})

test('mentioning an unknown name dispatches nobody', () => {
  const room = rooms.createRoom('test-crew', ['default', 'scout'], { reply: 'mentions' })
  const found = rooms.mentionedIn('hey @nobody', rooms.roomBots(rooms.$rooms.get()[room.key]))

  assert.deepEqual(found, [])
})