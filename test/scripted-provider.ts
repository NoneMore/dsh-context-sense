import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import { CONTEXT_READING_TOOL_NAME } from '../lib/reading-tool.js'

/** The provider route the scripted adapter registers under. */
export const PROVIDER = 'scripted'
/** The model id the scripted adapter resolves. */
export const MODEL = 'scripted-model'
/** The capacity the scripted route advertises, which the harness records as route metadata. */
export const CAPACITY = 131_072
/** A second registered route, so a test can move a session from one capacity to another. */
export const OTHER_PROVIDER = 'scripted-small'
/** The model id the second route resolves. */
export const OTHER_MODEL = 'scripted-small-model'
/** The capacity the second route advertises, small enough that a stale sample would look dire. */
export const SMALL_CAPACITY = 8_192
/** The prompt size the scripted provider reports for a request with no messages. */
export const BASE_INPUT_TOKENS = 100
/** The prompt size the scripted provider adds per message, so pressure moves with the surface. */
export const TOKENS_PER_MESSAGE = 10
/** The call id the scripted provider uses when it asks for a context reading. */
export const READING_CALL_ID = 'call-1'

/** How {@link ScriptedAdapter} should script its responses. */
export interface ScriptedAdapterOptions {
  /** Ask for one `context_reading` call on the first request, then answer in text. */
  readonly askForReading?: boolean
  /** The prompt size reported for a request with no messages; defaults to {@link BASE_INPUT_TOKENS}. */
  readonly baseInputTokens?: number
}

/**
 * A deterministic provider for booted-loop tests: it records every request the
 * loop assembles and reports the prompt size it actually received, so the
 * harness's pressure figure moves as the surface grows.
 */
export class ScriptedAdapter extends LlmAdapter {
  /** Every request the loop assembled, in order. */
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly contextWindow: number,
    private readonly options: ScriptedAdapterOptions = {},
  ) {
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
    const base = this.options.baseInputTokens ?? BASE_INPUT_TOKENS
    const inputTokens = base + TOKENS_PER_MESSAGE * options.messages.length
    const usage = { inputTokens, outputTokens: 2, totalTokens: inputTokens + 2 }
    if (this.options.askForReading && this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: ToolCallId(READING_CALL_ID),
          name: CONTEXT_READING_TOOL_NAME,
          arguments: '{}',
        },
      }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'acknowledged' } }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The text blocks of one message or result, joined. */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
}

/** The assembled system prompt the provider received for one request. */
export function systemPromptOf(request: GenerateOptions): string {
  return request.messages
    .filter((message) => message.role === 'system')
    .map((message) => textOf(message.content))
    .join('\n')
}

/** Every tool-result block one request carried for one call id. */
export function toolResults(request: GenerateOptions, toolCallId: string): ContentBlock[] {
  return request.messages.flatMap((message) =>
    message.content.filter((block) => block.type === 'tool-result' && block.toolCallId === toolCallId),
  )
}

/** Ask for one turn and wait for the loop to go quiet again. */
export async function takeTurn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}
