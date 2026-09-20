/**
 * The `context_reading` tool: the model asking, at any point in a session, what
 * its context looks like right now.
 *
 * The tool owns no state and writes nothing. Its execution reads the live
 * session through the execution's own agent — so two calls in one turn each
 * describe the state at the moment they ran — and every figure it reports is
 * attributed to the source it came from. Nothing is fabricated: an unmeasured
 * pressure reads as unknown, and composition never stands in for it.
 *
 * @module dsh-context-sense/reading-tool
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { defineTool, type ToolDefinition, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

import { buildContextReading, renderContextReading, type ContextReading } from './reading.js'
import { CONTEXT_SENSE_KEY, hasVisibleCheckpoint, isSampleAttributedTo } from './session-state.js'

/** The tool's model-facing name. Distinct from every built-in tool name. */
export const CONTEXT_READING_TOOL_NAME = 'context_reading'

/**
 * The tool's canonical value. Every figure carries its own source, and the
 * `known` / `unknown` state is what says whether a figure exists at all — an
 * absent figure is never replaced by a number from somewhere else.
 *
 * The schema is the contract the registry enforces on every successful value,
 * so declaring a figure optional here is what keeps an unmeasured reading
 * valid rather than an error.
 */
const CONTEXT_READING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    capacity: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        known: {
          type: 'boolean',
          required: true,
          description: 'Whether this session has recorded a route that advertised a context window.',
        },
        contextWindow: {
          type: 'integer',
          description: 'The recorded route capacity in tokens. Absent when capacity is not known.',
        },
        provenance: {
          type: 'string',
          required: true,
          const: 'route-metadata',
          description: 'Capacity is route metadata: the newest route the harness recorded, never an estimate.',
        },
      },
    },
    pressure: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        state: {
          type: 'string',
          required: true,
          enum: ['known', 'unknown', 'stale'],
          description:
            'unknown means no provider has reported usage for this session yet; stale means a real sample exists but is not confirmed for the route the capacity belongs to.',
        },
        tokens: {
          type: 'integer',
          description:
            "The harness's figure for the next request: the newest provider-reported prompt size, repriced for the surface gained or lost since that sample when the harness projects one. Absent when the state is unknown.",
        },
        provenance: {
          type: 'string',
          const: 'provider-anchored',
          description:
            'Present only alongside a figure: the figure is anchored to a provider-reported usage sample, never derived from composition.',
        },
      },
    },
    ratio: {
      type: 'number',
      description:
        'Context pressure as a fraction of the route context window. Present only when both figures are known and confirmed to belong to the same route.',
    },
    remaining: {
      type: 'integer',
      description:
        'Tokens the route still has room for: capacity minus pressure. Present exactly when ratio is; negative means the projected request exceeds the capacity.',
    },
    composition: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        known: {
          type: 'boolean',
          required: true,
          description: 'Whether the harness priced this surface at all.',
        },
        systemTokens: { type: 'integer', description: 'Heuristic tokens of the effective system prompt.' },
        toolsTokens: { type: 'integer', description: 'Heuristic tokens of the request envelope tool schemas.' },
        messageTokens: { type: 'integer', description: 'Heuristic tokens of every other visible surface node.' },
        provenance: {
          type: 'string',
          required: true,
          const: 'heuristic',
          description: 'Approximate: these figures are not a total and are not expected to sum to pressure.',
        },
      },
    },
    compaction: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        occurredInSession: {
          type: 'boolean',
          required: true,
          description: "Whether a summary or prune compaction event appears in this session's own history.",
        },
        checkpointVisible: {
          type: 'boolean',
          required: true,
          description:
            "Whether a compaction checkpoint is part of the model-visible surface. A forked session can send its parent's checkpoint without having compacted anything itself.",
        },
      },
    },
  },
} as const satisfies ValueSchemaSpec

/** The tool's model-facing description: what it reports, and what it refuses to claim. */
const CONTEXT_READING_DESCRIPTION = [
  "Read this session's context window: how much capacity the current route has, what the harness projects the next request will cost, how that compares with the capacity, and how the surface divides between system prompt, tool definitions and conversation messages.",
  'Every figure states its source. An unmeasured figure reads as unknown rather than being estimated, and the composition figures are the harness’s own approximation — not a total, and not expected to sum to pressure.',
  'The ratio and the remaining room are reported only when the pressure figure and the capacity are both known and confirmed to belong to the same route; otherwise the pressure reads as stale or unknown and neither figure is computed.',
  'The reading also says separately whether a compaction happened in this session and whether a compaction checkpoint is currently part of the model-visible surface.',
  'Takes no arguments and writes nothing to the conversation.',
].join(' ')

/**
 * Build the tool definition. The projections are captured rather than read
 * from a module, so the definition is always bound to the composition that
 * registered it.
 * @param projections - the registry providing pressure and composition.
 * @returns the registry-ready definition.
 */
export function createContextReadingTool(projections: SessionProjectionRegistry): ToolDefinition {
  return defineTool({
    name: CONTEXT_READING_TOOL_NAME,
    description: CONTEXT_READING_DESCRIPTION,
    parameters: {},
    output: {
      schema: CONTEXT_READING_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderContextReading(value) }],
    },
    execute: (_args, exec) => Promise.resolve(readLiveContext(exec.agent, projections)),
  })
}

/**
 * Read the context as it is right now.
 *
 * The projections are read here, at execution time, and never cached: the
 * reading describes the session at the moment the model asked, and an
 * execution with no owning agent has no session to describe.
 * @param agent - the agent the call runs on behalf of, when there is one.
 * @param projections - the registry providing pressure, composition and this plugin's own memory.
 * @returns the attributed reading; an agent-less execution reads as unknown.
 */
function readLiveContext(agent: Agent | undefined, projections: SessionProjectionRegistry): ContextReading {
  if (agent === undefined) {
    // No session means no surface and no own history, so both compaction facts
    // are plainly false rather than unknown.
    return buildContextReading({
      routeCoherent: false,
      compaction: { occurredInSession: false, checkpointVisible: false },
    })
  }
  const session: Session = agent.session
  const { contextPressure, contextBreakdown } = projections.snapshot(session, [
    'contextPressure',
    'contextBreakdown',
  ]).values
  const state = projections.stateOf(session, CONTEXT_SENSE_KEY)
  // The newest route the harness recorded, which is the same route metadata the
  // standing capacity statement is built from.
  const contextWindow = session.requestContext()
  return buildContextReading({
    contextWindow: contextWindow?.contextWindow,
    pressure: contextPressure,
    composition: contextBreakdown,
    // Coherence and the compaction facts come from this plugin's own durable
    // memory, never from a comparison made up at read time. The route the gate
    // tests is the capacity's own route, so the ratio pairs the two figures the
    // model is actually being shown.
    routeCoherent: state !== undefined && isSampleAttributedTo(state, contextWindow),
    compaction: {
      occurredInSession: state?.compactedInSession ?? false,
      checkpointVisible: state !== undefined && hasVisibleCheckpoint(state),
    },
  })
}
