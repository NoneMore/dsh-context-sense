/**
 * The context reading: what the model's context looks like right now, with
 * every figure attributed to its source.
 *
 * The value and its render are pure. Nothing here reads a projection, a clock
 * or module-level state, so the labelling rules — which figure exists, and
 * where it came from — are testable without a session, and the tool that
 * supplies live input stays a thin adapter.
 *
 * @module dsh-context-sense/reading
 */
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
} from '@deepseek-ai/dsh-token-meter/client'

/** Capacity's source: the newest route the harness recorded. Never an estimate. */
export const ROUTE_METADATA = 'route-metadata'

/**
 * Pressure's source: the provider-reported prompt size of the newest request,
 * plus the harness's heuristic re-pricing of the surface gained or lost since.
 * Present only when the projection carries a figure.
 */
export const PROVIDER_ANCHORED = 'provider-anchored'

/** Composition's source: the harness's approximate pricing of the surface. */
export const HEURISTIC = 'heuristic'

/** The live facts one reading is built from. */
export interface ContextReadingInput {
  /**
   * `contextWindow` of the newest route the session recorded, or `undefined`
   * when no route advertised one.
   */
  readonly contextWindow?: number | undefined
  /** The `contextPressure` projection value, absent when no unit is registered. */
  readonly pressure?: ContextPressureProjection | undefined
  /** The `contextBreakdown` projection value, absent when no unit is registered. */
  readonly composition?: ContextBreakdownProjection | undefined
  /**
   * Whether the plugin can show that the pressure figure and the capacity
   * belong to the same resolved route. Reconstructed from durable events, so it
   * is an input like any other fact rather than something this module decides.
   */
  readonly routeCoherent: boolean
  /** The two compaction facts, which are never conflated with one another. */
  readonly compaction: CompactionFacts
}

/**
 * The two compaction facts, each with its own cut.
 *
 * They are separate because they answer different questions: a session can send
 * a checkpoint its parent's compaction produced without ever having compacted
 * anything itself, and saying so is what keeps the reading honest about which
 * history the model can still see.
 */
export interface CompactionFacts {
  /** A `compaction/summary` or `compaction/prune` event in this session's own suffix. */
  readonly occurredInSession: boolean
  /** At least one surviving node of the current surface is a compaction checkpoint. */
  readonly checkpointVisible: boolean
}

/** How much room the route allows, and whether that is known at all. */
export interface CapacityFigure {
  /** Whether the session has recorded a route that advertised a capacity. */
  readonly known: boolean
  /** The route's advertised context window; absent when not known. */
  readonly contextWindow?: number | undefined
  /** Always `route-metadata`: capacity is route metadata even when there is none. */
  readonly provenance: typeof ROUTE_METADATA
}

/** What the next request would cost, and where that figure stands. */
export interface PressureFigure {
  /**
   * `unknown` means no provider has reported usage for this session yet;
   * `stale` means a real sample exists but is not confirmed for the route the
   * recorded capacity belongs to.
   */
  readonly state: 'known' | 'unknown' | 'stale'
  /** The projected figure; absent when the state is `unknown`. */
  readonly tokens?: number | undefined
  /** Present only alongside a figure: an absent pressure has no source. */
  readonly provenance?: typeof PROVIDER_ANCHORED | undefined
}

/** What the surface is made of, by the harness's approximate pricing. */
export interface CompositionFigure {
  /** Whether the composition heuristic has produced a figure for this session. */
  readonly known: boolean
  /** Heuristic tokens of the effective system prompt; absent when not known. */
  readonly systemTokens?: number | undefined
  /** Heuristic tokens of the request envelope's tool schemas; absent when not known. */
  readonly toolsTokens?: number | undefined
  /** Heuristic tokens of every other visible surface node; absent when not known. */
  readonly messageTokens?: number | undefined
  /** Always `heuristic`: these figures are the harness's approximation. */
  readonly provenance: typeof HEURISTIC
}

/** The tool's canonical value: one figure per fact, each with its source. */
export interface ContextReading {
  /** The route's capacity, or that no recorded route advertised one. */
  readonly capacity: CapacityFigure
  /** The next request's projected cost, or that nothing has measured it. */
  readonly pressure: PressureFigure
  /**
   * Context pressure as a fraction of the route's context window. Present only
   * when both figures exist AND the plugin can show they belong to the same
   * route — a ratio across two routes would be fabricated.
   */
  readonly ratio?: number | undefined
  /** Tokens the route still has room for; present exactly when `ratio` is. */
  readonly remaining?: number | undefined
  /** The surface's approximate composition, or that nothing has priced it. */
  readonly composition: CompositionFigure
  /** Whether this session compacted, and whether a checkpoint is on its surface. */
  readonly compaction: CompactionFacts
}

/**
 * Build the reading from the live facts.
 * @param input - route capacity, the projection values, and the reconstructed facts.
 * @returns the attributed reading; nothing is defaulted or estimated.
 */
export function buildContextReading(input: ContextReadingInput): ContextReading {
  const capacity = capacityFigure(input.contextWindow)
  const pressure = pressureFigure(input.pressure, input.routeCoherent)
  const room = remainingRoom(capacity, pressure)
  return {
    capacity,
    pressure,
    ...(room === undefined ? {} : { ratio: room.ratio, remaining: room.remaining }),
    composition: compositionFigure(input.composition),
    compaction: input.compaction,
  }
}

/**
 * The ratio and the remaining room, or nothing at all.
 *
 * Both need a known pressure figure and a capacity the plugin can show belong
 * to the same route. When either is missing there is no ratio to report, and
 * none is derived from composition or from an earlier route's figures.
 * @param capacity - the attributed capacity figure.
 * @param pressure - the attributed pressure figure.
 * @returns the ratio and remaining room, or `undefined` when no ratio may be formed.
 */
function remainingRoom(
  capacity: CapacityFigure,
  pressure: PressureFigure,
): { readonly ratio: number; readonly remaining: number } | undefined {
  if (pressure.state !== 'known' || pressure.tokens === undefined) return undefined
  if (!capacity.known || capacity.contextWindow === undefined) return undefined
  return { ratio: pressure.tokens / capacity.contextWindow, remaining: capacity.contextWindow - pressure.tokens }
}

/**
 * Capacity is route metadata. It exists only when a recorded route advertised
 * one, so it is never defaulted to a guess and never estimated.
 * @param contextWindow - the newest recorded route's advertised capacity.
 * @returns the attributed capacity figure.
 */
function capacityFigure(contextWindow: number | undefined): CapacityFigure {
  if (contextWindow === undefined) return { known: false, provenance: ROUTE_METADATA }
  return { known: true, contextWindow, provenance: ROUTE_METADATA }
}

/**
 * Pressure is the harness's projection of the next request's prompt size. The
 * figure is `projectedTokens ?? pressureTokens` — the same numerator the human
 * meter shows — and it is provider-anchored: with neither field there is no
 * provider usage sample yet, so the state is `unknown` and the figure carries
 * no source rather than falling back to composition.
 *
 * A figure the plugin cannot show belongs to the recorded route is `stale`, not
 * `known`: it is a real measurement of a route this session may have left.
 * @param pressure - the `contextPressure` projection value, if registered.
 * @param routeCoherent - whether that figure is confirmed for the recorded route.
 * @returns the attributed pressure figure.
 */
function pressureFigure(
  pressure: ContextPressureProjection | undefined,
  routeCoherent: boolean,
): PressureFigure {
  const tokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (tokens === undefined) return { state: 'unknown' }
  if (!routeCoherent) return { state: 'stale', tokens, provenance: PROVIDER_ANCHORED }
  return { state: 'known', tokens, provenance: PROVIDER_ANCHORED }
}

/**
 * Composition is the harness's own heuristic pricing of the surface, and is
 * known exactly when that unit produced a value for this session.
 * @param composition - the `contextBreakdown` projection value, if registered.
 * @returns the attributed composition figure.
 */
function compositionFigure(composition: ContextBreakdownProjection | undefined): CompositionFigure {
  if (composition === undefined) return { known: false, provenance: HEURISTIC }
  return { known: true, provenance: HEURISTIC, ...composition }
}

/**
 * Render the reading for the model.
 * @param reading - the attributed reading.
 * @returns the model-facing text, with no trailing newline.
 */
export function renderContextReading(reading: ContextReading): string {
  return [
    capacityLine(reading.capacity),
    pressureLine(reading.pressure),
    roomLine(reading),
    compositionLine(reading.composition),
    compactionLine(reading.compaction),
  ].join('\n')
}

/**
 * State the ratio and the remaining room, or why neither is reported.
 *
 * Both are given only when the pressure figure and the capacity are known AND
 * confirmed to belong to the same route; otherwise the line names the fact that
 * is missing or unconfirmed, and computes nothing from composition or across
 * routes.
 * @param reading - the attributed reading.
 * @returns one line of the reading.
 */
function roomLine(reading: ContextReading): string {
  const { ratio, remaining } = reading
  if (ratio !== undefined && remaining !== undefined) {
    const percent = formatPercent(ratio)
    const room =
      remaining >= 0 ? `${remaining} tokens remaining` : `over the route's context window by ${-remaining} tokens`
    return `Ratio and remaining room: ${percent} of the route's context window — ${room}.`
  }
  return `Ratio and remaining room: not available — ${unavailableReasons(reading).join(' and ')}, so neither is computed.`
}

/**
 * Why no ratio could be formed, in the reading's own terms.
 * @param reading - the attributed reading.
 * @returns one reason per missing or unconfirmed fact.
 */
function unavailableReasons(reading: ContextReading): string[] {
  const reasons: string[] = []
  const unmeasured = PRESSURE_ABSENCE_REASON[reading.pressure.state]
  if (unmeasured !== undefined) reasons.push(unmeasured)
  if (!reading.capacity.known) reasons.push('no recorded route has advertised a context window')
  return reasons
}

/**
 * The reason each pressure state gives for withholding a ratio.
 *
 * One table rather than a branch per reader: every place that asks "why is
 * there no ratio?" states the same cause in the same words.
 */
const PRESSURE_ABSENCE_REASON: Record<PressureFigure['state'], string | undefined> = {
  known: undefined,
  unknown: 'nothing has measured the pressure for this session yet',
  stale: 'the newest pressure sample is not confirmed for the route the recorded capacity belongs to',
}

/**
 * Render a ratio as a percentage, keeping at most one decimal so a ratio that
 * is not a whole percent still reads as the ratio it is.
 *
 * Shared with the standing statement, which names the reminder tiers in the
 * same units: one rule for how a fraction of the context window is written.
 * @param ratio - a fraction of the context window.
 * @returns the percentage, e.g. `3.3%`.
 */
export function formatPercent(ratio: number): string {
  return `${Number((ratio * 100).toFixed(1))}%`
}

/**
 * State the route's capacity, or say plainly that no route has advertised one.
 * @param capacity - the attributed capacity figure.
 * @returns one line of the reading.
 */
function capacityLine(capacity: CapacityFigure): string {
  if (!capacity.known) {
    return `Capacity (${capacity.provenance}): unknown — no recorded route has advertised a context window yet.`
  }
  return `Capacity (${capacity.provenance}): ${capacity.contextWindow} tokens.`
}

/**
 * State what the next request would cost, or say plainly that nothing has
 * measured it. The source label appears only alongside a figure.
 * @param pressure - the attributed pressure figure.
 * @returns one line of the reading.
 */
function pressureLine(pressure: PressureFigure): string {
  if (pressure.state === 'unknown') {
    return 'Pressure: unknown — no provider-reported usage sample exists for this session yet.'
  }
  if (pressure.state === 'stale') {
    return `Pressure (${pressure.provenance}, stale): ${pressure.tokens} tokens — measured for a route this session has left, and not confirmed for the route the recorded capacity belongs to.`
  }
  return `Pressure (${pressure.provenance}): ${pressure.tokens} tokens.`
}

/**
 * Report the two compaction facts, which are deliberately not one line: a
 * session can send a checkpoint it never created.
 * @param compaction - the two compaction facts.
 * @returns one line of the reading.
 */
function compactionLine(compaction: CompactionFacts): string {
  const session = compaction.occurredInSession
    ? "a summary or prune compaction has replaced part of this session's own history"
    : "none — no compaction event appears in this session's own history"
  const surface = compaction.checkpointVisible
    ? 'yes — a compaction summary is part of the model-visible surface'
    : 'none — no compaction summary is on the model-visible surface'
  return `Compaction in this session: ${session}. Compaction checkpoint on the surface: ${surface}.`
}

/**
 * State the surface's composition, always as the harness's approximation:
 * these figures are not expected to sum to pressure and are never a total.
 * @param composition - the attributed composition figure.
 * @returns one line of the reading.
 */
function compositionLine(composition: CompositionFigure): string {
  if (!composition.known) {
    return `Composition (${composition.provenance}, approximate): unknown — the harness's composition heuristic has produced no figure for this session.`
  }
  return `Composition (${composition.provenance}, approximate): system ${composition.systemTokens}, tool definitions ${composition.toolsTokens}, messages ${composition.messageTokens} — not a total, and not expected to sum to pressure.`
}
