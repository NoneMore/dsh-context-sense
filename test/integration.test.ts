import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it } from 'vitest'

import * as ContextSense from '../lib/index.js'
import { bootMinimalContext, type MinimalContext } from './minimal-context.js'

const PROVIDER = 'scripted'
const MODEL = 'scripted-model'
const CAPACITY = 131_072
const BASE_INPUT_TOKENS = 100
const TOKENS_PER_MESSAGE = 10

/**
 * A deterministic provider: it records every request the loop assembles and
 * answers each one with one short text block. It advertises one route capacity,
 * which is what the harness records as the session's route metadata.
 */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    // Report the prompt size actually received, as a provider does, so the
    // harness's pressure figure moves as the surface grows.
    const inputTokens = BASE_INPUT_TOKENS + TOKENS_PER_MESSAGE * options.messages.length
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'acknowledged' } }
    yield { type: 'usage', usage: { inputTokens, outputTokens: 2, totalTokens: inputTokens + 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The text blocks of one message, joined. */
function textOf(message: Message): string {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
}

/** The assembled system prompt the provider received for one request. */
function systemPromptOf(request: GenerateOptions): string {
  return request.messages.filter((message) => message.role === 'system').map(textOf).join('\n')
}

/**
 * The pressure figure the harness currently projects for one agent, if any —
 * the same numerator the human context meter shows. Read through `snapshot`,
 * which returns the client-visible value; the raw host state behind it holds
 * `surfaceTokens` and derives this figure in its view.
 */
function pressureOf(ctx: Context, agent: Agent): number | undefined {
  const projections = ctx.get('sessionProjections') as SessionProjectionRegistry
  const { contextPressure } = projections.snapshot(agent.session, ['contextPressure']).values
  return contextPressure?.projectedTokens ?? contextPressure?.pressureTokens
}

/** Ask for one turn and wait for the loop to go quiet again. */
async function takeTurn(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('capacity statement in a booted agent loop', () => {
  let booted: MinimalContext | undefined

  afterEach(async () => {
    await booted?.dispose()
    booted = undefined
  })

  it('reads not yet known on the first request and the route capacity once one is recorded', async () => {
    booted = await bootMinimalContext()
    const { ctx, harness } = booted
    const adapter = new ScriptedAdapter(CAPACITY)
    ctx.llm.registerAdapter([PROVIDER], adapter)
    await ctx.plugin(ContextSense)
    const agent = await harness.create(SessionId('agent-1'), { provider: PROVIDER, model: MODEL })

    await takeTurn(agent, 'first')
    await takeTurn(agent, 'second')

    expect(adapter.requests).toHaveLength(2)
    const [first, second] = adapter.requests
    expect(systemPromptOf(first!)).toContain('not yet known')
    expect(systemPromptOf(second!)).toContain(String(CAPACITY))
    expect(systemPromptOf(second!)).not.toContain('not yet known')
  })

  it('holds the statement still while pressure moves, so the request prefix stays stable', async () => {
    booted = await bootMinimalContext()
    const { ctx, harness } = booted
    const adapter = new ScriptedAdapter(CAPACITY)
    ctx.llm.registerAdapter([PROVIDER], adapter)
    await ctx.plugin(ContextSense)
    const agent = await harness.create(SessionId('agent-1'), { provider: PROVIDER, model: MODEL })

    // The first request records the route; from the second on, capacity is
    // known and each request reports a new provider usage sample.
    await takeTurn(agent, 'first')
    await takeTurn(agent, 'second')
    const pressureAtSecond = pressureOf(ctx, agent)
    await takeTurn(agent, 'third')
    const pressureAtThird = pressureOf(ctx, agent)

    const [, second, third] = adapter.requests
    expect(systemPromptOf(second!)).toEqual(systemPromptOf(third!))
    expect(systemPromptOf(third!)).toContain(String(CAPACITY))
    // The statement is stable because it carries capacity only: the pressure
    // it deliberately leaves out really did move between these two requests.
    expect(pressureAtSecond).toBeTypeOf('number')
    expect(pressureAtThird).toBeGreaterThan(pressureAtSecond!)
  })
})
