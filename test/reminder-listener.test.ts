/**
 * Tier reminders against a real booted agent loop.
 *
 * The decision core is covered in `reminder.test.ts`; these tests put the
 * listener in the loop and assert what the session and the model actually
 * receive — the durable reminder rows, whether a step is owed one at all, and
 * what a compaction inside the waterfall does to a pending reminder. The
 * compaction cases mount the real `dsh-compaction-basic` backend rather than
 * writing a summary's durable shape by hand, because the reminder machinery's
 * interaction with the compaction waterfall is exactly what is under test.
 *
 * @module test/reminder-listener
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'

import * as ContextSense from '../lib/index.js'
import { CONTEXT_READING_TOOL_NAME } from '../lib/reading-tool.js'
import { decideTierReminder, resolveReminderPolicy } from '../lib/reminder.js'
import {
  CONTEXT_SENSE_KEY,
  isSampleAttributedTo,
  pressureTierSectionName,
  type ContextSenseState,
} from '../lib/session-state.js'
import { CAPACITY_SECTION_NAME as CAPACITY_STATEMENT_SECTION } from '../lib/statement.js'
import { assembleFor, capacitySections } from './capacity-statement.js'
import { bootMinimalContext, type MinimalContext } from './minimal-context.js'
import { MODEL, PROVIDER, ScriptedAdapter, takeTurn } from './scripted-provider.js'
import { pressureOf } from './token-projections.js'

/** A capacity small enough that the scripted provider's figures reach a tier within a turn or two. */
const CAPACITY = 1_000

/** Two tiers the scripted provider's figures cross, in order, over the first few turns. */
const TIERS = [0.05, 0.1]

/** The section name the notice tier's reminder is recorded under. */
const NOTICE_SECTION = pressureTierSectionName(0)

/** The section name the imminent tier's reminder is recorded under. */
const IMMINENT_SECTION = pressureTierSectionName(1)

/** The reminder configuration every test starts from, unless it says otherwise. */
function reminderConfig(options: { tiers?: readonly number[]; enabled?: boolean } = {}) {
  return {
    reminders: {
      enabled: options.enabled ?? true,
      tiers: [...(options.tiers ?? TIERS)],
      compactionThresholdRatio: 0.8,
    },
  }
}

/** One tier reminder as the durable log holds it. */
interface CommittedReminder {
  readonly section: string
  readonly text: string
}

/**
 * Every tier reminder this plugin has committed to a session, in log order.
 *
 * The durable log — not the surface — is what a tier's firing is reconstructed
 * from, so a reminder a compaction has since replaced still counts as spoken.
 * @param session - the session to read.
 * @returns one entry per committed reminder section.
 */
function committedReminders(session: Session): CommittedReminder[] {
  const reminders: CommittedReminder[] = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind !== 'plugin' || source.plugin !== ContextSense.name || source.form !== 'snapshot') continue
    for (const section of source.sections) reminders.push({ section: section.name, text: section.text })
  }
  return reminders
}

/** The section names of every reminder a session has committed, in order. */
function reminderSections(agent: Agent): string[] {
  return committedReminders(agent.session).map((reminder) => reminder.section)
}

/** The plugin-attributed messages one assembled request carried to the provider. */
function remindersInRequest(adapter: ScriptedAdapter, index: number): string[] {
  const request = adapter.requests[index]
  if (request === undefined) throw new Error(`the loop assembled no request at index ${index}`)
  return request.messages
    .filter((message) => message.source.kind === 'plugin' && message.source.plugin === ContextSense.name)
    .map((message) => message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''))
}

/** The plugin's own durable memory of one session. */
function stateOf(ctx: Context, agent: Agent): ContextSenseState {
  const state = ctx.sessionProjections.stateOf(agent.session, CONTEXT_SENSE_KEY)
  if (state === undefined) throw new Error('the plugin registered no session memory')
  return state
}

/** One booted loop with tier reminders configured, and the agent it serves. */
interface ReminderLoop extends MinimalContext {
  readonly agent: Agent
  readonly adapter: ScriptedAdapter
  /** The plugin's fiber, so a test can unload it mid-session. */
  readonly fiber: { dispose(): Promise<void> }
}

describe('tier reminders in a booted agent loop', () => {
  let booted: ReminderLoop | undefined

  afterEach(async () => {
    await booted?.dispose()
    booted = undefined
  })

  /**
   * Boot the loop with reminders configured and one agent ready to take turns.
   * @param options - the route capacity (`'none'` for a route advertising none), the tiers, whether reminders are on, how to mount compaction, and listeners to register ahead of the plugin.
   * @returns the booted loop, its agent, its plugin fiber and the scripted provider that recorded the requests.
   */
  async function boot(
    options: {
      capacity?: number | 'none'
      tiers?: readonly number[]
      enabled?: boolean
      compaction?: 'auto' | 'manual'
      before?: (ctx: Context) => void
    } = {},
  ): Promise<ReminderLoop> {
    const context = await bootMinimalContext()
    const adapter = new ScriptedAdapter(options.capacity === 'none' ? undefined : (options.capacity ?? CAPACITY))
    context.ctx.llm.registerAdapter([PROVIDER], adapter)
    if (options.compaction === 'auto') {
      // The backend's own step-boundary listener, which is what a deployment
      // runs: the threshold is set low enough that this route crosses it.
      await context.ctx.plugin(BasicCompactionEngine, { retainRatio: 0.02, thresholdRatio: 0.1 })
    } else if (options.compaction === 'manual') {
      // The listener is left off, so a test can compact an idle session itself.
      await context.ctx.plugin(BasicCompactionEngine, { auto: false, retainRatio: 0.02, thresholdRatio: 0.1 })
    }
    options.before?.(context.ctx)
    const fiber = context.ctx.plugin(ContextSense, reminderConfig(options))
    await fiber
    const agent = await context.harness.create(SessionId('agent-1'), { provider: PROVIDER, model: MODEL })
    return (booted = { ...context, agent, adapter, fiber })
  }

  /**
   * Compact an idle session between turns, the way the `/compact` command does.
   *
   * The backend refuses a compaction outside an open turn, so a summary that is
   * meant to happen between two steps goes through this rather than through the
   * backend's own step-boundary listener.
   * @param ctx - the context the backend is mounted on.
   * @param agent - the idle agent whose session to compact.
   * @returns whether the backend found a range worth compacting.
   */
  async function compactIdleSession(ctx: Context, agent: Agent): Promise<boolean> {
    return (await compactionEngine(ctx).compactNow(agent, new AbortController().signal)) !== null
  }

  /** The mounted basic compaction backend. */
  function compactionEngine(ctx: Context) {
    const engine = ctx.get('compaction') as BasicCompactionEngine | undefined
    if (engine === undefined) throw new Error('the basic compaction backend is not mounted')
    return engine
  }

  it('makes no reminder while nothing has measured the session', async () => {
    const { ctx, agent, adapter } = await boot()

    // The only pre-step this turn runs is the session's first, and no provider
    // has reported usage yet — so there is no ratio, and no tier decision.
    await takeTurn(agent, 'the first step of this session')

    expect(reminderSections(agent)).toEqual([])
    // The premise of the assertion above: pressure does exist afterwards, so
    // the absence was the missing sample rather than a session that measured
    // nothing at all.
    expect(pressureOf(ctx, agent)).toBeGreaterThan(0)
    expect(remindersInRequest(adapter, 0)).toEqual([])
  })

  it('makes no reminder while the route advertises no capacity', async () => {
    const { ctx, agent } = await boot({ capacity: 'none' })

    await takeTurn(agent, 'first')
    await takeTurn(agent, 'second')
    await takeTurn(agent, 'third')

    // A provider sample exists, so the pressure figure is real — but no recorded
    // route has advertised a denominator, and no ratio can be formed from one
    // figure alone.
    expect(pressureOf(ctx, agent)).toBeGreaterThan(0)
    expect(agent.session.requestContext()?.contextWindow).toBeUndefined()
    expect(reminderSections(agent)).toEqual([])
  })

  it('delivers the reached tier to the session and to the model, once', async () => {
    const { ctx, agent, adapter } = await boot()

    await takeTurn(agent, 'the first step of this session')
    // The second turn's pre-step is the first that can act: the first turn
    // committed the provider usage sample the ratio is formed from.
    await takeTurn(agent, 'a second step')

    const pressure = pressureOf(ctx, agent)
    expect(pressure).toBeTypeOf('number')
    expect(pressure! / CAPACITY).toBeGreaterThanOrEqual(TIERS[0]!)

    const reminders = committedReminders(agent.session)
    expect(reminders.map((reminder) => reminder.section)).toContain(NOTICE_SECTION)
    const notice = reminders.find((reminder) => reminder.section === NOTICE_SECTION)!
    expect(notice.text).toContain('<system-reminder>')
    expect(notice.text).toContain('5% tier')
    expect(notice.text).toContain('tier 1 of 2')

    // The human reading the transcript sees the row, and the model saw the
    // same text in the request that carried it.
    const visible = agent.session.deriveMessages()
    expect(
      visible.some((message) => message.source.kind === 'plugin' && message.source.plugin === ContextSense.name),
    ).toBe(true)
    // The reminder decided at this turn's pre-step is committed with the step
    // and rides the request that step sends, so the model reads it immediately.
    expect(adapter.requests).toHaveLength(2)
    expect(remindersInRequest(adapter, 1)).toContain(notice.text)
  })

  it('speaks a reached tier once, however many further steps follow', async () => {
    const { ctx, agent } = await boot()

    await takeTurn(agent, 'first')
    const afterFirst = pressureOf(ctx, agent)!
    // Both configured tiers are already reached by the first measured figure,
    // so the steps below have every reason to repeat themselves.
    expect(afterFirst / CAPACITY).toBeGreaterThanOrEqual(TIERS[1]!)

    await takeTurn(agent, 'second')
    await takeTurn(agent, 'third')
    await takeTurn(agent, 'fourth')
    await takeTurn(agent, 'fifth')

    // Not once per crossing — which the lagging projection could not tell apart
    // from "already above" — but once per epoch, in ascending order.
    expect(reminderSections(agent)).toEqual([NOTICE_SECTION, IMMINENT_SECTION])
  })

  it('reminds at the following pre-step for a tier only the current step’s own message crossed', async () => {
    // A capacity that puts the tier between two consecutive steps' figures: the
    // scripted provider reports ten more prompt tokens per visible message, so
    // consecutive figures land at 0.131 and 0.161 of this window.
    const capacity = 1_000
    const tier = 0.15
    const { ctx, agent } = await boot({ capacity, tiers: [tier] })

    await takeTurn(agent, 'the first step')
    const beforeCrossing = pressureOf(ctx, agent)!
    await takeTurn(agent, 'the step whose own message crosses the tier')

    // The crossing is not visible to the step that causes it: the projection
    // folds committed events, and this step's message is still unclaimed.
    expect(reminderSections(agent)).toEqual([])

    const afterCrossing = pressureOf(ctx, agent)!
    await takeTurn(agent, 'the following step')

    // The premise of the lag assertion, from the harness's own figures rather
    // than from the plugin's: the tier really does sit between the two steps.
    expect(beforeCrossing / capacity).toBeLessThan(tier)
    expect(afterCrossing / capacity).toBeGreaterThanOrEqual(tier)
    // And the reminder arrives at the following pre-step, not never.
    expect(reminderSections(agent)).toEqual([NOTICE_SECTION])
  })

  it('makes the tier eligible again after a summary compaction', async () => {
    const { ctx, agent } = await boot({ compaction: 'manual' })

    await takeTurn(agent, 'first')
    await takeTurn(agent, 'second')
    expect(reminderSections(agent)).toEqual([NOTICE_SECTION])
    expect(stateOf(ctx, agent).epoch).toBe(0)

    expect(await compactIdleSession(ctx, agent)).toBe(true)
    expect(stateOf(ctx, agent).epoch).toBe(1)

    await takeTurn(agent, 'third')

    // The summary opened a new reminder epoch, so the notice is owed again —
    // a fresh warning earned by a compaction, not a repeat of the old one.
    expect(reminderSections(agent)).toEqual([NOTICE_SECTION, NOTICE_SECTION])
  })

  it('does not re-arm a tier for a prune, which opens no epoch', async () => {
    const { ctx, agent } = await boot({ tiers: [TIERS[0]!] })

    await takeTurn(agent, 'first')
    await takeTurn(agent, 'second')
    expect(reminderSections(agent)).toEqual([NOTICE_SECTION])

    // The durable shape a model-free prune commits: a log-only record plus a
    // replacement of one surface node by a smaller copy. Written by hand
    // because what is under test is the epoch rule, not the pruner's policy —
    // and the assertion below is about the epoch, not about what the prune did
    // to the pressure figure.
    const pruned = agent.session.surface.nodes.find(
      (seq) => agent.session.eventAt(seq)?.type === 'user/message',
    )!
    agent.session.append('compaction/prune', {
      shadowedRange: { start: pruned, end: pruned },
      shadowedSeqs: [pruned],
      shadowedTokenCount: 10,
    })
    agent.session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'a smaller copy' }], source: { kind: 'user' } }),
      { surfaceOp: { op: 'replace', startSeq: pruned, endSeq: pruned }, sourceEventSeqs: [pruned] },
    )

    expect(stateOf(ctx, agent).epoch).toBe(0)
    await takeTurn(agent, 'third')
    await takeTurn(agent, 'fourth')

    // Still the one notice this epoch has: the prune bought it no fresh warning.
    expect(reminderSections(agent)).toEqual([NOTICE_SECTION])
  })

  it('drops a pending reminder when the mounted backend compacts inside the same waterfall', async () => {
    const { ctx, agent } = await boot({ tiers: [TIERS[0]!], compaction: 'manual' })

    // Registered AHEAD of the plugin, which prepends itself — so this listener
    // is downstream: it runs inside the plugin's `await next()`, after the
    // reminder was decided and before it was injected. It commits a real
    // summary compaction through the mounted backend, over everything on the
    // surface but the system prompt the backend refuses to rewrite.
    ctx.on('agent/pre-step', async ({ agent: stepping, signal }, next) => {
      const nodes = stepping.session.surface.nodes.filter(
        (seq) => stepping.session.eventAt(seq)?.type !== 'system/message',
      )
      const start = nodes[0]
      const end = nodes.at(-1)
      if (start !== undefined && end !== undefined) {
        await compactionEngine(ctx).compactRegion(start, end, stepping, signal)
      }
      return next()
    })

    // Enough committed text that the backend's summary is genuinely smaller
    // than the span it replaces, which is what makes the compaction legal.
    await takeTurn(agent, 'a first step carrying enough text to be worth summarising. '.repeat(60))

    // The premise: this step's own figure crosses the notice tier, so the
    // listener really did have a reminder to decide before `next()`.
    expect(pressureOf(ctx, agent)! / CAPACITY).toBeGreaterThanOrEqual(TIERS[0]!)
    expect(stateOf(ctx, agent).epoch).toBe(0)

    await takeTurn(agent, 'the step the backend compacts inside')

    expect(stateOf(ctx, agent).epoch).toBe(1)
    // The reminder belonged to the epoch that just closed, so it was dropped:
    // this step is owed nothing, whatever its own pre-step figure showed.
    expect(reminderSections(agent)).toEqual([])
    // And nothing was recorded as fired: the tier is still unspoken in the
    // epoch the compaction opened.
    expect(stateOf(ctx, agent).firedEpochs).toEqual({})
  })

  it('appends its reminder after every other listener has contributed to the step', async () => {
    // One message object, so the row this listener contributed can be found in
    // the request the model received.
    const otherListenerMessage = createUserMessage({
      content: [{ type: 'text', text: 'a message another listener contributed' }],
      source: { kind: 'plugin', plugin: 'another-plugin' },
    })
    // Registered ahead of the plugin, which is what makes this assertion bite:
    // the plugin prepends itself, so it is the OUTERMOST handler even though it
    // was registered last. Were it appended instead, this listener would have
    // run first and the reminder would land ahead of its message rather than
    // after it.
    const { agent, adapter } = await boot({
      before: (pluginCtx) => {
        pluginCtx.on('agent/pre-step', async (_payload, next) => {
          const decision = await next()
          if (decision.kind !== 'enter') return decision
          return { ...decision, messages: [...decision.messages, otherListenerMessage] }
        })
      },
    })

    await takeTurn(agent, 'first')
    await takeTurn(agent, 'second')

    // The step that carried both contributions, as the model received it. This
    // listener contributed a message on both steps, so the LAST one is the one
    // committed alongside the reminder.
    const messages = adapter.requests[1]!.messages
    const other = messages.findLastIndex((message) => message.id === otherListenerMessage.id)
    const reminder = messages.findIndex(
      (message) => message.source.kind === 'plugin' && message.source.plugin === ContextSense.name,
    )

    expect(other).toBeGreaterThanOrEqual(0)
    expect(reminder).toBeGreaterThanOrEqual(0)
    // Both reached the step, and the plugin's reminder was appended to the
    // decision after it existed rather than in place of its contents.
    expect(other).toBeLessThan(reminder)
  })

  it('rebuilds its firings from the durable log, so a resume neither repeats nor skips a tier', async () => {
    const { ctx, agent } = await boot()

    await takeTurn(agent, 'first')
    await takeTurn(agent, 'second')
    // The notice has spoken; the imminent tier is reached but not yet announced.
    expect(reminderSections(agent)).toEqual([NOTICE_SECTION])
    const live = stateOf(ctx, agent)

    // The registry's own cold-read recipe: fold the stored log from the cut the
    // session records. This is what a resume reconstructs its memory from — a
    // persistence-backed resume needs a `SessionPersistence` backend this
    // composition does not mount, so what is asserted is that the plugin's fold,
    // not the storage plumbing, rebuilds the same memory.
    const replayed = ctx.sessionProjections.restore(
      {},
      agent.session.snapshotEvents(),
      SessionLogOffset(0),
      agent.session.header,
      agent.session.inheritedEventCount,
    )
    const resumed = replayed.checkpoint[CONTEXT_SENSE_KEY]?.val as ContextSenseState | undefined
    expect(resumed).toEqual(live)

    // And the decision a resumed session makes from that memory is the one the
    // live session would make: the notice is not repeated, and the tier that
    // never spoke is not skipped.
    const route = agent.session.requestContext()
    const next = decideTierReminder({
      pressure: pressureOf(ctx, agent),
      capacity: route?.contextWindow,
      routeCoherent: isSampleAttributedTo(resumed!, route),
      policy: resolveReminderPolicy(reminderConfig().reminders),
      state: resumed!,
    })
    expect(next?.sectionName).toBe(IMMINENT_SECTION)
  })

  it('unloads its listener with the plugin, so the steps after it are owed nothing', async () => {
    const { ctx, agent, adapter, fiber } = await boot()

    await takeTurn(agent, 'first')
    await takeTurn(agent, 'second')
    expect(reminderSections(agent)).toEqual([NOTICE_SECTION])
    const [notice] = committedReminders(agent.session)
    const requestsBefore = adapter.requests.length

    await fiber.dispose()
    await takeTurn(agent, 'third')
    await takeTurn(agent, 'fourth')

    // The session still has an unspoken tier and the plugin is no longer there
    // to speak it: the steps after the unload committed no new reminder, and
    // the model received only the one that was already in its history.
    expect(adapter.requests).toHaveLength(requestsBefore + 2)
    expect(reminderSections(agent)).toEqual([NOTICE_SECTION])
    expect(remindersInRequest(adapter, adapter.requests.length - 1)).toEqual([notice!.text])
  })
})

describe('reminder configuration at plugin load', () => {
  let booted: MinimalContext | undefined

  afterEach(async () => {
    await booted?.dispose()
    booted = undefined
  })

  it('delivers nothing while the other two contributions stay switched on', async () => {
    booted = await bootMinimalContext()
    const { ctx, harness } = booted
    ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter(CAPACITY))
    await ctx.plugin(ContextSense, reminderConfig({ enabled: false }))
    const agent = await harness.create(SessionId('agent-1'), { provider: PROVIDER, model: MODEL })

    await takeTurn(agent, 'first')
    await takeTurn(agent, 'second')
    await takeTurn(agent, 'third')

    expect(reminderSections(agent)).toEqual([])
    // The flag is the reminders' own: the statement and the tool are untouched.
    expect(await capacitySections(ctx, agent)).toHaveLength(1)
    expect(ctx.tools.get(CONTEXT_READING_TOOL_NAME)).toBeDefined()
    // And the statement does not promise a warning that will never arrive — the
    // one place the model is told what to expect.
    const statement = (await assembleFor(ctx, agent)).sections
      .filter((section) => section.name === CAPACITY_STATEMENT_SECTION)
      .map((section) => section.text)
      .join('\n')
    expect(statement).toContain('No advisory context reminder tiers are configured')
  })

  it('fails the plugin at load on a tier configuration it cannot honour', async () => {
    booted = await bootMinimalContext()
    const { ctx } = booted

    // Descending tiers are refused outright: a tier's position is the durable
    // key its firing is recorded under, so the list is never reordered.
    await expect(ctx.plugin(ContextSense, reminderConfig({ tiers: [0.75, 0.6] }))).rejects.toThrow(/ascending/)
    // A tier at or above the assumed compaction threshold could only announce
    // the loss of room after compaction had already started.
    await expect(ctx.plugin(ContextSense, reminderConfig({ tiers: [0.9] }))).rejects.toThrow(/strictly below/)
    // And a reminder tier of exactly zero or one is not a ratio of the window.
    await expect(ctx.plugin(ContextSense, reminderConfig({ tiers: [0] }))).rejects.toThrow(/between 0 and 1/)
  })
})
