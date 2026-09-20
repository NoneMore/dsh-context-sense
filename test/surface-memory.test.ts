/**
 * The plugin's surface memory against real sessions: a fork's cut, and replay.
 *
 * The pure fold is covered in `session-state.test.ts`. These tests put the same
 * facts into a real booted session — a parent that compacted and fired a tier,
 * a child seeded from its log at a non-zero cut — so what is asserted is the
 * state the projection registry actually materializes per session, not an
 * arrangement the test made up.
 *
 * @module test/surface-memory
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId, compactCheckpointSource, isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'

import * as ContextSense from '../lib/index.js'
import { CONTEXT_READING_TOOL_NAME } from '../lib/reading-tool.js'
import { CONTEXT_SENSE_KEY, pressureTierSectionName, type ContextSenseState } from '../lib/session-state.js'
import { bootMinimalContext, type MinimalContext } from './minimal-context.js'
import { CAPACITY, MODEL, PROVIDER, ScriptedAdapter, takeTurn, textOf } from './scripted-provider.js'

/** The section name the parent's fired tier was recorded under. */
const TIER_SECTION = pressureTierSectionName(0)

/** The plugin-owned reminder the parent committed, in the shape the plugin commits it. */
function tierReminderText(section: string): string {
  return `tier reminder: ${section}`
}

/**
 * Append one of this plugin's own snapshot-form reminders to a live session.
 * @param session - the session to write into.
 * @param section - the tier's stable section name.
 */
function appendTierReminder(session: Session, section: string): void {
  const text = tierReminderText(section)
  session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: ContextSense.name, form: 'snapshot', sections: [{ name: section, text }] },
    }),
    { surfaceOp: 'append' },
  )
}

/**
 * Append one complete summary compaction: the lock bracket, the summary record,
 * and the replacement checkpoint message that shadows the span, in the order the
 * compaction protocol commits them.
 * @param session - the session to compact.
 * @param shadows - the surface nodes the checkpoint replaces.
 * @returns the checkpoint node's source.
 */
function appendSummaryCompaction(session: Session, shadows: readonly SessionSeq[]): void {
  const compactionId = CompactionId('compaction-1')
  const start = shadows[0]!
  const end = shadows.at(-1)!
  const summary: ContentBlock[] = [{ type: 'text', text: 'a summary of the compacted span' }]
  session.append('compaction/start', { compactionId, turn: null })
  session.append('compaction/summary', {
    compactionId,
    summary,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadows],
    shadowedTokenCount: 100,
    provider: PROVIDER,
    model: MODEL,
    rawOutput: summary,
  })
  session.append(
    'user/message',
    createUserMessage({ content: summary, source: compactCheckpointSource(compactionId) }),
    { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [...shadows] },
  )
  session.append('compaction/end', { compactionId, turn: null })
}

/** Dispatch `context_reading` through the registry, as the loop does. */
function invokeReading(ctx: Context, agent: Agent): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: 'reading' as never,
    name: CONTEXT_READING_TOOL_NAME,
    arguments: {},
    agent,
    signal: new AbortController().signal,
  })
}

/** The canonical value of a successful dispatch. */
function valueOf(result: ToolExecutionResult) {
  if (result.isError) throw new Error(`context_reading failed: ${result.error.message}`)
  return result.value as {
    compaction: { occurredInSession: boolean; checkpointVisible: boolean }
  }
}

/** The memory the registry holds for one session. */
function stateOf(ctx: Context, agent: Agent): ContextSenseState {
  const state = ctx.sessionProjections.stateOf(agent.session, CONTEXT_SENSE_KEY)
  if (state === undefined) throw new Error('the plugin registered no session memory')
  return state
}

describe('surface memory over real sessions', () => {
  let booted: MinimalContext | undefined

  afterEach(async () => {
    await booted?.dispose()
    booted = undefined
  })

  /**
   * Boot a session whose own history already holds a fired tier and a summary
   * compaction, which is the state a fork of it must not inherit.
   * @returns the booted context and that parent agent.
   */
  async function bootCompactedParent(): Promise<{ ctx: Context; parent: Agent }> {
    booted = await bootMinimalContext()
    const { ctx, harness } = booted
    ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter(CAPACITY))
    await ctx.plugin(ContextSense)
    const parent = await harness.create(SessionId('parent'), { provider: PROVIDER, model: MODEL })
    await takeTurn(parent, 'a turn the parent completes')

    // The span this session compacts is the conversation it has had, taken
    // before the reminder goes on the surface: the reminder is not history the
    // compaction replaces, and it stays visible for the child to inherit.
    const conversation = parent.session.surface.nodes.filter((seq) => {
      const type = parent.session.eventAt(seq)?.type
      return type === 'user/message' || type === 'assistant/message'
    })
    appendTierReminder(parent.session, TIER_SECTION)
    appendSummaryCompaction(parent.session, conversation)

    return { ctx, parent }
  }

  it('replays the durable log into exactly the state the live session holds', async () => {
    const { ctx, parent } = await bootCompactedParent()
    const live = stateOf(ctx, parent)

    // The registry's own cold-read recipe: fold the stored log from the fork
    // cut the session records. This is what a resume reconstructs from.
    const events = parent.session.snapshotEvents()
    const replayed = ctx.sessionProjections.restore(
      {},
      events,
      SessionLogOffset(0),
      parent.session.header,
      parent.session.inheritedEventCount,
    )

    expect(replayed.checkpoint[CONTEXT_SENSE_KEY]?.val).toEqual(live)
    // The state being replayed is not the trivial one, or this would pass on a
    // memory that remembers nothing.
    expect(live.epoch).toBe(1)
    expect(live.compactedInSession).toBe(true)
    expect(live.firedEpochs).toEqual({ [TIER_SECTION]: 0 })
  })

  it('starts a fork at epoch zero while the parent keeps its own', async () => {
    const { ctx, parent } = await bootCompactedParent()
    const seed = parent.session.snapshotEvents()

    const child = await ctx.agents.create({
      sessionId: SessionId('child'),
      parentAgent: parent,
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { isSeeded: true, parentSession: parent.id },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })

    // The cut is real and non-zero: everything the child folds as its own
    // history is empty, and the assertions below are about that, not about a
    // fresh session that simply had no parent.
    expect(child.agent.session.inheritedEventCount).toBe(seed.length)
    expect(child.agent.session.inheritedEventCount).toBeGreaterThan(0)

    const childState = stateOf(ctx, child.agent)
    expect(childState.epoch).toBe(0)
    expect(childState.firedEpochs).toEqual({})
    expect(childState.compactedInSession).toBe(false)

    // The parent's checkpoint and reminder are, however, on the surface the
    // child sends.
    const visible = child.agent.session.deriveMessages()
    expect(visible.some((message) => isCompactCheckpointSource(message.source))).toBe(true)
    const inheritedReminder = visible.find(
      (message) => message.source.kind === 'plugin' && message.source.plugin === ContextSense.name,
    )
    expect(inheritedReminder).toBeDefined()
    expect(textOf([...inheritedReminder!.content])).toBe(tierReminderText(TIER_SECTION))
    expect(childState.visibleCheckpoints).not.toHaveLength(0)

    // And the child says so: no compaction of its own, a checkpoint on its surface.
    const reading = valueOf(await invokeReading(ctx, child.agent))
    expect(reading.compaction).toEqual({ occurredInSession: false, checkpointVisible: true })
    expect(textOf((await invokeReading(ctx, child.agent)).content)).toContain(
      'Compaction in this session: none — no compaction event appears in this session\'s own history. ' +
        'Compaction checkpoint on the surface: yes — a compaction summary is part of the model-visible surface.',
    )

    // The parent is untouched by its child's existence.
    const parentState = stateOf(ctx, parent)
    expect(parentState.epoch).toBe(1)
    expect(parentState.compactedInSession).toBe(true)
    expect(parentState.firedEpochs).toEqual({ [TIER_SECTION]: 0 })
  })
})
