import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'

import * as ContextSense from '../lib/index.js'
import { CONTEXT_READING_TOOL_NAME } from '../lib/reading-tool.js'
import { bootMinimalContext, type MinimalContext } from './minimal-context.js'
import {
  CAPACITY,
  MODEL,
  PROVIDER,
  READING_CALL_ID,
  ScriptedAdapter,
  takeTurn,
  textOf,
  toolResults,
} from './scripted-provider.js'
import { pressureOf } from './token-projections.js'

/** The reading's pressure line, which must never carry a composition-derived figure. */
function pressureLine(reading: string): string {
  return reading.split('\n').find((line) => line.startsWith('Pressure')) ?? ''
}

/** Dispatch `context_reading` through the registry, as the loop does. */
function invokeReading(ctx: Context, agent: Agent | undefined): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: ToolCallId('reading'),
    name: CONTEXT_READING_TOOL_NAME,
    arguments: {},
    agent,
    signal: new AbortController().signal,
  })
}

/**
 * The canonical value of a successful dispatch. The registry validates every
 * value against the tool's declared `output.schema`, so reading it here is also
 * what proves an unknown reading is a valid value rather than a rejected one.
 * @param result - the settled dispatch result.
 * @returns the canonical value.
 */
function valueOf(result: ToolExecutionResult) {
  if (result.isError) throw new Error(`context_reading failed: ${result.error.message}`)
  return result.value
}

describe('context_reading in a booted agent loop', () => {
  let booted: MinimalContext | undefined

  afterEach(async () => {
    await booted?.dispose()
    booted = undefined
  })

  it('reads live session state: unknown on a fresh session, then the measured figures', async () => {
    booted = await bootMinimalContext()
    const { ctx, harness } = booted
    ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter(CAPACITY))
    await ctx.plugin(ContextSense)
    const agent = await harness.create(SessionId('agent-1'), { provider: PROVIDER, model: MODEL })

    // Nothing has been measured yet: no route, no usage sample, empty surface.
    const fresh = await invokeReading(ctx, agent)
    const freshReading = textOf(fresh.content)
    expect(fresh.isError).toBe(false)
    expect(freshReading).toContain('Capacity (route-metadata): unknown')
    expect(freshReading).toContain('Pressure: unknown')
    // An unmeasured pressure is never filled in from composition: the line
    // carries no figure at all.
    expect(pressureLine(freshReading)).not.toMatch(/\d/)
    // The canonical value carries no figure it did not measure, and the
    // registry accepted it against the declared output schema.
    expect(valueOf(fresh)).toEqual({
      capacity: { known: false, provenance: 'route-metadata' },
      pressure: { state: 'unknown' },
      composition: { known: true, provenance: 'heuristic', systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
    })

    // The tool writes nothing: dispatching it leaves the derived history alone.
    const before = agent.session.deriveMessages()
    await invokeReading(ctx, agent)
    expect(agent.session.deriveMessages()).toEqual(before)

    await takeTurn(agent, 'what does my context look like?')

    const measured = await invokeReading(ctx, agent)
    const reading = textOf(measured.content)
    expect(reading).toContain(`Capacity (route-metadata): ${CAPACITY} tokens`)
    // The figure is the harness's own numerator, not a recomputation of it.
    expect(reading).toContain(`Pressure (provider-anchored): ${pressureOf(ctx, agent)} tokens`)
    expect(reading).toMatch(/ratio and remaining room: not available/i)
  })

  it('reports the provider-anchored pressure rather than the composition total', async () => {
    booted = await bootMinimalContext()
    const { ctx, harness } = booted
    const adapter = new ScriptedAdapter(CAPACITY, { askForReading: true })
    ctx.llm.registerAdapter([PROVIDER], adapter)
    await ctx.plugin(ContextSense)
    const agent = await harness.create(SessionId('agent-1'), { provider: PROVIDER, model: MODEL })

    await takeTurn(agent, 'what does my context look like?')

    // The model asked for the reading itself, and the tool result is what it
    // reads back on the next request.
    expect(adapter.requests).toHaveLength(2)
    const results = toolResults(adapter.requests[1]!, READING_CALL_ID)
    expect(results).toHaveLength(1)
    const reading = results.map((block) => (block.type === 'tool-result' ? textOf(block.content) : '')).join('')

    // Read the two figures out of the text the model actually received.
    const reported = Number(/Pressure \(provider-anchored\): (\d+) tokens/.exec(reading)?.[1])
    const composition = /system (\d+), tool definitions (\d+), messages (\d+)/.exec(reading)
    const compositionTotal = composition
      ? Number(composition[1]) + Number(composition[2]) + Number(composition[3])
      : Number.NaN

    expect(reading).toContain(`Capacity (route-metadata): ${agent.session.requestContext()?.contextWindow} tokens`)
    expect(reading).toMatch(/not a total, and not expected to sum to pressure/)
    // The composition heuristic and the provider-anchored projection are
    // different computations, and this reading really does carry different
    // numbers — so the assertion below is evidence rather than an accident.
    expect(Number.isInteger(reported)).toBe(true)
    expect(compositionTotal).not.toBe(reported)
    // ...and the composition total is never what the model is handed as
    // pressure, in any line of the reading.
    expect(pressureLine(reading)).not.toContain(String(compositionTotal))
  })

  it('reports unknown rather than failing when the execution has no agent', async () => {
    booted = await bootMinimalContext()
    const { ctx } = booted
    await ctx.plugin(ContextSense)

    const result = await invokeReading(ctx, undefined)

    expect(result.isError).toBe(false)
    const reading = textOf(result.content)
    expect(reading).toContain('Capacity (route-metadata): unknown')
    expect(reading).toContain('Pressure: unknown')
    expect(reading).toContain('Composition (heuristic, approximate): unknown')
    expect(valueOf(result)).toEqual({
      capacity: { known: false, provenance: 'route-metadata' },
      pressure: { state: 'unknown' },
      composition: { known: false, provenance: 'heuristic' },
    })
  })
})
