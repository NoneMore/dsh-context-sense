/**
 * The plugin's durable memory of the session's model-visible surface.
 *
 * This is a host-only session projection: a pure fold over committed events
 * that the projection registry drives on every append. Nothing here is
 * process-local and nothing here is published to a client, so a resume or a
 * replay reconstructs exactly the same memory from the durable log.
 *
 * The state is split by the fork cut the registry supplies. Facts the session
 * itself owns — its compaction epoch, which tier fired in which epoch, the step
 * cursor — fold only the own suffix, so a child never mistakes its parent's
 * reminders for its own. Facts about the surface it sends — the recorded route,
 * the newest attributed usage sample, which checkpoints survive on the surface
 * — fold the whole log, inherited prefix included, because they are true of the
 * messages this session's requests carry.
 *
 * @module dsh-context-sense/session-state
 */
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  isSurfaceEvent,
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { z } from 'zod'

import { PLUGIN_NAME } from './identity.js'

/**
 * The projection's key inside `SessionProjectionStateMap`. The unit is
 * host-only, so this key deliberately has no `SessionProjectionMap` entry.
 */
export const CONTEXT_SENSE_KEY = 'contextSense'

/** A provider and model pair: the identity route coherence compares. */
export interface ResolvedRoute {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/**
 * Which route the newest provider-reported usage sample belongs to.
 *
 * `none` means nothing has been measured at all. `unattributed` means a sample
 * exists but names no route — a failed attempt's usage chunk, for instance —
 * and coherence therefore cannot be shown for it. An attributed sample is a
 * {@link ResolvedRoute}: the one statement a settlement makes about where its
 * measurement came from.
 */
export type UsageSample = { readonly kind: 'none' } | { readonly kind: 'unattributed' } | ({ readonly kind: 'attributed' } & ResolvedRoute)

/** One step in one turn, as `step/start` records it. */
export interface StepCursor {
  /** The turn the step belongs to. */
  readonly turn: number
  /** The step within that turn. */
  readonly step: number
}

/** Everything the plugin remembers about one session, rebuilt from its log. */
export interface ContextSenseState {
  /** The exact fork-inherited prefix length: the cut between the two fact sets. */
  readonly inheritedEventCount: SessionLogOffset
  /** Reminder epoch: summary compactions in the own suffix, starting at zero. */
  readonly epoch: number
  /** Section name → the epoch that tier last fired in, for the session's own reminders. */
  readonly firedEpochs: Record<string, number>
  /** `(turn, step)` of the latest own `step/start`, or `null` before the session's first step. */
  readonly cursor: StepCursor | null
  /** The step a pressure-tier reminder went out at, or `null` before one has. */
  readonly pressureReminder: StepCursor | null
  /** Whether a summary or prune compaction occurred in the session's own suffix. */
  readonly compactedInSession: boolean
  /** The newest route the harness recorded, over the whole log. */
  readonly recordedRoute: ResolvedRoute | null
  /** The newest usage sample and whether it names a route, over the whole log. */
  readonly newestSample: UsageSample
  /** Seqs of the checkpoint nodes still on the current surface, inherited prefix included. */
  readonly visibleCheckpoints: number[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Context Sense's host-only surface memory; never published to a client. */
    contextSense: ContextSenseState
  }
}

const routeSchema = z.object({ provider: z.string(), model: z.string() }).strict()

const cursorSchema = z.object({ turn: z.number().int().nonnegative(), step: z.number().int().nonnegative() }).strict()

const sampleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('unattributed') }).strict(),
  z.object({ kind: z.literal('attributed'), provider: z.string(), model: z.string() }).strict(),
])

/**
 * The state's persisted shape. Every field is plain JSON, so the projection
 * cache can store it and a later resume can seed the fold from it.
 */
export const contextSenseStateSchema = z
  .object({
    inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset),
    epoch: z.number().int().nonnegative(),
    firedEpochs: z.record(z.string(), z.number().int().nonnegative()),
    cursor: cursorSchema.nullable(),
    pressureReminder: cursorSchema.nullable(),
    compactedInSession: z.boolean(),
    recordedRoute: routeSchema.nullable(),
    newestSample: sampleSchema,
    visibleCheckpoints: z.array(z.number().int().nonnegative()),
  })
  .strict()

/**
 * The state for an empty log.
 * @param _header - the session's immutable metadata; the fold needs none of it.
 * @param inheritedEventCount - the exact fork-inherited prefix length.
 * @returns the initial state, owning nothing the session has not written.
 */
export function initContextSenseState(
  _header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): ContextSenseState {
  return {
    inheritedEventCount,
    epoch: 0,
    firedEpochs: {},
    cursor: null,
    pressureReminder: null,
    compactedInSession: false,
    recordedRoute: null,
    newestSample: { kind: 'none' },
    visibleCheckpoints: [],
  }
}

/**
 * Fold one committed event into the state.
 *
 * Surface history folds the whole log; the session's own facts fold only the
 * own suffix. An event the fold does not care about returns the same state
 * reference, which is what keeps the registry's drive cheap.
 * @param state - the state covering every prior event.
 * @param event - the next committed event.
 * @returns the next state, or the same reference when nothing changed.
 */
export function applyContextSenseEvent(state: ContextSenseState, event: SessionEvent): ContextSenseState {
  const surface = withSurfaceHistory(state, event)
  if (event.seq < state.inheritedEventCount) return surface
  return withOwnHistory(surface, event)
}

/**
 * Whether the newest usage sample is attributed to one resolved route.
 *
 * The caller supplies the route the capacity it is about to report came from, so
 * the gate compares the pairing the model will actually see: the route behind
 * the capacity figure against the route behind the pressure figure. It is
 * deliberately conservative — a sample that names no route, or no sample at all,
 * can never be shown to belong to the capacity's.
 * @param state - the folded state.
 * @param route - the provider and model the capacity belongs to, when one is known.
 * @returns whether a ratio may be formed from the current pressure and capacity.
 */
export function isSampleAttributedTo(state: ContextSenseState, route: ResolvedRoute | null | undefined): boolean {
  if (route === null || route === undefined) return false
  const { newestSample } = state
  return newestSample.kind === 'attributed' && sameIdentity(newestSample, route)
}

/**
 * Whether a compaction checkpoint is on the surface this session sends.
 *
 * True for a fork that sends its parent's checkpoint without having compacted
 * anything itself, which is exactly why this is a separate question from
 * {@link ContextSenseState.compactedInSession}.
 * @param state - the folded state.
 * @returns whether any surviving surface node is a compaction checkpoint.
 */
export function hasVisibleCheckpoint(state: ContextSenseState): boolean {
  return state.visibleCheckpoints.length > 0
}

/**
 * The transcript section name that records one pressure tier's firing.
 *
 * It is both the contribution label the human sees and the fold's key, so it is
 * derived from the tier's position and never from its ratio: re-tuning a tier
 * must not re-fire it in the epoch it already fired in.
 * @param tierIndex - the tier's position in the configured, ascending list.
 * @returns the stable section name for that tier.
 */
export function pressureTierSectionName(tierIndex: number): string {
  return `${PLUGIN_NAME}:tier:${tierIndex}`
}

/**
 * Fold the facts that are true of the surface this session sends, over the
 * whole log including the inherited prefix.
 * @param state - the state covering every prior event.
 * @param event - the next committed event.
 * @returns the next state, or the same reference when nothing changed.
 */
function withSurfaceHistory(state: ContextSenseState, event: SessionEvent): ContextSenseState {
  // Checkpoint bookkeeping runs for every surface event, not only the ones the
  // compaction backends happen to land: whatever replaced a span removed the
  // nodes it shadowed, and a shadowed checkpoint is off the surface for good.
  return withCheckpointVisibility(withRouteAndSample(state, event), event)
}

/**
 * Fold the newest recorded route and the newest usage sample.
 * @param state - the state covering every prior event.
 * @param event - the next committed event.
 * @returns the next state, or the same reference when nothing changed.
 */
function withRouteAndSample(state: ContextSenseState, event: SessionEvent): ContextSenseState {
  switch (event.type) {
    case 'request/context': {
      const route: ResolvedRoute = { provider: event.data.provider, model: event.data.model }
      return sameRoute(state.recordedRoute, route) ? state : { ...state, recordedRoute: route }
    }
    case 'assistant/message': {
      if (usageOf(event) === undefined) return state
      const { provider, model } = event.data.message.source
      const sample: UsageSample = { kind: 'attributed', provider, model }
      return sameSample(state.newestSample, sample) ? state : { ...state, newestSample: sample }
    }
    case 'assistant/attempt': {
      if (usageOf(event) === undefined) return state
      // The sample is real and is what the harness's pressure figure is
      // anchored to, but the attempt names no route — so it can never be shown
      // to belong to the recorded one.
      return state.newestSample.kind === 'unattributed' ? state : { ...state, newestSample: { kind: 'unattributed' } }
    }
    default:
      return state
  }
}

/**
 * Fold the facts this session owns, over its own suffix only.
 * @param state - the state covering every prior event, surface history included.
 * @param event - the next committed event, at or past the fork cut.
 * @returns the next state, or the same reference when nothing changed.
 */
function withOwnHistory(state: ContextSenseState, event: SessionEvent): ContextSenseState {
  switch (event.type) {
    case 'compaction/summary':
      // The epoch marker and the "this session compacted" fact are the same
      // event: a summary replaces a span with a checkpoint, which is what opens
      // a new reminder epoch.
      return { ...state, epoch: state.epoch + 1, compactedInSession: true }
    case 'compaction/prune':
      // A prune replaces one node with a smaller copy and leaves no checkpoint:
      // it did change the surface, but it opens no epoch.
      return state.compactedInSession ? state : { ...state, compactedInSession: true }
    case 'step/start': {
      const cursor: StepCursor = { turn: event.data.turn, step: event.data.step }
      return sameCursor(state.cursor, cursor) ? state : { ...state, cursor }
    }
    case 'user/message':
      return withTierFiring(state, event)
    default:
      return state
  }
}

/**
 * Track which compaction checkpoints survive on the surface.
 *
 * A replacement event cites every surface node it shadowed, which is the
 * authoritative removed set — the replacement's declared range is a
 * surface-position span, not a numeric interval. A checkpoint that has been
 * replaced or shadowed is off the surface even though it stays in the log.
 * @param state - the state covering every prior event.
 * @param event - the committed event.
 * @returns the next state, or the same reference when nothing changed.
 */
function withCheckpointVisibility(state: ContextSenseState, event: SessionEvent): ContextSenseState {
  const shadowed = shadowedNodeSeqs(event)
  let next = state
  if (shadowed.length > 0) {
    const surviving = state.visibleCheckpoints.filter((seq) => !shadowed.includes(seq))
    if (surviving.length !== state.visibleCheckpoints.length) next = { ...state, visibleCheckpoints: surviving }
  }
  if (event.type === 'user/message' && isCompactCheckpointSource(event.data.source)) {
    next = { ...next, visibleCheckpoints: [...next.visibleCheckpoints, event.seq] }
  }
  return next
}

/**
 * Reconstruct a tier's firing from this plugin's own durable reminder message.
 *
 * A `snapshot`-form message names its sections; each name is one tier that is
 * now fired in the current epoch. The message's position is also the step a
 * pressure-tier reminder went out at — which an oversized-result reminder,
 * carrying the `notice` form instead, must never set: it is committed at the
 * step after the result that produced it.
 * @param state - the state covering every prior event, own suffix only.
 * @param event - the committed `user/message`.
 * @returns the next state, or the same reference when this is not a reminder.
 */
function withTierFiring(state: ContextSenseState, event: UserMessageEvent): ContextSenseState {
  const sections = snapshotSectionsOf(event)
  if (sections === undefined || sections.length === 0) return state
  const firedEpochs = { ...state.firedEpochs }
  for (const section of sections) firedEpochs[section.name] = state.epoch
  return { ...state, firedEpochs, pressureReminder: state.cursor }
}

/** A `user/message` event, the only surface node this plugin authors or recognizes. */
type UserMessageEvent = Extract<SessionEvent, { readonly type: 'user/message' }>

/**
 * The sections of one of this plugin's `snapshot`-form messages.
 * @param event - the committed `user/message`.
 * @returns the named sections, or `undefined` when this is another producer's message.
 */
function snapshotSectionsOf(event: UserMessageEvent): readonly { readonly name: string }[] | undefined {
  const source = event.data.source
  if (source.kind !== 'plugin' || source.plugin !== PLUGIN_NAME) return undefined
  if (source.form !== 'snapshot') return undefined
  return source.sections
}

/**
 * The provider-reported usage sample one settlement carries, if any.
 *
 * The rule mirrors the token meter's own: an `assistant/message` may carry the
 * sample beside its stream or only inside it, and an `assistant/attempt` can
 * only carry it inside its stream. The fold must agree with the meter here, or
 * it would attribute a route to a sample the meter took from somewhere else.
 * @param event - any committed event.
 * @returns the sample, or `undefined` when the event reports none.
 */
function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message') {
    return event.data.usage ?? lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
  }
  if (event.type === 'assistant/attempt') return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
  return undefined
}

/**
 * The surface nodes one committed event removed, whatever surface type carried it.
 *
 * A replacement declares the complete set of nodes it shadowed, so this is the
 * durable answer to "what left the surface", for every producer — not only the
 * compaction backends.
 * @param event - the committed event.
 * @returns the shadowed seqs; empty for an append or a log-only event.
 */
function shadowedNodeSeqs(event: SessionEvent): readonly number[] {
  if (!isSurfaceEvent(event)) return []
  if (event.surfaceOp === 'append') return []
  return (event as { readonly sourceEventSeqs?: readonly number[] }).sourceEventSeqs ?? []
}

/** Whether two provider and model pairs name the same resolved route. */
function sameIdentity(left: ResolvedRoute, right: ResolvedRoute): boolean {
  return left.provider === right.provider && left.model === right.model
}

/** Whether a recorded route already states this route. */
function sameRoute(left: ResolvedRoute | null, right: ResolvedRoute): boolean {
  return left !== null && sameIdentity(left, right)
}

/** Whether two usage samples state the same fact. */
function sameSample(left: UsageSample, right: UsageSample): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'attributed' && right.kind === 'attributed') return sameIdentity(left, right)
  return true
}

/** Whether two step cursors are the same position. */
function sameCursor(left: StepCursor | null, right: StepCursor): boolean {
  return left !== null && left.turn === right.turn && left.step === right.step
}

/**
 * The plugin's projection unit, ready to register.
 *
 * `wire` is deliberately absent: this state is host-only, so it never appears
 * in a client snapshot and is never validated against a wire schema.
 */
export const contextSenseProjection = {
  key: CONTEXT_SENSE_KEY,
  stateVersion: 1,
  stateSchema: contextSenseStateSchema,
  init: initContextSenseState,
  apply: applyContextSenseEvent,
} as const
