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
          enum: ['known', 'unknown'],
          description: 'unknown means no provider has reported usage for this session yet.',
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
  },
} as const satisfies ValueSchemaSpec

/** The tool's model-facing description: what it reports, and what it refuses to claim. */
const CONTEXT_READING_DESCRIPTION = [
  "Read this session's context window: how much capacity the current route has, what the harness projects the next request will cost, and how the surface divides between system prompt, tool definitions and conversation messages.",
  "Every figure states its source. An unmeasured figure reads as unknown rather than being estimated, and the composition figures are the harness's own approximation — not a total, and not expected to sum to pressure.",
  'The pressure ratio and the remaining room are reported as unavailable, because this reading does not establish that the pressure figure and the capacity belong to the same route.',
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
 * @param projections - the registry providing pressure and composition.
 * @returns the attributed reading; an agent-less execution reads as unknown.
 */
function readLiveContext(agent: Agent | undefined, projections: SessionProjectionRegistry): ContextReading {
  if (agent === undefined) return buildContextReading({})
  const session: Session = agent.session
  const { contextPressure, contextBreakdown } = projections.snapshot(session, [
    'contextPressure',
    'contextBreakdown',
  ]).values
  return buildContextReading({
    // The newest route the harness recorded, which is the same route metadata
    // the standing capacity statement is built from.
    contextWindow: session.requestContext()?.contextWindow,
    pressure: contextPressure,
    composition: contextBreakdown,
  })
}
