import { $connectError } from './lib/connection'
import { MISSING_AGENT } from './lib/install-help'
import { $providerNotice } from './lib/provider-notice'
// Design preview data (#chat / #room / #connect in the URL) — never used against a real Hermes.
import { $approvals } from './lib/approvals'
import { seedLibrary } from './lib/attachments'
import { type BotConfig, type ProviderOption, seedPreview } from './lib/botconfig'
import { $jobs } from './lib/background'
import { $chats } from './lib/chat'
import { $computerDemo } from './lib/computer-demo'
import { seedMemoryPreview, SHARED_KEY } from './lib/memory'
import { $routines, type Routine, seedRoutinesPreview } from './lib/routines'
import { $hooks } from './lib/event-routines'
import { setVoicePreview, voiceNoteText } from './lib/voice'
import { setTemplatesPreview } from './lib/templates'
import { seedSwitchNotes, setSessionModelPreview } from './lib/session-model'
import { machineProfileRows, seedMachines, setGroupByMachine } from './lib/hosts'
import { $pickerHotkey } from './ui/model-picker'
import { $recorderDemo } from './ui/voice'
import { gateway } from './lib/gateway'
import { $askCards } from './lib/ask'
import { $chatReactions, messageKeys } from './lib/reactions'
import { $demoFiles, $filePosts } from './lib/bot-files'
import { $openThread, $threadPosts } from './lib/threads'
import { $jumpTo, $searchPalette } from './lib/search'
import { $handoff, $helpCards } from './lib/handoff'
import { $rooms } from './lib/rooms'
import { $secretCards, $secretNames, savedNote } from './lib/secrets'
import { seedSelfEditNotes } from './lib/self-edit'
import { seedSharedPreview } from './lib/shared-folder'
import { $active, $panelOpen, $phase, $profiles, $selection, setBusy } from './lib/store'
import { directoryInput, directoryText, liveLine } from './lib/team'
import { $dialog } from './ui/dialogs'
import { $reactPicker } from './ui/thread'
import type { AskCard, ChatMsg, HelpCard, ProfileRow } from './lib/types'

const now = Date.now()

const row = (name: string, title: string, extra: Partial<ProfileRow> = {}, meta: Record<string, unknown> = {}): ProfileRow => ({
  name,
  model: 'gpt-5.1',
  ui_meta: { 'hermes-bots': { title, ...meta } },
  ...extra
})

const swatch = (from: string, to: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="360" height="240" fill="url(#g)"/></svg>`
  )}`

const toolsets = [
  ['web', 'Web search', 'Search the web and read pages.', 4, true],
  ['terminal', 'Terminal', 'Run shell commands in the working folder.', 2, true],
  ['file', 'Files', 'Read, write and edit files.', 5, true],
  ['browser', 'Browser', 'Drive a real browser.', 11, false],
  ['code_execution', 'Code execution', 'Run Python snippets in a sandbox.', 1, true],
  ['memory', 'Memory', 'Remember things across chats.', 2, true],
  ['vision', 'Vision', 'Look at pictures and screenshots.', 1, true],
  ['cronjob', 'Scheduled jobs', 'Run prompts on a schedule.', 1, true]
] as const

const skillNames = ['github-pr-review', 'web-research', 'summarize', 'pdf-reader', 'data-viz', 'sql-helper', 'writing-coach', 'release-notes', 'code-review', 'meeting-notes']

const config = (model: string, approvals: BotConfig['approvals']): BotConfig => ({
  model: { provider: 'openai', model },
  reasoning: 'medium',
  approvals,
  cwd: '~/projects',
  toolsetsPinned: true,
  toolsets: toolsets.map(([name, label, description, tool_count, enabled]) => ({ name, label, description, tool_count, enabled })),
  skills: skillNames.map((name, index) => ({ name, enabled: index % 4 !== 3 })),
  mcp: [
    { name: 'github', enabled: true, transport: 'stdio' },
    { name: 'hermes-bots-this-pc', enabled: true, transport: 'http' },
    { name: 'hermes-bots-groups', enabled: true, transport: 'http' },
    { name: 'notion', enabled: false, transport: 'http' }
  ]
})

/** A local time as Hermes reports it: ISO with this computer's UTC offset. */
function isoAt(daysFromToday: number, hour: number, minute = 0) {
  const at = new Date()
  at.setDate(at.getDate() + daysFromToday)
  at.setHours(hour, minute, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  const off = -at.getTimezoneOffset()

  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(hour)}:${pad(minute)}:00${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

const routine = (r: Partial<Routine> & Pick<Routine, 'id' | 'name' | 'schedule'>): Routine => ({
  prompt: '',
  deliver: 'bot-chat',
  repeat: 'forever',
  nextRunAt: '',
  lastRunAt: '',
  lastStatus: '',
  lastError: '',
  enabled: true,
  state: 'scheduled',
  ...r
})

const providers: ProviderOption[] = [
  { slug: 'openai', name: 'OpenAI', current: true, authenticated: true, models: ['gpt-5.1', 'gpt-5.1-mini', 'gpt-5', 'o4-mini', 'gpt-4.1'] },
  { slug: 'anthropic', name: 'Anthropic', current: false, authenticated: true, models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'] },
  { slug: 'minimax', name: 'MiniMax', current: false, authenticated: true, models: ['MiniMax-M3.1-Flash', 'MiniMax-M3.1', 'MiniMax-M2'], reasoning: { 'MiniMax-M3.1-Flash': true, 'MiniMax-M3.1': true, 'MiniMax-M2': false } },
  { slug: 'openrouter', name: 'OpenRouter', current: false, authenticated: false, models: ['meta-llama/llama-3.3-70b-instruct', 'qwen/qwen3-coder'] }
]

export function demo(raw: string) {
  // `chat-offline` previews the screen with the link down.
  const [view, flag = ''] = raw.split('-')

  if (view === 'connect') {
    // `connect-missing` previews the "Hermes Agent isn't installed" screen.
    if (flag === 'missing') {
      $connectError.set(`${MISSING_AGENT}: Hermes Agent isn't installed on this computer.`)
    }

    $phase.set('connect')

    return
  }

  // `chat-provider` previews the "no AI provider" notice.
  if (flag === 'provider') {
    $providerNotice.set(true)
  }

  $profiles.set([
    row('default', 'Nova', { path: '/home/you/.hermes', last_session: { id: 'x', last_active: now / 1000 - 300, preview: 'Morning! 3 PRs need review.' } }, { lead: true, description: 'Runs the team and hands work out.' }),
    row('scout', 'Scout', { path: '/home/you/.hermes/profiles/scout', last_session: { id: 'a', last_active: now / 1000 - 3600, preview: 'Found two competitors worth a look.' } }, { description: 'Digs up facts and sources.' }),
    row('forge', 'Forge', { path: '/home/you/.hermes/profiles/forge', last_session: { id: 'b', last_active: now / 1000 - 7200, preview: "Got it from Nova. I'll look after the repos." } }, { description: 'Reviews code and keeps the build green.' }),
    row('quill', 'Quill', { path: '/home/you/.hermes/profiles/quill', last_session: { id: 'c', last_active: now / 1000 - 9000, preview: 'Want a shorter version?' } }, { description: 'Drafts and polishes writing.' })
  ])
  // Shared memory about the user lives on the default profile, next to the group list.
  const lead = $profiles.get()[0]
  lead.ui_meta = {
    ...lead.ui_meta,
    [SHARED_KEY]: {
      facts: [
        { id: 's1', text: 'Name is Sam.', by: '', at: now - 9 * 86_400_000 },
        { id: 's2', text: 'Lives in Pune, India (IST, UTC+5:30). Works 10am to 7pm.', by: 'default', at: now - 8 * 86_400_000 },
        { id: 's3', text: 'Prefers short answers with the command first, explanation after.', by: 'default', at: now - 5 * 86_400_000 },
        { id: 's4', text: 'Runs a two-person design studio. Main client is Acme (acme/web repo).', by: 'scout', at: now - 3 * 86_400_000 },
        { id: 's5', text: 'Uses pnpm, never npm. Deploys with Vercel.', by: 'forge', at: now - 86_400_000 }
      ],
      seen: []
    }
  }
  const limits = { memory: 2200, user: 1375 }
  const enabled = { memory: true, user: true }
  seedMemoryPreview({
    default: {
      notes: [
        'Team: Scout researches, Forge owns repos and CI, Quill writes. Hand work out with message_agent.',
        'acme/web: main is protected. PRs need one review and green checks. Release branch is release/onboarding.',
        'Morning routine Sam likes: open PRs, failing checks, then inbox. Keep it to five bullets.',
        'The Q3 report lives in ~/projects/reports. Numbers come from customers.csv.'
      ],
      user: [
        'Lives in Pune, India (IST, UTC+5:30). Works 10am to 7pm.',
        'Prefers short answers with the command first, explanation after.',
        'Coffee chats on Fridays, so keep Friday afternoons free of meetings.'
      ],
      limits,
      enabled
    },
    scout: { notes: ['Good sources for design news: Sidebar, Smashing, Mobbin.'], user: ['Runs a two-person design studio. Main client is Acme (acme/web repo).'], limits, enabled },
    forge: { notes: ['CI is GitHub Actions. The flaky test is checkout.spec.ts.'], user: ['Uses pnpm, never npm. Deploys with Vercel.'], limits, enabled },
    quill: { notes: [], user: [], limits, enabled: { memory: true, user: false } }
  })
  // Next weekday and next Friday, for believable next-run times.
  const nextWeekday = [1, 1, 1, 1, 1, 3, 2][new Date().getDay()]
  const toFriday = (5 - new Date().getDay() + 7) % 7 || 7
  seedRoutinesPreview({
    default: [
      routine({
        id: 'r1',
        name: 'Morning brief',
        prompt: 'Check the acme/web PRs, failing checks and my inbox. Give me five bullets, most urgent first.',
        schedule: '0 9 * * 1-5',
        nextRunAt: isoAt(nextWeekday, 9),
        lastRunAt: isoAt(0, 9, 1),
        lastStatus: 'ok'
      }),
      routine({
        id: 'r2',
        name: 'Weekly PR digest',
        prompt: 'Summarize what merged in acme/web this week and what is still open, for the Friday wrap-up.',
        schedule: '0 17 * * 5',
        nextRunAt: isoAt(toFriday, 17),
        lastRunAt: isoAt(toFriday - 7, 17, 2),
        lastStatus: 'ok'
      }),
      routine({
        id: 'r3',
        name: 'Remind me to send the Acme invoice',
        prompt: 'Remind me to send the October invoice to Acme, with the amount from ~/projects/reports/invoices.csv.',
        schedule: 'once at 2026-10-09 18:00',
        repeat: 'once',
        nextRunAt: isoAt(2, 18)
      }),
      routine({
        id: 'r4',
        name: 'Competitor pricing check',
        prompt: 'Look at the pricing pages of our three main competitors and tell me if anything changed.',
        schedule: 'every 360m',
        enabled: false,
        state: 'paused',
        lastRunAt: isoAt(-2, 14, 5),
        lastStatus: 'error',
        lastError: 'The browser tool is off for this bot.'
      })
    ],
    forge: [routine({ id: 'r5', name: 'Nightly build check', prompt: 'Run the test suite on main and note any new failures.', schedule: '30 2 * * *', deliver: 'local', nextRunAt: isoAt(1, 2, 30), lastRunAt: isoAt(0, 2, 31), lastStatus: 'ok' })],
    scout: [],
    quill: []
  })
  seedSharedPreview('/home/you/.hermes/team-shared', [
    { name: 'screens', dir: true, ago: 26 * 3_600_000 },
    { name: 'screens/checkout-old.png', size: 214_880, mime: 'image/png', ago: 26 * 3_600_000 },
    {
      name: 'onboarding-competitors.md',
      ago: 2 * 3_600_000,
      text: '# Onboarding: what competitors do\n\nScout, for the Friday launch. Sources at the bottom.\n\n## Linear\n- Three steps: workspace, invite, first issue.\n- Every step can be skipped. Only the workspace name is required.\n\n## Notion\n- Asks what you will use it for, then picks a template.\n- Shows a checklist in the sidebar for the first week.\n\n## Figma\n- Drops you into a sample file with comments that teach the basics.\n\n## What we could borrow\n1. Make every step skippable.\n2. One sample project instead of an empty state.\n3. A short checklist that goes away after day 3.\n\nSources: linear.app/docs, notion.so/help, help.figma.com'
    },
    {
      name: 'launch-note-draft.md',
      ago: 40 * 60_000,
      text: '# New onboarding is here\n\nStarting Friday, new accounts get a three-step setup: name your workspace, invite your team, and start from a sample project.\n\nEvery step can be skipped, and a short checklist helps for the first few days.\n'
    },
    { name: 'customers.csv', ago: 5 * 86_400_000, mime: 'text/csv', text: 'name,plan,seats,signed_up\nAcme,team,12,2026-03-02\nGlobex,pro,4,2026-05-19\nInitech,team,9,2026-07-08\n' },
    { name: 'release-checklist.txt', ago: 3 * 3_600_000, mime: 'text/plain', text: '[x] checks green on release/onboarding\n[x] flaky checkout.spec.ts quarantined\n[ ] launch note approved by Sam\n[ ] tag v2.4 and deploy\n' }
  ])
  $active.set({ id: 'c', kind: 'ssh', label: 'My Hermes server', baseUrl: 'http://127.0.0.1:5123', token: '' })
  seedPreview(
    { default: config('gpt-5.1', 'smart'), scout: config('gpt-5.1-mini', 'manual'), forge: config('gpt-5.1', 'off'), quill: config('gpt-5.1-mini', 'manual') },
    providers
  )
  seedLibrary('bot:default', [
      { id: 'bot:default|p1', scope: 'bot:default', at: now - 3_000_000, kind: 'image', name: 'dashboard.png', thumb: swatch('#3b3b8f', '#14142b') },
      { id: 'bot:default|p2', scope: 'bot:default', at: now - 2_900_000, kind: 'image', name: 'logo-draft.jpg', thumb: swatch('#8f5a3b', '#2b1a14') },
      { id: 'bot:default|p3', scope: 'bot:default', at: now - 2_800_000, kind: 'image', name: 'chart.png', thumb: swatch('#2f7f63', '#10281f') },
      { id: 'bot:default|f1', scope: 'bot:default', at: now - 86_400_000, kind: 'file', name: 'Q3-report.pdf', size: 482_113 },
      { id: 'bot:default|f2', scope: 'bot:default', at: now - 90_000_000, kind: 'file', name: 'customers.csv', size: 18_204 }
  ])
  $rooms.set({
    'id:r1': {
      key: 'id:r1',
      name: 'Product launch',
      roomId: 'r1',
      members: [{ name: 'default' }, { name: 'scout' }, { name: 'forge' }, { name: 'quill' }],
      log: [
        { id: '1', at: now - 86_400_000, from: { kind: 'user', name: 'You' }, text: 'Morning team — we ship the new onboarding on Friday.' },
        { id: '2', at: now - 86_300_000, from: { kind: 'member', name: 'default' }, text: "Noted. Scout, can you pull what competitors say about their onboarding? Forge, are the checks green on the release branch?" },
        { id: '3', at: now - 86_200_000, from: { kind: 'member', name: 'scout' }, text: 'On it. I will bring back three examples with links.' },
        { id: '4', at: now - 86_100_000, from: { kind: 'member', name: 'forge' }, text: 'Green on `release/onboarding`. One flaky test, already retried.' },
        { id: '5', at: now - 7_000_000, from: { kind: 'user', name: 'You' }, text: '@Quill draft the launch note once Scout is back' },
        { id: '6', at: now - 6_900_000, from: { kind: 'member', name: 'quill' }, text: "Will do. I'll start with a short version and keep the tone friendly." }
      ]
    }
  })
  $chats.set({
    default: {
      loading: false,
      running: false,
      messages: [
        { id: 'u0', role: 'user', text: 'here are the numbers and the logo draft', at: now - 3_000_000, attachments: [
          { id: 'p1', kind: 'image', name: 'dashboard.png', thumb: swatch('#3b3b8f', '#14142b') },
          { id: 'f1', kind: 'file', name: 'Q3-report.pdf', size: 482_113 }
        ] },
        { id: 'a0', role: 'assistant', text: 'Thanks — I read the report. Revenue is up 12% and churn is flat.', at: now - 2_990_000 },
        { id: 'u1', role: 'user', text: 'what did you do this morning?', at: now - 900_000 },
        {
          id: 'a1',
          role: 'assistant',
          text: 'Checked the repos and the inbox. Three PRs need a review — `acme/web#42` is the urgent one.',
          at: now - 880_000,
          tools: [
            { id: 't1', name: 'terminal', label: 'gh pr list --state open', done: true },
            { id: 't2', name: 'web_search', label: 'competitor onboarding flows', done: true }
          ]
        },
        { id: 'u2', role: 'user', text: 'nice, ping Forge about it', at: now - 60_000 },
        { id: 'a2', role: 'assistant', text: 'On it — ', at: now - 50_000, streaming: true, tools: [{ id: 't3', name: 'send_message', label: 'forge', done: false }] }
      ]
    }
  })
  if (flag === 'jobs') {
    // `chat-jobs` previews helpers Nova handed work to.
    $jobs.set({
      default: [
        { id: 'j1', goal: 'Audit the 3 open PRs on acme/web and list blockers', status: 'running', note: 'gh pr diff 42', steps: 7, startedAt: now - 194_000 },
        { id: 'j2', goal: 'Draft the release notes for v2.4', status: 'done', note: 'Saved to ~/projects/notes/v2.4.md', steps: 4, startedAt: now - 400_000, endedAt: now }
      ]
    })
  }

  if (flag === 'working') {
    // `chat-working` previews a message sent while Nova is mid-reply.
    const chat = $chats.get().default
    $chats.set({
      default: {
        ...chat,
        running: true,
        messages: [...chat.messages, { id: 'u3', role: 'user', text: 'and cc Scout too', at: now - 20_000, midTurn: 'steered' }]
      }
    })
  }

  if (flag === 'memory') {
    // `chat-memory` opens Nova's memory in its settings.
    $dialog.set({ kind: 'bot-settings', name: 'default', section: 'memory' })
  }

  if (flag === 'eventroutine' || flag === 'eventroutines') {
    // `chat-eventroutine` opens the edit form of an event routine; `chat-eventroutines` the list with it.
    const list = $routines.get().default
    const event: Routine = {
      id: 'r9',
      name: 'Review new PRs',
      prompt: 'When a pull request is opened on acme/web, read the diff and post a short review summary: risks, missing tests, and whether it is ready.',
      schedule: 'every 52560000m',
      deliver: 'bot-chat',
      repeat: 'forever',
      nextRunAt: '',
      lastRunAt: new Date(now - 42 * 60_000).toISOString(),
      lastStatus: 'ok',
      lastError: '',
      enabled: true,
      state: 'scheduled'
    }
    $routines.set({ ...$routines.get(), default: [event, ...(Array.isArray(list) ? list : [])] })
    $hooks.set({
      port: 8648,
      lan: false,
      addresses: ['192.168.1.20'],
      running: true,
      error: '',
      hooks: [{ token: 'k3Jx9QwPz2LmV7tYb4Rn', bot: 'default', routineId: 'r9', kind: 'github', events: ['pull_request.opened', 'pull_request.merged'], hasSecret: true, lastFired: now - 42 * 60_000, lastEvent: 'pull_request.opened' }]
    })
    $dialog.set(flag === 'eventroutine' ? { kind: 'routine', name: 'default', back: true, edit: event } : { kind: 'bot-settings', name: 'default', section: 'routines' })
  }

  if (flag === 'routines') {
    // `chat-routines` opens Nova's routines in its settings.
    $dialog.set({ kind: 'bot-settings', name: 'default', section: 'routines' })
  }

  if (flag === 'newroutine') {
    // `chat-newroutine` opens the form for a new routine.
    $dialog.set({ kind: 'routine', name: 'default' })
  }

  if (flag === 'editroutine' || flag === 'editonce') {
    // `chat-editroutine` / `chat-editonce` open the edit form for a repeating / one-time routine, prefilled.
    const list = $routines.get().default
    const edit = Array.isArray(list) ? list.find(r => r.id === (flag === 'editonce' ? 'r3' : 'r1')) : undefined
    $dialog.set({ kind: 'routine', name: 'default', back: true, edit })
  }

  if (flag === 'brief') {
    // `chat-brief` shows a routine's result delivered into Nova's chat, and Nova's reply to it.
    const chat = $chats.get().default
    const at = new Date(isoAt(0, 9, 1)).getTime()
    $chats.set({
      default: {
        ...chat,
        running: false,
        messages: [
          ...chat.messages.filter(msg => msg.id !== 'u2' && msg.id !== 'a2'),
          {
            id: 'rr1',
            role: 'system',
            routine: 'Morning brief',
            at: Math.max(at, now - 40_000),
            text: '- **acme/web#42** (checkout fix) has 2 approvals and green checks. Ready to merge.\n- **acme/web#45** fails `checkout.spec.ts` again (flaky, retried twice).\n- 3 new emails need a reply: Acme invoice question, Vercel billing, Quill draft review.\n- No new issues overnight.\n- Release branch `release/onboarding` is 4 commits behind main.'
          },
          {
            id: 'ra1',
            role: 'assistant',
            at: Math.max(at, now - 40_000) + 20_000,
            text: 'Morning brief is in. The big one: **#42 is ready to merge**, and #45 is the flaky checkout test again, so I asked Forge to quarantine it. Three emails need you, the Acme invoice question first. Want me to draft replies?'
          }
        ]
      }
    })
  }

  if (flag === 'shared') {
    // `chat-shared` opens the shared memory about the user.
    $dialog.set({ kind: 'memory' })
  }

  if (flag === 'folder') {
    // `chat-folder` opens the team's shared folder; `chat-file` previews a file in it.
    $dialog.set({ kind: 'folder' })
  }

  if (flag === 'file') {
    $dialog.set({ kind: 'folder', open: 'onboarding-competitors.md' })
  }

  if (flag === 'post') {
    // `chat-post` shows Nova posting into a group from its 1:1 chat; `room-post` shows it landing there.
    const chat = $chats.get().default
    $chats.set({
      default: {
        ...chat,
        running: false,
        messages: [
          ...chat.messages.filter(msg => msg.id === 'u1' || msg.id === 'a1'),
          { id: 'u4', role: 'user', text: 'tell the launch group we are moving to Monday, and ask Forge to hold the release branch', at: now - 120_000 },
          {
            id: 'a4',
            role: 'assistant',
            text: 'Posted in **Product launch** and asked Forge there to hold `release/onboarding` until Monday. His answer will show up in the group.',
            at: now - 90_000,
            tools: [{ id: 't4', name: 'mcp__hermes_bots_groups__post_to_group', label: 'Product launch', done: true }]
          }
        ]
      }
    })
    const room = $rooms.get()['id:r1']
    $rooms.set({
      'id:r1': {
        ...room,
        log: [
          ...room.log,
          {
            id: '7',
            at: now - 110_000,
            from: { kind: 'member', name: 'default' },
            via: 'dm',
            text: "Change of plan from Sam: the onboarding launch moves to **Monday**. @Forge please hold `release/onboarding`, no merges until then. Quill's draft note is in /home/you/.hermes/team-shared/launch-note-draft.md."
          },
          { id: '8', at: now - 95_000, from: { kind: 'member', name: 'forge' }, text: 'Holding it. Branch protection is on until Monday 9am, and I moved the deploy job too.' }
        ]
      }
    })
  }

  if (flag === 'rename') {
    // `chat-rename` shows Nova renaming itself when asked, and the line the app adds; `team-rename` the Team view after.
    const lead = $profiles.get()[0]
    const meta = (lead.ui_meta?.['hermes-bots'] || {}) as Record<string, unknown>
    $profiles.set([{ ...lead, ui_meta: { ...lead.ui_meta, 'hermes-bots': { ...meta, title: 'Atlas', label: 'Research' } } }, ...$profiles.get().slice(1)])
    const asked = now - 70_000
    seedSelfEditNotes({ default: [{ id: 'se1', at: asked + 8_000, text: 'Nova changed its name to Atlas and its label to Research' }] })
    const chat = $chats.get().default
    $chats.set({
      default: {
        ...chat,
        running: false,
        messages: [
          ...chat.messages.filter(msg => msg.id === 'u1' || msg.id === 'a1'),
          { id: 'u5', role: 'user', text: "let's call you Atlas from now on, and put Research as your label", at: asked },
          {
            id: 'a5',
            role: 'assistant',
            text: "Done. I'm **Atlas** now, labelled Research. In groups the team reaches me as @atlas. My Hermes profile stays the same, so nothing else changes.",
            at: asked + 10_000,
            tools: [{ id: 't5', name: 'mcp__hermes_bots_groups__update_profile', label: 'Atlas', done: true }]
          }
        ]
      }
    })
  }

  if (flag === 'markdown' || flag === 'mdstream') {
    // `chat-markdown` shows a reply using every kind of Markdown; `chat-mdstream` one still arriving.
    const chart = swatch('#3b3b8f', '#0f2a3a')
    const full = [
      '## Launch checklist',
      '',
      'Here is where things stand for **Friday**. Most of it is *done*, the old date is ~~Thursday~~, and the flag is `onboarding_v2`. @forge owns the release, see https://github.com/acme/web/pull/42 or [the PR list](https://github.com/acme/web/pulls). Questions to <pat@acme.dev>.',
      '',
      '### Tasks',
      '',
      '- [x] Checks green on `release/onboarding`',
      '- [x] Flaky `checkout.spec.ts` quarantined',
      '- [ ] Launch note approved',
      '',
      '### Order of the day',
      '',
      '1. Freeze the branch',
      '2. Deploy to staging',
      '   - smoke test sign-up',
      '   - smoke test invites',
      '     - with a team of 1',
      '     - with a team of 12',
      '3. Tag `v2.4` and ship',
      '',
      '> Every step can be skipped. Only the workspace name is required.',
      '> — Scout, from the competitor notes',
      '',
      '| Step | Owner | Status | Started | Notes |',
      '| :--- | :---: | ---: | --- | --- |',
      '| Freeze | Forge | done | 09:10 | Branch protection on until Monday 9am, deploy job moved |',
      '| Staging | Forge | 80% | 10:30 | Sign-up flow passes, invites still running against the seeded team |',
      '| Note | Quill | draft | 11:00 | Two versions in the shared folder, Sam to pick one |',
      '',
      '```ts',
      "import { createFlag } from '@acme/flags'",
      '',
      '// Off for everyone until the tag is out.',
      "export const onboardingV2 = createFlag('onboarding_v2', { default: false, rollout: 0.25 })",
      '',
      'export async function steps(user: { id: string; teamSize: number }) {',
      "  return (await onboardingV2.on(user.id)) ? ['workspace', 'invite', 'sample'] : ['workspace']",
      '}',
      '```',
      '',
      '```bash',
      'git tag -a v2.4 -m "New onboarding" && git push origin v2.4',
      '```',
      '',
      'Expected activation lift, if the trial cohort holds: \\(\\Delta = p_{new} - p_{old} \\approx 0.12\\), with the interval',
      '',
      '$$',
      '\\hat{p} \\pm z_{0.975}\\sqrt{\\frac{\\hat{p}(1-\\hat{p})}{n}}',
      '$$',
      '',
      `![Activation chart](${chart})`,
      '',
      '---',
      '',
      'Raw HTML stays text: <script>alert("hi")</script>, and [this link](javascript:alert(1)) is not clickable.'
    ].join('\n')
    const chat = $chats.get().default
    const streaming = flag === 'mdstream'
    $chats.set({
      default: {
        ...chat,
        running: streaming,
        messages: [
          ...chat.messages.filter(msg => msg.id === 'u1' || msg.id === 'a1'),
          { id: 'u6', role: 'user', text: 'where are we with the launch? give me the full picture', at: now - 60_000 },
          streaming
            ? {
                id: 'a6',
                role: 'assistant',
                at: now - 50_000,
                streaming: true,
                text: '### Staging status\n\n| Step | Owner | Status |\n| --- | --- | --- |\n| Freeze | Forge | done |\n| Staging | For'
              }
            : { id: 'a6', role: 'assistant', at: now - 50_000, text: full }
        ]
      }
    })
  }

  if (flag === 'approval') {
    // `chat-approval` / `room-approval` preview approval cards: one waiting, the rest answered.
    const chat = $chats.get().default
    $chats.set({
      default: {
        ...chat,
        running: true,
        messages: chat.messages.map(msg =>
          msg.id === 'a2' ? { ...msg, text: 'Cleaning out the old build first.', tools: [{ id: 't3', name: 'terminal', label: 'rm -rf ~/projects/acme-web/dist', done: false }] } : msg
        )
      }
    })
    const base = { requestId: '', sessionId: 'demo', choices: ['once', 'session', 'always', 'deny'] as const }
    $approvals.set([
      { ...base, id: 'ap1', bot: 'default', scope: 'bot:default', kind: 'command', command: 'rm -rf build', description: 'Recursive delete', choices: [...base.choices], status: 'once', at: now - 870_000 },
      { ...base, id: 'ap2', bot: 'default', scope: 'bot:default', kind: 'pc', command: "click 'Empty Trash' at (812, 604)", description: 'Uses your mouse and keyboard.', choices: [...base.choices], status: 'deny', at: now - 860_000 },
      { ...base, id: 'ap3', bot: 'default', scope: 'bot:default', kind: 'command', command: 'rm -rf ~/projects/acme-web/dist', description: 'Recursive delete', choices: [...base.choices], status: 'pending', at: now - 40_000 },
      { ...base, id: 'ap4', bot: 'forge', scope: 'bot:forge', kind: 'command', command: 'git push --force origin release/onboarding', description: 'Force push', choices: [...base.choices], status: 'pending', at: now - 20_000 },
      { ...base, id: 'ap5', bot: 'scout', scope: 'room:r1', kind: 'pc', command: "type 'onboarding competitors' in Chrome", description: 'Uses your mouse and keyboard.', choices: [...base.choices], status: 'pending', at: now - 10_000 },
      { ...base, id: 'ap6', bot: 'forge', scope: 'room:r1', kind: 'command', command: 'npm publish', description: 'Publish a package', choices: [...base.choices], status: 'session', at: now - 6_800_000 }
    ])
  }

  if (flag === 'pcask') {
    // `chat-pcask` previews This PC approvals: a screenshot ran without asking, a click waits for an answer.
    const chat = $chats.get().default
    $chats.set({
      default: {
        ...chat,
        running: true,
        messages: [
          ...chat.messages.filter(msg => !msg.streaming && msg.id !== 'u2').map(msg => ({ ...msg, at: Math.min(msg.at, now - 120_000) })),
          { id: 'pc1', role: 'user', at: now - 9_000, text: 'Empty the trash on my PC, then rename the new report to Q3.docx' },
          {
            id: 'pc2',
            role: 'assistant',
            at: now - 8_000,
            text: 'Taking a look at your screen first.',
            tools: [
              { id: 'pct1', name: 'mcp__hermes_bots_this_pc__computer_screenshot', label: '', done: true },
              { id: 'pct2', name: 'mcp__hermes_bots_this_pc__computer_key', label: '', done: true },
              { id: 'pct3', name: 'mcp__hermes_bots_this_pc__computer_click', label: '', done: false }
            ]
          }
        ]
      }
    })
    const pc = { requestId: '', sessionId: 'demo', bot: 'default', scope: 'bot:default', kind: 'pc' as const, server: 'hermes-bots-this-pc', choices: ['once' as const, 'session' as const, 'deny' as const] }
    $approvals.set([
      { ...pc, id: 'pa1', action: 'key', command: 'Press win+e', description: 'Presses keys on your keyboard.', status: 'session', at: now - 7_000 },
      { ...pc, id: 'pa2', action: 'key', command: 'Press ctrl+a', description: 'Presses keys on your keyboard.', status: 'session', auto: true, at: now - 6_000 },
      { ...pc, id: 'pa3', action: 'type', command: 'Type "Q3.docx"', description: 'Types with your keyboard.', status: 'deny', note: 'control is off', at: now - 5_000 },
      { ...pc, id: 'pa4', action: 'click', command: 'Right-click at (812, 604)', description: 'Clicks with your mouse.', status: 'pending', at: now - 1_000 }
    ])
  }

  if (flag === 'reactions' || flag === 'reactpicker') {
    // `chat-reactions` / `room-reactions` preview reactions (a bot's react-only reply, the user's on a bot
    // message, several in a group); `chat-reactpicker` the emoji picker open on Nova's message.
    const chat = $chats.get().default
    const keep = chat.messages.filter(msg => msg.id === 'u1' || msg.id === 'a1').map(msg => (msg.id === 'u1' ? { ...msg, ref: 'umorning1' } : msg))
    const messages: ChatMsg[] = [
      ...keep,
      { id: 'u5', ref: 'uthanks01', role: 'user', text: "perfect, thanks — I'll review #42 after lunch", at: now - 40_000 },
      { id: 'a5', role: 'assistant', text: '', at: now - 38_000, tools: [{ id: 't9', name: 'mcp__hermes_bots_groups__react_to_message', label: '', done: true }] }
    ]
    $chats.set({ default: { ...chat, running: false, messages } })
    const keys = messageKeys(messages)
    $chatReactions.set({
      'bot:default': {
        'ref:uthanks01': { default: '🙏' },
        ...(flag === 'reactions' ? { [keys.get('a1') as string]: { user: '👍' } } : {})
      }
    })
    const room = $rooms.get()['id:r1']
    const extra: Record<string, Record<string, string>> = { '1': { default: '👍', forge: '🚀' }, '4': { user: '🎉', default: '🎉', scout: '✅' }, '6': { user: '❤️' } }
    $rooms.set({ 'id:r1': { ...room, log: room.log.map(entry => (extra[entry.id] ? { ...entry, reactions: extra[entry.id] } : entry)) } })

    if (flag === 'reactpicker') {
      $reactPicker.set('a1')
    }
  }

  if (flag === 'ask' || flag === 'askanswered') {
    // `chat-ask` / `room-ask` preview a bot's question card (ask_user), `chat-askanswered` it answered.
    const chat = $chats.get().default
    const asked = now - 30_000
    const answered = flag === 'askanswered'
    const keep = chat.messages.filter(msg => msg.id === 'u1' || msg.id === 'a1')
    const card: AskCard = {
      id: 'q1',
      at: asked,
      prompt: 'Which PR should I review first?',
      options: [
        { label: 'acme/web#42', description: 'Checkout fix · blocking the release', style: 'primary' },
        { label: 'acme/web#40', description: 'Dark mode tweaks' },
        { label: 'acme/api#17', description: 'Rate limiter refactor' },
        { label: 'Close all three', value: 'Close all three PRs', style: 'danger' }
      ],
      allowCustom: true,
      status: answered ? 'answered' : 'open',
      ...(answered ? { picked: ['acme/web#42'] } : {})
    }
    $chats.set({
      default: {
        ...chat,
        running: false,
        messages: [
          ...keep,
          { id: 'u6', role: 'user', text: 'review one of them now', at: asked - 8_000 },
          ...(answered
            ? [
                { id: 'u7', role: 'user' as const, text: 'acme/web#42', at: asked + 6_000 },
                { id: 'a7', role: 'assistant' as const, text: 'On it — reviewing **acme/web#42** now. I will post my comments on the PR and tell you here when it is done.', at: asked + 9_000 }
              ]
            : [])
        ]
      }
    })
    $askCards.set({ 'bot:default': [card] })
    const room = $rooms.get()['id:r1']
    $rooms.set({
      'id:r1': {
        ...room,
        log: [
          ...room.log,
          {
            id: 'q2',
            at: now - 20_000,
            from: { kind: 'member', name: 'quill' },
            text: 'Launch note tone?',
            ask: { id: 'q2', at: now - 20_000, prompt: 'Which tone should the launch note use?', options: [{ label: 'Friendly' }, { label: 'Formal' }, { label: 'Playful' }, { label: 'Short & factual' }], multi: true, status: 'open' }
          }
        ]
      }
    })
  }

  if (flag === 'secret' || flag === 'secretsaved') {
    // `chat-secret` previews a bot's secret request card, `chat-secretsaved` it saved (and the bot told),
    // `room-secret` the group's pointer. Values never shown.
    const chat = $chats.get().default
    const asked = now - 40_000
    const saved = flag === 'secretsaved'
    $chats.set({
      default: {
        ...chat,
        running: false,
        messages: [
          { id: 'u8', role: 'user', text: 'can you check our OpenAI usage for this month?', at: asked - 10_000 },
          { id: 'a8', role: 'assistant', text: "Sure. I don't have an OpenAI key yet, so I've asked for one below. It goes straight into my settings; I never see it.", at: asked - 2_000 },
          ...(saved
            ? [
                { id: 'u9', role: 'user' as const, text: savedNote('OPENAI_API_KEY'), at: asked + 20_000 },
                { id: 'a9', role: 'assistant' as const, text: 'Got it, thanks. This month so far: **$41.20** across 1.8M tokens, mostly `gpt-5.1` (82%).', at: asked + 28_000 }
              ]
            : [])
        ]
      }
    })
    $secretCards.set({
      'bot:default': [
        {
          id: 'k1',
          at: asked,
          name: 'OPENAI_API_KEY',
          label: 'OpenAI API key',
          description: 'Needed to read usage from the OpenAI API. Create one at platform.openai.com → API keys (read-only is enough).',
          status: saved ? 'saved' : 'open'
        }
      ]
    })
    $secretNames.set({
      default: { loading: false, names: [{ name: 'OPENROUTER_API_KEY', custom: false }, ...(saved ? [{ name: 'OPENAI_API_KEY', custom: false }] : []), { name: 'STRIPE_READONLY_KEY', custom: true }] }
    })
    const room = $rooms.get()['id:r1']
    $rooms.set({
      'id:r1': {
        ...room,
        log: [
          ...room.log,
          { id: 'k2', at: now - 15_000, from: { kind: 'member', name: 'forge' }, text: '(Asked the user for GITHUB_TOKEN in a private 1:1 card)', secretAsk: { name: 'GITHUB_TOKEN', label: 'GitHub token' } }
        ]
      }
    })
  }

  if (flag === 'handoff') {
    // `chat-handoff` previews a sign-in handoff card; `room-handoff` the group's pointer;
    // `computer-handoff` the large view with the handoff banner (Done / Can't do it).
    const chat = $chats.get().default
    const asked = now - 25_000
    const card: HelpCard = { id: 'h1', at: asked, instruction: 'Sign in to GitHub and approve the 2FA prompt on your phone.', url: 'https://github.com/login', doneLabel: 'Done', status: 'open' }
    $chats.set({
      default: {
        ...chat,
        running: false,
        messages: [
          { id: 'u10', role: 'user', text: 'open a PR on acme/web with the onboarding copy fixes', at: asked - 30_000 },
          { id: 'a10', role: 'assistant', text: "GitHub wants a fresh sign-in with 2FA on my computer, which I can't do. I've left the login page open for you.", at: asked - 2_000 }
        ]
      }
    })
    $helpCards.set({ 'bot:default': [card], 'bot:scout': [card] })
    const room = $rooms.get()['id:r1']
    $rooms.set({
      'id:r1': {
        ...room,
        log: [...room.log, { id: 'h2', at: now - 15_000, from: { kind: 'member', name: 'scout' }, text: '(Handed my screen to the user)', helpAsk: { instruction: 'Solve the captcha on the competitor pricing page.' } }]
      }
    })

    if (view === 'computer') {
      $handoff.set({ bot: 'scout', card, pending: false })
    }
  }

  if (flag === 'thread' || flag === 'threadpane' || flag === 'search' || flag === 'searchjump') {
    // `room-thread` / `chat-thread` show a root with "N replies"; `-threadpane` opens the thread pane.
    const t = now - 40 * 60_000
    const digest =
      '**Morning digest — 3 things**\n\n1. **Signups** up 18% week over week, mostly from the new onboarding.\n2. **Support**: 4 tickets about the pricing page FAQ; drafted answers are in the shared folder.\n3. **Competitors**: Acme shipped a free tier yesterday; pricing notes in `competitors.md`.'
    const room = $rooms.get()['id:r1']
    $rooms.set({
      'id:r1': {
        ...room,
        log: [
          ...room.log,
          { id: 'th1', at: t, from: { kind: 'member', name: 'default' }, text: 'Morning digest is ready — details in the thread so this room stays short.' },
          { id: 'th2', at: t + 20_000, from: { kind: 'member', name: 'default' }, text: digest, threadOf: 'th1' },
          { id: 'th3', at: t + 9 * 60_000, from: { kind: 'user', name: 'You' }, text: '@Scout is the Acme free tier usage-capped?', threadOf: 'th1' },
          { id: 'th4', at: t + 10 * 60_000, from: { kind: 'member', name: 'scout' }, text: 'Yes: 3 projects and 1k events/month, then it asks for a card. Notes added to `competitors.md`.', threadOf: 'th1', reactions: { user: '🙏' } },
          { id: 'th5', at: t + 25 * 60_000, from: { kind: 'member', name: 'forge' }, text: 'Release branch is green again; shipping the onboarding fix at 4.' }
        ]
      }
    })
    const chat = $chats.get().default
    $chats.set({
      default: {
        ...chat,
        running: false,
        messages: [
          { id: 'u21', ref: 'u21abcd', role: 'user', text: 'can you summarize the launch retro notes?', at: t - 60_000 },
          { id: 'a21', role: 'assistant', text: 'Done. Short version: the onboarding launch went well, two follow-ups. Full notes are in the thread.', at: t, tools: [] },
          { id: 'u22', ref: 'u22abcd', role: 'user', text: 'who owns the docs follow-up?', at: t + 5 * 60_000, thread: 'u21abcd' },
          { id: 'a22', role: 'assistant', text: 'Quill. Due Friday; I put it on the launch checklist.', at: t + 5 * 60_000 + 8_000, tools: [] },
          { id: 'u23', ref: 'u23abcd', role: 'user', text: 'thanks! what else is on today?', at: t + 20 * 60_000 },
          { id: 'a23', role: 'assistant', text: 'Two reviews and the 3pm sync with Forge.', at: t + 20 * 60_000 + 6_000, tools: [] }
        ]
      }
    })
    $threadPosts.set({
      'bot:default': [{ id: 'tp1', at: t + 10_000, root: 'u21abcd', text: '**Retro notes**\n\n- Went well: checks stayed green, rollout in 2 steps.\n- Follow-ups: docs for the new flag (Quill), flaky test owner (Forge).' }]
    })

    if (flag === 'search') {
      // `room-search`: the palette open on a query that hits a group, a thread reply and a 1:1 chat.
      sessionStorage.setItem('search:last', 'onboarding')
      $searchPalette.set(true)
    }

    if (flag === 'searchjump') {
      // `room-searchjump`: what Enter on a thread-reply result does: the thread opens and the reply flashes.
      document.body.dataset.demoFlash = ''
      $openThread.set({ scope: 'room:r1', root: 'th1' })
      setTimeout(() => $jumpTo.set({ scope: 'room:r1', id: 'th4', at: Date.now() }), 300)
    }

    if (flag === 'threadpane') {
      $openThread.set(view === 'room' ? { scope: 'room:r1', root: 'th1' } : { scope: 'bot:default', root: 'u21abcd' })
    }
  }

  if (flag === 'machines' || flag === 'machinesgrouped' || flag === 'machinesettings') {
    // `chat-machines`: bots from three machines in the sidebar (one offline); `chat-machinesettings`: Settings > Machines.
    seedMachines(
      [
        { id: '', label: 'AWS Hermes VM', kind: 'ssh', where: 'ubuntu@203.0.113.10', state: 'online', main: true },
        { id: 'hboffice', label: 'Office Mac', kind: 'remote', where: 'mac-studio.local:9119', state: 'online', main: false },
        { id: 'hbhomelab', label: 'Home lab', kind: 'ssh', where: 'user@192.168.1.40', state: 'offline', error: "Can't reach 192.168.1.40", main: false }
      ],
      {
        hboffice: [
          row('pixel', 'Pixel', { last_session: { id: 'p', last_active: now / 1000 - 600, preview: 'Exported the new icon set.' } }, { description: 'Design and assets.', color: '#f59e0b' }),
          row('ledger', 'Ledger', { last_session: { id: 'l', last_active: now / 1000 - 5400, preview: 'Invoices are reconciled.' } }, { description: 'Bookkeeping.', color: '#22c55e' })
        ],
        hbhomelab: [row('relay', 'Relay', { last_session: { id: 'r', last_active: now / 1000 - 86_400, preview: 'Backups ran at 3am.' } }, { description: 'Home server chores.', color: '#38bdf8' })]
      },
      'hboffice'
    )
    $profiles.set([...$profiles.get(), ...machineProfileRows()])
    if (flag === 'machinesettings') $dialog.set({ kind: 'settings' })
    else if (location.hash.includes('grouped')) setGroupByMachine(true)
  }

  if (flag === 'model' || flag === 'roommodel') {
    // `chat-model`: the model picker open in a 1:1 chat after a switch; `room-roommodel`: per-bot picks in a group.
    setSessionModelPreview(true)
    seedSwitchNotes(
      {
        'bot:default': [{ id: 'ms1', at: now - 4 * 60_000, text: 'Switched to MiniMax-M3.1-Flash' }],
        'room:r1': [{ id: 'ms2', at: now - 2 * 60_000, text: 'Forge switched to claude-sonnet-4-5' }]
      },
      { 'bot:default': { provider: 'minimax', model: 'MiniMax-M3.1-Flash', reasoning: 'low' }, 'room:r1:forge': { provider: 'anthropic', model: 'claude-sonnet-4-5' } }
    )
    setTimeout(() => $pickerHotkey.set($pickerHotkey.get() + 1), 400)
  }

  if (flag === 'export' || flag === 'import') {
    // `chat-export`: Export as template for Nova; `chat-import`: the import preview of a shared template.
    setTemplatesPreview(true)
    ;(window as any).__demoMcp = {
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_' + 'Q'.repeat(36) } },
      linear: { url: 'https://mcp.linear.app/sse', headers: { Authorization: 'Bearer lin_api_' + 'z'.repeat(32) } }
    }
    if (flag === 'export') {
      $dialog.set({ kind: 'export-template', name: 'default' })
    } else {
      $dialog.set({
        kind: 'import-template',
        template: {
          format: 'hermes-bot-template',
          version: 1,
          exportedAt: '2026-10-09T18:30:00Z',
          app: 'NexurBots',
          bot: { name: 'pr-reviewer', display: 'Reviewer', label: 'Code review', description: 'Reviews every PR on acme/web: risks, missing tests, a verdict.', shape: 'blobatar:reviewer:ghost' },
          persona: { soul: 'You review pull requests. Be specific and kind. Lead with risks.' },
          model: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', reasoning: 'high' },
          approvals: 'smart',
          toolsets: { pinned: true, enabled: ['terminal', 'file', 'web', 'browser'] },
          skills: { enabled: ['github-pr-review', 'release-notes', 'changelog'], disabled: [], bundled: [{ name: 'release-notes', files: [{ path: 'SKILL.md', text: '---\nname: release-notes\n---\n' }] }] },
          mcpServers: {
            github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' }, enabled: true },
            linear: { url: 'https://mcp.linear.app/sse', headers: { Authorization: 'Bearer ${MCP_LINEAR_TOKEN}' }, enabled: true }
          },
          routines: [
            { name: 'Review new PRs', prompt: 'Review the PR in the event.', trigger: { kind: 'github', events: ['pull_request.opened'] } },
            { name: 'Weekly PR digest', prompt: 'Summarise the week of PRs.', trigger: { kind: 'schedule', schedule: '0 17 * * 5' } }
          ],
          requiredSecrets: [
            { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GITHUB_PERSONAL_ACCESS_TOKEN', usedBy: 'github (env)' },
            { name: 'MCP_LINEAR_TOKEN', label: 'MCP_LINEAR_TOKEN', usedBy: 'linear header' }
          ]
        }
      })
    }
  }

  if (flag === 'voice' || flag === 'voicerecord') {
    // `chat-voice`: a voice note (with transcript) and a bot's spoken reply; `chat-voicerecord`: the recorder.
    setVoicePreview(true)
    const tone = (seconds: number) => {
      const rate = 8000
      const n = rate * seconds
      const buf = new Uint8Array(44 + n)
      const view = new DataView(buf.buffer)
      const put = (o: number, t: string) => [...t].forEach((c, i) => buf[o + i] = c.charCodeAt(0))
      put(0, 'RIFF'); view.setUint32(4, 36 + n, true); put(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
      view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true); put(36, 'data'); view.setUint32(40, n, true)
      for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(40 * Math.sin((i / rate) * 2 * Math.PI * 220) * Math.abs(Math.sin((i / rate) * 3)))
      let bin = ''
      buf.forEach(b => (bin += String.fromCharCode(b)))
      return { url: 'data:audio/wav;base64,' + btoa(bin), blob: new Blob([buf], { type: 'audio/wav' }) }
    }
    const memo = { path: '/home/you/.hermes/team-shared/voice-memos/voice-memo-default-demo.wav', name: 'voice-memo-default-demo.wav', size: 96_044, mime: 'audio/wav', voice: true, seconds: 12 }
    $demoFiles.set({ [memo.path]: tone(12).url })
    const note = tone(7)
    const att = { id: 'vn1', kind: 'file' as const, name: 'voice-note-2026-10-10T01-58-12.webm', mime: 'audio/webm', size: 41_220 }
    seedLibrary('bot:default', [{ ...att, scope: 'bot:default', at: now - 90_000, ref: att.name, blob: note.blob }])
    const chat = $chats.get().default
    $chats.set({
      default: {
        ...chat,
        running: false,
        messages:
          flag === 'voice'
            ? [
                { id: 'u21', role: 'user', text: voiceNoteText('Can you check why the deploy failed last night and tell me if it is safe to retry?'), at: now - 90_000, attachments: [att] },
                { id: 'a21', role: 'assistant', text: '', at: now - 60_000, tools: [{ id: 't21', name: 'mcp__hermes_bots_groups__send_voice_memo', label: '', done: true }] },
                { id: 'a22', role: 'assistant', text: 'Here is the full log summary in text too: the **migration step timed out** after 10 minutes on `orders_2026`. Nothing was half-applied.', at: now - 20_000 }
              ]
            : chat.messages
      }
    })
    if (flag === 'voice') {
      $filePosts.set({
        'bot:default': [
          { id: 'fv1', at: now - 50_000, caption: "The deploy failed because the database migration timed out on the orders table. Nothing was half applied, so it's safe to retry. I'd run it tonight after 11, when traffic is low.", files: [memo] }
        ]
      })
    }
    if (flag === 'voicerecord') $recorderDemo.set(true)
  }

  if (flag === 'files') {
    // `chat-files` / `room-files` preview files bots sent (send_file): an inline chart, documents with Download / Open.
    const chart =
      'data:image/svg+xml;base64,' +
      btoa(
        `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#ffffff"/>` +
          `<text x="32" y="44" font-family="Arial" font-size="20" font-weight="700" fill="#111">Signups per week</text>` +
          `<text x="32" y="68" font-family="Arial" font-size="13" fill="#777">Last 8 weeks - new onboarding shipped in week 6</text>` +
          [120, 135, 128, 150, 162, 230, 268, 291].map((v, i) => `<rect x="${48 + i * 70}" y="${320 - v}" width="44" height="${v}" rx="6" fill="${i >= 5 ? '#5b8def' : '#c9d6f2'}"/>`).join('') +
          `<line x1="32" y1="320" x2="608" y2="320" stroke="#ddd"/></svg>`
      )
    const files = {
      chart: { path: '/home/you/.hermes/team-shared/signups-weekly.svg', name: 'signups-weekly.svg', size: 2_314, mime: 'image/svg+xml' },
      pdf: { path: '/home/you/.hermes/team-shared/Q3-growth-report.pdf', name: 'Q3-growth-report.pdf', size: 1_284_113, mime: 'application/pdf' },
      csv: { path: '/home/you/.hermes/team-shared/signups.csv', name: 'signups.csv', size: 18_204, mime: 'text/csv' },
      xlsx: { path: '/home/you/.hermes/team-shared/launch-budget.xlsx', name: 'launch-budget.xlsx', size: 48_930, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    }
    $demoFiles.set({ [files.chart.path]: chart })
    const chat = $chats.get().default
    const t = now - 60_000
    $chats.set({
      default: {
        ...chat,
        running: false,
        messages: [
          { id: 'u11', role: 'user', text: 'how did signups do since the new onboarding? send me a chart and the report', at: t - 20_000 },
          { id: 'a11', role: 'assistant', text: '', at: t, tools: [{ id: 't11', name: 'mcp__hermes_bots_groups__send_file', label: '', done: true }] }
        ]
      }
    })
    $filePosts.set({
      'bot:default': [
        { id: 'f1', at: t + 1_000, caption: 'Signups are up **~90%** since week 6, when the new onboarding shipped.', files: [files.chart] },
        { id: 'f2', at: t + 2_000, caption: 'Full report and the raw numbers:', files: [files.pdf] },
        { id: 'f3', at: t + 3_000, files: [files.csv] }
      ]
    })
    const room = $rooms.get()['id:r1']
    $rooms.set({
      'id:r1': {
        ...room,
        log: [
          ...room.log,
          { id: 'fg1', at: now - 30_000, from: { kind: 'user', name: 'You' }, text: '@Forge @Scout where are we on budget and signups?' },
          { id: 'fg2', at: now - 25_000, from: { kind: 'member', name: 'forge' }, text: 'Budget sheet with the launch costs so far — we are 8% under.', files: [files.xlsx] },
          { id: 'fg3', at: now - 20_000, from: { kind: 'member', name: 'scout' }, text: 'Signups chart for the last 8 weeks:', files: [files.chart] }
        ]
      }
    })
  }

  if (view === 'computer') {
    // `computer` previews the Computer tab (bot sandbox), `computer-open` its large view (`computer-openhold`
    // with the hold-Esc-to-close hint part-way; `computer-hover` / `computer-thispchover` the preview as if hovered);
    // `computer-thispc` / `computer-thispcopen` the same for This PC. Stills stand in for the screens.
    const pc = flag.startsWith('thispc')
    $computerDemo.set({
      mode: pc ? 'thispc' : 'sandbox',
      open: flag === 'open' || flag === 'openhold' || flag === 'thispcopen' || flag === 'handoff',
      hold: flag === 'openhold',
      hover: flag === 'hover' || flag === 'thispchover',
      screen: pc ? windowsShot() : xfceShot(),
      width: pc ? 1920 : 1280,
      height: pc ? 1080 : 800
    })
  }

  $panelOpen.set(true)
  $selection.set(view === 'chat' ? { kind: 'bot', id: 'default' } : view === 'computer' ? { kind: 'bot', id: 'scout' } : view === 'room' ? { kind: 'room', id: 'id:r1' } : null)
  $phase.set('app')

  if (view === 'team') {
    // `team` previews the Team view; `team-prompt` logs what Nova would be sent.
    gateway.state.set('open')
    setBusy('scout', true)
    $selection.set({ kind: 'bot', id: 'default' })
    $dialog.set({ kind: 'team' })

    if (flag === 'prompt') {
      const input = directoryInput('default')
      console.log(`${directoryText(input)}\n${liveLine(input)}`)
    }
  }

  if (flag === 'offline') {
    gateway.state.set('reconnecting')
    gateway.retrying.set({ attempt: 3, nextAt: Date.now() + 9000, trying: false, error: 'Could not reach 34.230.12.8 — the connection timed out' })
  }
}

const svg = (body: string, w: number, h: number) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="DejaVu Sans, Segoe UI, sans-serif">${body}</svg>`)}`

/** A stand-in for the bot's Xfce desktop (1280x800): a browser window on a blue desktop. */
function xfceShot() {
  return svg(
    `<defs><linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d3b5c"/><stop offset="1" stop-color="#0d1a2b"/></linearGradient></defs>
<rect width="1280" height="800" fill="url(#d)"/>
<rect width="1280" height="28" fill="#2b2b2b"/><text x="12" y="19" fill="#ddd" font-size="13">Applications</text><text x="1180" y="19" fill="#ddd" font-size="13">10:24</text>
<g transform="translate(120 70)"><rect width="1040" height="660" rx="6" fill="#fafafa"/><rect width="1040" height="38" rx="6" fill="#e6e6e6"/>
<circle cx="20" cy="19" r="6" fill="#ff5f57"/><circle cx="40" cy="19" r="6" fill="#febc2e"/><circle cx="60" cy="19" r="6" fill="#28c840"/>
<rect x="90" y="8" width="860" height="22" rx="11" fill="#fff"/><text x="106" y="24" fill="#555" font-size="13">linear.app/docs/onboarding</text>
<text x="60" y="110" fill="#111" font-size="34" font-weight="700">Onboarding, step by step</text>
<text x="60" y="150" fill="#666" font-size="16">Three steps: create a workspace, invite your team, file your first issue.</text>
<rect x="60" y="190" width="290" height="180" rx="10" fill="#eef1ff"/><rect x="375" y="190" width="290" height="180" rx="10" fill="#eefaf3"/><rect x="690" y="190" width="290" height="180" rx="10" fill="#fff4e8"/>
<text x="80" y="225" fill="#334" font-size="18" font-weight="600">1. Workspace</text><text x="395" y="225" fill="#334" font-size="18" font-weight="600">2. Invite</text><text x="710" y="225" fill="#334" font-size="18" font-weight="600">3. First issue</text>
<rect x="60" y="400" width="920" height="14" rx="7" fill="#e3e3e3"/><rect x="60" y="430" width="760" height="14" rx="7" fill="#e3e3e3"/><rect x="60" y="460" width="840" height="14" rx="7" fill="#e3e3e3"/><rect x="60" y="490" width="620" height="14" rx="7" fill="#e3e3e3"/></g>
<rect y="772" width="1280" height="28" fill="#2b2b2b"/><rect x="560" y="777" width="160" height="18" rx="4" fill="#444"/>`,
    1280,
    800
  )
}

/** A stand-in for the last This PC screenshot (1920x1080): a Windows-like desktop with Explorer open. */
function windowsShot() {
  return svg(
    `<defs><linearGradient id="w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b3d91"/><stop offset="1" stop-color="#5a8de0"/></linearGradient></defs>
<rect width="1920" height="1080" fill="url(#w)"/>
<g transform="translate(360 150)"><rect width="1200" height="720" rx="8" fill="#202020"/><rect width="1200" height="44" rx="8" fill="#2b2b2b"/>
<text x="20" y="28" fill="#eee" font-size="16">File Explorer — Documents</text>
<rect x="0" y="44" width="240" height="676" fill="#191919"/>
${['Home', 'Desktop', 'Downloads', 'Documents', 'Pictures'].map((n, i) => `<text x="24" y="${90 + i * 36}" fill="#ccc" font-size="15">${n}</text>`).join('')}
${['Q3 report draft.docx', 'Invoices', 'Acme proposal.pdf', 'notes.txt', 'Budget 2026.xlsx'].map((n, i) => `<rect x="270" y="${74 + i * 48}" width="900" height="40" rx="4" fill="${i === 0 ? '#2f4a6e' : '#242424'}"/><text x="290" y="${100 + i * 48}" fill="#eee" font-size="15">${n}</text>`).join('')}</g>
<rect y="1032" width="1920" height="48" fill="#1c1c1c"/><rect x="900" y="1040" width="32" height="32" rx="6" fill="#3b82f6"/><text x="1820" y="1062" fill="#eee" font-size="15">10:24</text>`,
    1920,
    1080
  )
}
