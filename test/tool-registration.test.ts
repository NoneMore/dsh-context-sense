import type { Context } from '@deepseek-ai/cordis'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import * as ContextSense from '../lib/index.js'
import { CONTEXT_READING_TOOL_NAME } from '../lib/reading-tool.js'
import { assembleFor, capacitySections } from './capacity-statement.js'
import { minimalContextFixture } from './minimal-context.js'

/** The `context_reading` schemas visible in one scope, which must be exactly one. */
function readingTools(ctx: Context, scope: ScopeKey | undefined) {
  return ctx.tools.schemas(scope).filter((tool) => tool.name === CONTEXT_READING_TOOL_NAME)
}

describe('context_reading registration', () => {
  const boot = minimalContextFixture()

  it('registers exactly one context_reading tool in the scope of every agent', async () => {
    const { ctx, harness } = await boot()
    const first = await harness.create(SessionId('agent-1'))
    await ctx.plugin(ContextSense)
    const second = await harness.create(SessionId('agent-2'))

    expect(readingTools(ctx, scopeOf(first.ctx))).toHaveLength(1)
    expect(readingTools(ctx, scopeOf(second.ctx))).toHaveLength(1)
    // Registered once, not once per agent: the global view holds one too.
    expect(readingTools(ctx, undefined)).toHaveLength(1)
  })

  it('declares no parameters, so the model calls it with an empty object', async () => {
    const { ctx } = await boot()
    await ctx.plugin(ContextSense)

    const [tool] = readingTools(ctx, undefined)
    expect(tool?.parameters).toEqual({ type: 'object', properties: {} })
  })

  it('registers under the name the capacity statement tells the model to call, uncontested', async () => {
    const { ctx, harness } = await boot()
    const agent = await harness.create(SessionId('agent-1'))

    await ctx.plugin(ContextSense)

    expect(readingTools(ctx, scopeOf(agent.ctx))).toHaveLength(1)
    // The name the model reads in the statement is the name the registry took,
    // so following the statement reaches this tool and no other.
    const statement = (await assembleFor(ctx, agent)).sections.map((section) => section.text).join('\n')
    expect(statement).toContain(CONTEXT_READING_TOOL_NAME)
    // This composition mounts no built-in tools, so the only collision that can
    // be observed here is the registry's own rule: a second tool under the same
    // name in the same layer is refused. Nothing held this name before.
    const registered = ctx.tools.get(CONTEXT_READING_TOOL_NAME)
    expect(registered).toBeDefined()
    expect(() => ctx.tools.register(registered!)).toThrow()
  })

  it('has its own enable flag: disabling the tool leaves the capacity statement alone', async () => {
    const { ctx, harness } = await boot()
    const agent = await harness.create(SessionId('agent-1'))

    await ctx.plugin(ContextSense, { tool: { enabled: false } })

    expect(readingTools(ctx, scopeOf(agent.ctx))).toHaveLength(0)
    expect(await capacitySections(ctx, agent)).toHaveLength(1)
  })

  it('has its own enable flag: disabling the statement leaves the tool alone', async () => {
    const { ctx, harness } = await boot()
    const agent = await harness.create(SessionId('agent-1'))

    await ctx.plugin(ContextSense, { statement: { enabled: false } })

    expect(readingTools(ctx, scopeOf(agent.ctx))).toHaveLength(1)
    expect(await capacitySections(ctx, agent)).toHaveLength(0)
  })

  it('unregisters the tool when the plugin unloads', async () => {
    const { ctx, harness } = await boot()
    const agent = await harness.create(SessionId('agent-1'))
    const fiber = ctx.plugin(ContextSense)
    await fiber
    expect(readingTools(ctx, scopeOf(agent.ctx))).toHaveLength(1)

    await fiber.dispose()

    expect(readingTools(ctx, scopeOf(agent.ctx))).toHaveLength(0)
  })
})
