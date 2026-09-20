/**
 * Hand-written durable events for the pure fold tests.
 *
 * The fold's contract is stated over committed `SessionEvent`s, so the tests
 * state their inputs as events rather than going through a live session. Each
 * helper builds one event of the exact shape the harness commits, so a helper
 * that drifts from the real payload fails to compile here rather than silently
 * testing an easier shape.
 *
 * @module test/session-events
 */
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { boundContextSummary, createAssistantMessage, createUserMessage, type ContentBlock, type TokenUsage, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionSeq,
  type SessionEvent,
  type SessionEventMap,
  type SessionEventType,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'

import { name as PLUGIN_NAME } from '../lib/index.js'
import { pressureTierSectionName } from '../lib/session-state.js'

/** The section name one pressure tier's reminder carries; the fold's key for that tier. */
export const TIER_SECTION = pressureTierSectionName(0)

/** A second section name, used wherever a test needs two distinct tiers. */
export const SECOND_TIER_SECTION = pressureTierSectionName(1)

/** The provider of the route every route-bearing helper defaults to. */
export const ROUTE_A = { provider: 'provider-a', model: 'model-a' } as const

/** A second route, distinct from {@link ROUTE_A} in both provider and model. */
export const ROUTE_B = { provider: 'provider-b', model: 'model-b' } as const

/** One usage sample with the prompt-side and output sides distinguishable. */
export function usage(inputTokens: number, outputTokens = 7): TokenUsage {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

/** A minimal valid session header, as the projection registry supplies it. */
export function sessionHeader(id = 'session-1'): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1_700_000_000_000, isSeeded: false }
}

/**
 * One committed event at `seq`.
 *
 * `intent` carries the surface metadata a surface event requires; it is spread
 * rather than typed so a test can state an invalid combination deliberately and
 * watch the fold's behaviour on it.
 * @param type - the event type.
 * @param data - the event's payload.
 * @param seq - the event's log position.
 * @param intent - surface metadata, when the type carries any.
 * @returns the hand-written event.
 */
export function logEvent<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  seq: number,
  intent: Record<string, unknown> = {},
): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, data, ...intent } as SessionEvent
}

/** A user-role message with no plugin attribution, appended to the surface. */
export function humanMessage(seq: number, text = 'hello'): SessionEvent {
  return logEvent('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), seq, {
    surfaceOp: 'append',
  })
}

/**
 * One of this plugin's own reminder messages, in the shape the plugin commits:
 * a `snapshot`-form message attributing each reading to a named section.
 * @param seq - the event's log position.
 * @param sectionNames - the section names the snapshot carries; the fold's tier keys.
 * @returns the hand-written reminder event.
 */
export function reminderMessage(seq: number, ...sectionNames: readonly string[]): SessionEvent {
  const sections = sectionNames.map((sectionName) => ({ name: sectionName, text: `${sectionName} reminder` }))
  return logEvent(
    'user/message',
    createUserMessage({
      content: sections.map((section): ContentBlock => ({ type: 'text', text: section.text })),
      source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'snapshot', sections },
    }),
    seq,
    { surfaceOp: 'append' },
  )
}

/**
 * One oversized-result reminder: this plugin's `notice` form, which carries a
 * one-line summary and no sections.
 * @param seq - the event's log position.
 * @returns the hand-written reminder event.
 */
export function noticeReminder(seq: number): SessionEvent {
  return logEvent(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text: 'one oversized result' }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: boundContextSummary('one oversized result') },
    }),
    seq,
    { surfaceOp: 'append' },
  )
}

/** A step boundary at `turn`/`step`, which carries the step cursor. */
export function stepStart(seq: number, turn: number, step: number): SessionEvent {
  return logEvent('step/start', { turn, step }, seq)
}

/** The route record the harness appends for a request. */
export function requestContextEvent(seq: number, route: { provider: string; model: string }, contextWindow?: number): SessionEvent {
  return logEvent('request/context', { ...route, ...(contextWindow === undefined ? {} : { contextWindow }) }, seq)
}

/**
 * One assistant settlement that carries a usage sample and names its route, so
 * the sample can be attributed to it.
 * @param seq - the event's log position.
 * @param route - the provider and model that produced the message.
 * @param options - the sample size, whether it rides only the embedded stream, and the step it settled on.
 * @returns the hand-written settlement event.
 */
export function assistantMessage(
  seq: number,
  route: { provider: string; model: string } = ROUTE_A,
  options: {
    readonly sample?: number | undefined
    readonly usageInStream?: boolean
    readonly turn?: number
    readonly step?: number
  } = {},
): SessionEvent {
  const { sample = 1_000, usageInStream = false, turn = 1, step = 1 } = options
  const inStream = sample !== undefined && usageInStream
  const stream = inStream ? [{ type: 'chunk', time: seq, chunk: { type: 'usage', usage: usage(sample) } } as const] : []
  return logEvent(
    'assistant/message',
    {
      turn,
      step,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: route }),
      stream,
      ...(sample === undefined || inStream ? {} : { usage: usage(sample) }),
    },
    seq,
    { surfaceOp: 'append' },
  )
}

/**
 * One failed or retried model attempt: it commits no surface message and names
 * no route, while its stream may still carry a provider usage sample.
 * @param seq - the event's log position.
 * @param sample - the prompt size the attempt reported, or `undefined` for none.
 * @returns the hand-written attempt event.
 */
export function assistantAttempt(seq: number, sample: number | undefined = 2_000): SessionEvent {
  const stream =
    sample === undefined ? [] : [{ type: 'chunk', time: seq, chunk: { type: 'usage', usage: usage(sample) } } as const]
  return logEvent('assistant/attempt', { turn: 1, step: 1, stream }, seq)
}

/** One compaction lock bracket, whose events hold and release the lock and touch no surface. */
export function compactionBracket(kind: 'compaction/start' | 'compaction/end', seq: number): SessionEvent {
  return logEvent(kind, { compactionId: CompactionId('compaction-1'), turn: 1 }, seq)
}

/**
 * A completed summary compaction's log-only record, which opens a new epoch.
 * @param seq - the event's log position.
 * @param shadowedSeqs - the surface nodes the replacement that follows will shadow.
 * @returns the hand-written summary event.
 */
export function summaryCompaction(seq: number, shadowedSeqs: readonly number[] = []): SessionEvent {
  return logEvent(
    'compaction/summary',
    {
      compactionId: CompactionId('compaction-1'),
      summary: [{ type: 'text', text: 'a summary' }],
      shadowedRange: { start: SessionSeq(shadowedSeqs[0] ?? 0), end: SessionSeq(shadowedSeqs.at(-1) ?? 0) },
      shadowedSeqs: shadowedSeqs.map((value) => SessionSeq(value)),
      shadowedTokenCount: 100,
      provider: ROUTE_A.provider,
      model: ROUTE_A.model,
      rawOutput: [],
    },
    seq,
  )
}

/**
 * A model-free prune's log-only record: a surface replacement with no checkpoint.
 * @param seq - the event's log position.
 * @param shadowedSeqs - the surface nodes the replacement that follows will shadow.
 * @returns the hand-written prune event.
 */
export function pruneCompaction(seq: number, shadowedSeqs: readonly number[] = []): SessionEvent {
  return logEvent(
    'compaction/prune',
    {
      shadowedRange: { start: SessionSeq(shadowedSeqs[0] ?? 0), end: SessionSeq(shadowedSeqs.at(-1) ?? 0) },
      shadowedSeqs: shadowedSeqs.map((value) => SessionSeq(value)),
      shadowedTokenCount: 100,
    },
    seq,
  )
}

/**
 * The replacement surface node a compaction lands: a checkpoint message that
 * shadows the seqs it replaced, exactly as the compaction protocol commits it.
 * @param seq - the event's log position.
 * @param shadows - the surface nodes this replacement removes.
 * @param options - `checkpoint: false` for a prune-style replacement of one node by a smaller copy.
 * @returns the hand-written replacement event.
 */
export function replacementMessage(
  seq: number,
  shadows: readonly number[],
  options: { readonly checkpoint?: boolean } = {},
): SessionEvent {
  const { checkpoint = true } = options
  const source = checkpoint ? compactCheckpointSource(CompactionId('compaction-1')) : ({ kind: 'user' } as const)
  const message: UserMessage = createUserMessage({
    content: [{ type: 'text', text: checkpoint ? 'checkpoint' : 'smaller copy' }],
    source,
  })
  return logEvent('user/message', message, seq, {
    surfaceOp: { op: 'replace', startSeq: SessionSeq(shadows[0] ?? 0), endSeq: SessionSeq(shadows.at(-1) ?? 0) },
    sourceEventSeqs: shadows.map((value) => SessionSeq(value)),
  })
}
