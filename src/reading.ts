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

/** What the next request would cost, and whether anything has measured it. */
export interface PressureFigure {
  /** `unknown` means no provider has reported usage for this session yet. */
  readonly state: 'known' | 'unknown'
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
  /** The surface's approximate composition, or that nothing has priced it. */
  readonly composition: CompositionFigure
}

/**
 * Build the reading from the live facts.
 * @param input - route capacity and the projection values, as found.
 * @returns the attributed reading; nothing is defaulted or estimated.
 */
export function buildContextReading(input: ContextReadingInput): ContextReading {
  return {
    capacity: capacityFigure(input.contextWindow),
    pressure: pressureFigure(input.pressure),
    composition: compositionFigure(input.composition),
  }
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
 * @param pressure - the `contextPressure` projection value, if registered.
 * @returns the attributed pressure figure.
 */
function pressureFigure(pressure: ContextPressureProjection | undefined): PressureFigure {
  const tokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (tokens === undefined) return { state: 'unknown' }
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
    compositionLine(reading.composition),
    ratioLine(reading),
  ].join('\n')
}

/**
 * State why the ratio and the remaining room are not reported.
 *
 * Both need a pressure figure and a capacity the plugin can show belong to the
 * same route — route coherence is a separate fact this slice does not
 * establish, so a ratio computed here could pair two different routes. An
 * absent figure is named as the reason instead: the line never implies that a
 * figure it just called unknown exists.
 * @param reading - the attributed reading.
 * @returns one line of the reading.
 */
function ratioLine(reading: ContextReading): string {
  const reasons: string[] = []
  if (reading.pressure.state === 'unknown') reasons.push('nothing has measured the pressure for this session yet')
  if (!reading.capacity.known) reasons.push('no recorded route has advertised a context window')
  if (reasons.length === 0) {
    reasons.push('this reading does not establish that the pressure figure and the capacity belong to the same route')
  }
  return `Pressure ratio and remaining room: not available — ${reasons.join(' and ')}, so neither is computed.`
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
  return `Pressure (${pressure.provenance}): ${pressure.tokens} tokens.`
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
