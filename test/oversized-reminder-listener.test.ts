/**
 * Oversized-result reminders against a real booted agent loop.
 *
 * The pure core is covered in `oversized-reminder.test.ts`; these tests drive
 * real tool calls through the production pipeline and assert what the model and
 * the durable log actually receive. The fixtures are deliberately two results of
 * the same size, one suppressed and one not, so the assertions cannot pass on
 * the mere presence of a large result.
 *
 * @module test/oversized-reminder-listener
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'

import * as ContextSense from '../lib/index.js'
import type { OversizedResultMode } from '../lib/reminder.js'
import { CONTEXT_SENSE_KEY, pressureTierSectionName } from '../lib/session-state.js'
import { capacitySections } from './capacity-statement.js'
import { bootMinimalContext, type MinimalContext } from './minimal-context.js'
import {
  committedNotices,
  committedReminderSections,
  pluginMessagesInRequest,
} from './plugin-messages.js'
import { MODEL, PROVIDER, ScriptedAdapter, takeTurn, toolResultTexts } from './scripted-provider.js'

/** A capacity small enough that a few hundred tokens is a large share of it. */
const CAPACITY = 1_000

/** The fixed threshold these tests configure: below the oversized fixture's price, so it is over it. */
const TOKENS = 1_000

/** The share these tests configure when they select the share form: a tenth of the window, so 100 tokens. */
const SHARE = 0.1

/**
 * The oversized fixture's text. Its 4000 characters price at 1012 tokens under
 * the harness's own fixed heuristic — 4 characters per token, 4 tokens of block
 * overhead inside the tool-result block, 4 for the block itself and 4 for the
 * message's role framing — which is over both triggers below.
 */
const BULK_TEXT = 'x'.repeat(4_000)

/** The price {@link BULK_TEXT} carries, worked out from the harness's heuristic rather than from the code under test. */
const BULK_TOKENS = 1_012

/** What the shrinking fixture leaves the model: 14 characters, far below either trigger. */
const SHRUNK_TEXT = 'a short result'

/** The under-threshold fixture's text. */
const SMALL_TEXT = 'ok'

/** The tool the oversized fixture is registered under. */
const BULK_TOOL = 'bulk_result'

/** The tool that shrinks its own result before the model sees it. */
const SHRINKING_TOOL = 'shrinking_result'

/** The tool whose result is under the trigger. */
const SMALL_TOOL = 'small_result'

/** The canonical value every fixture returns: one string the definition renders. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', required: true } },
} as const satisfies ValueSchemaSpec

/**
 * A tool that returns one result of the given text, optionally shrinking it in
 * `finalizeContent` — the last-mile transform the registry applies AFTER
 * `tools/post-execute`, which is exactly the seam this rule is pinned to.
 * @param name - the tool's model-facing name.
 * @param text - the text the raw result carries.
 * @param shrunken - the text `finalizeContent` replaces it with, when the fixture shrinks.
 * @returns the registry-ready definition.
 */
function resultTool(name: string, text: string, shrunken?: string): ToolDefinition {
  return defineTool({
    name,
    description: `Returns one result of ${text.length} characters.`,
    parameters: {},
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: () => Promise.resolve({ text }),
    ...(shrunken === undefined ? {} : { finalizeContent: () => [{ type: 'text', text: shrunken }] }),
  })
}

/** One booted loop with the oversized rule configured, and the agent it serves. */
interface OversizedLoop extends MinimalContext {
  readonly agent: Agent
  readonly adapter: ScriptedAdapter
  /** The plugin's fiber, so a test can unload it mid-session. */
  readonly fiber: { dispose(): Promise<void> }
}

/**
 * Append one of this plugin's own tier reminders to a live session, in the shape
 * the plugin commits it, so the fold records a tier that went out at whatever
 * step the session is on — which is what a forked child inherits and must not
 * read as its own.
 * @param session - the session to write into.
 */
function appendTierReminder(session: Session): void {
  const section = pressureTierSectionName(0)
  const text = `${section} reminder`
  session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: ContextSense.name, form: 'snapshot', sections: [{ name: section, text }] },
    }),
    { surfaceOp: 'append' },
  )
}

describe('oversized-result reminders in a booted agent loop', () => {
  let booted: OversizedLoop | undefined

  afterEach(async () => {
    await booted?.dispose()
    booted = undefined
  })

  /**
   * Boot the loop with a route, the fixtures and the reminder policy in force.
   *
   * Tier reminders default to off here so that an oversized-result assertion
   * cannot be satisfied by a tier reminder by accident; the cases that need both
   * switch them on explicitly. The oversized rule defaults to the fixed form,
   * with the threshold below the oversized fixture's price; a case that selects
   * the share form names it, because a configuration may only carry the field of
   * the form in force.
   * @param options - the capacity, the tier policy, the oversized form and its figure, the tools to register, the scripted tool calls and listeners to register ahead of the plugin.
   * @returns the booted loop, its agent, its plugin fiber and the scripted provider.
   */
  async function boot(
    options: {
      capacity?: number | undefined
      tiersEnabled?: boolean
      tiers?: readonly number[]
      oversizedEnabled?: boolean
      mode?: OversizedResultMode
      tokens?: number
      share?: number
      tools?: readonly ToolDefinition[]
      callTool?: string
      toolCallOn?: readonly number[]
      twoToolCallsOn?: readonly number[]
      before?: (ctx: Context) => void
    } = {},
  ): Promise<OversizedLoop> {
    const context = await bootMinimalContext()
    const adapter = new ScriptedAdapter('capacity' in options ? options.capacity : CAPACITY, {
      ...(options.callTool === undefined ? {} : { callTool: options.callTool }),
      ...(options.toolCallOn === undefined ? {} : { toolCallOn: options.toolCallOn }),
      ...(options.twoToolCallsOn === undefined ? {} : { twoToolCallsOn: options.twoToolCallsOn }),
    })
    context.ctx.llm.registerAdapter([PROVIDER], adapter)
    for (const tool of options.tools ?? []) context.ctx.tools.register(tool)
    // Ahead of the plugin, so a listener registered here is downstream of the
    // plugin's own `{ prepend: true }` handler.
    options.before?.(context.ctx)
    const enabled = options.oversizedEnabled ?? true
    const oversized =
      options.mode === 'share'
        ? { enabled, mode: 'share' as const, share: options.share ?? SHARE }
        : { enabled, mode: 'tokens' as const, tokens: options.tokens ?? TOKENS }
    const fiber = context.ctx.plugin(ContextSense, {
      reminders: {
        enabled: options.tiersEnabled ?? false,
        tiers: [...(options.tiers ?? [])],
        compactionThresholdRatio: 0.8,
        oversized,
      },
    })
    await fiber
    const agent = await context.harness.create(SessionId('agent-1'), { provider: PROVIDER, model: MODEL })
    return (booted = { ...context, agent, adapter, fiber })
  }

  it('reports a raw result over the fixed threshold while no route has advertised a window', async () => {
    const { agent, adapter } = await boot({
      capacity: undefined,
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      callTool: BULK_TOOL,
      toolCallOn: [1],
    })

    await takeTurn(agent, 'the first step of this session')

    const notices = committedNotices(agent.session)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.text).toContain(`\`${BULK_TOOL}\``)
    // The size is the harness's own estimate of the raw result, not a count this
    // plugin made up: 4000 characters really do price at 1012 tokens.
    expect(notices[0]!.text).toContain(`${BULK_TOKENS} tokens`)
    expect(notices[0]!.text).toContain(`${TOKENS}-token threshold`)
    // The point of the fixed form: an absolute count needs no denominator, so
    // the report arrives in the fresh session a share could say nothing about.
    expect(notices[0]!.text).toContain("the current route's context capacity is not known")
    expect(notices[0]!.text).not.toContain('context window')
    expect(notices[0]!.text).toContain('<system-reminder>')
    expect(notices[0]!.summary).toContain(BULK_TOOL)

    // The premise: the result really did reach the model, one step after the
    // call, and the advisory rode that same step.
    expect(toolResultTexts(adapter.requests[1]!)).toEqual([BULK_TEXT])
    expect(pluginMessagesInRequest(adapter, 1, 'notice')).toEqual([notices[0]!.text])
  })

  it('quotes the price as a share of the advertised window in the same fixed form', async () => {
    const { agent, adapter } = await boot({
      capacity: CAPACITY,
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      callTool: BULK_TOOL,
      toolCallOn: [1],
    })

    await takeTurn(agent, 'the first step of this session')

    const [notice] = committedNotices(agent.session)
    // 1012 tokens against a 1000-token window is 101.2%, and the report states
    // the threshold it is over as well as the window it fills.
    expect(notice?.text).toContain(`${BULK_TOKENS} tokens`)
    expect(notice?.text).toContain('101.2%')
    expect(notice?.text).toContain(`${CAPACITY}-token context window`)
    expect(notice?.text).toContain(`${TOKENS}-token threshold`)
    expect(notice?.text).not.toContain('capacity is not known')
    expect(pluginMessagesInRequest(adapter, 1, 'notice')).toEqual([notice!.text])
  })

  it('leaves a result under the fixed threshold quiet', async () => {
    const { agent, adapter } = await boot({
      tools: [resultTool(SMALL_TOOL, SMALL_TEXT)],
      callTool: SMALL_TOOL,
      toolCallOn: [1],
    })

    await takeTurn(agent, 'the first step of this session')

    // The premise: the call ran and its result reached the model, so the absence
    // below is the threshold's doing rather than a call that never happened.
    expect(toolResultTexts(adapter.requests[1]!)).toEqual([SMALL_TEXT])
    expect(committedNotices(agent.session)).toEqual([])
    expect(pluginMessagesInRequest(adapter, 1, 'notice')).toEqual([])
  })

  it('treats a result priced exactly at the threshold as not over it', async () => {
    const { agent, adapter } = await boot({
      capacity: undefined,
      // The oversized fixture's own price, worked out from the harness's
      // heuristic rather than from the code under test.
      tokens: BULK_TOKENS,
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      callTool: BULK_TOOL,
      toolCallOn: [1],
    })

    await takeTurn(agent, 'the first step of this session')

    // The call ran and its result — all 1012 priced tokens of it — reached the
    // model, and the fixed form reports only what exceeds its threshold.
    expect(toolResultTexts(adapter.requests[1]!)).toEqual([BULK_TEXT])
    expect(committedNotices(agent.session)).toEqual([])
  })

  it('reports each oversized result of one step in its turn', async () => {
    const { agent, adapter } = await boot({
      capacity: undefined,
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      callTool: BULK_TOOL,
      twoToolCallsOn: [1],
    })

    await takeTurn(agent, 'one step that returns two oversized results')

    // Both calls ran in the same step and both results reached the model.
    expect(toolResultTexts(adapter.requests[1]!)).toEqual([BULK_TEXT, BULK_TEXT])
    // Nothing records that a report went out, so the second result is reported
    // in its turn rather than silenced by the first — the rule's value is
    // arriving attached to the result that produced it.
    expect(committedNotices(agent.session)).toHaveLength(2)
    expect(pluginMessagesInRequest(adapter, 1, 'notice')).toHaveLength(2)
  })

  it('reports a child’s own first result when the inherited prefix looks like a suppressed step', async () => {
    const { ctx, agent: parent, adapter } = await boot({
      capacity: undefined,
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      callTool: BULK_TOOL,
      toolCallOn: [2],
    })

    // The parent completes one step, and a pressure-tier reminder goes out at
    // that same step — so the parent's own folded facts would withhold an
    // oversized report in it, and turn and step numbers restart at 1 in a child.
    await takeTurn(parent, 'a turn the parent completes')
    appendTierReminder(parent.session)
    const parentState = ctx.sessionProjections.stateOf(parent.session, CONTEXT_SENSE_KEY)
    expect(parentState?.cursor).toEqual({ turn: 1, step: 1 })
    expect(parentState?.pressureReminder).toEqual({ turn: 1, step: 1 })

    const seed = parent.session.snapshotEvents()
    const child = await ctx.agents.create({
      sessionId: SessionId('child'),
      parentAgent: parent,
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { isSeeded: true, parentSession: parent.id },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })

    // The cut is real and non-zero, and neither inherited fact is the child's
    // own: an inherited pair that reads as the child's first step must not
    // masquerade as one of its own.
    expect(child.agent.session.inheritedEventCount).toBe(seed.length)
    expect(child.agent.session.inheritedEventCount).toBeGreaterThan(0)
    expect(ctx.sessionProjections.stateOf(child.agent.session, CONTEXT_SENSE_KEY)?.cursor).toBeNull()
    expect(ctx.sessionProjections.stateOf(child.agent.session, CONTEXT_SENSE_KEY)?.pressureReminder).toBeNull()

    await takeTurn(child.agent, 'the child’s first step')

    // The premise: the child's call ran — request 2, the parent having made
    // request 1 — and its result reached the model on the request that follows it.
    expect(toolResultTexts(adapter.requests[2]!)).toEqual([BULK_TEXT])
    expect(committedNotices(child.agent.session)).toHaveLength(1)
  })

  it('keeps the share form’s meaning: reported against an advertised window', async () => {
    const { agent, adapter } = await boot({
      capacity: CAPACITY,
      mode: 'share',
      share: SHARE,
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      callTool: BULK_TOOL,
      toolCallOn: [1],
    })

    await takeTurn(agent, 'the first step of this session')

    const [notice] = committedNotices(agent.session)
    expect(notice?.text).toContain(`${BULK_TOKENS} tokens`)
    expect(notice?.text).toContain(`${CAPACITY}-token context window`)
    expect(notice?.text).toContain('10% share')
    expect(pluginMessagesInRequest(adapter, 1, 'notice')).toEqual([notice!.text])
  })

  it('reports nothing under the share form while no route has advertised a window', async () => {
    const { agent, adapter } = await boot({
      capacity: undefined,
      mode: 'share',
      share: SHARE,
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      callTool: BULK_TOOL,
      toolCallOn: [1],
    })

    await takeTurn(agent, 'the first step of this session')

    // A share is a share OF a window: the same oversized result that the fixed
    // form reports above is not a fact this form can state.
    expect(toolResultTexts(adapter.requests[1]!)).toEqual([BULK_TEXT])
    expect(committedNotices(agent.session)).toEqual([])
    expect(pluginMessagesInRequest(adapter, 1, 'notice')).toEqual([])
  })

  it('prices the raw dispatch result, so a tool that shrinks its own content still triggers', async () => {
    const { agent, adapter } = await boot({
      tools: [resultTool(SHRINKING_TOOL, BULK_TEXT, SHRUNK_TEXT)],
      callTool: SHRINKING_TOOL,
      toolCallOn: [1],
    })

    await takeTurn(agent, 'the first step of this session')

    // What the model received is the tool's own shrunken result. The threshold is
    // 1000 tokens, which the harness's 4-characters-per-token heuristic reaches
    // only past 4000 characters — and this result is 14, so the final content was
    // never over the threshold at all.
    expect(toolResultTexts(adapter.requests[1]!)).toEqual([SHRUNK_TEXT])
    expect(SHRUNK_TEXT.length).toBeLessThan(4_000)

    // The reminder still speaks, because `tools/post-execute` runs before the
    // definition's `finalizeContent` and the only seam that sees the final
    // content cannot attach context. Over-warning here is the documented cost.
    const [notice] = committedNotices(agent.session)
    expect(notice?.text).toContain(`${BULK_TOKENS} tokens`)
    expect(pluginMessagesInRequest(adapter, 1, 'notice')).toEqual([notice!.text])
  })

  it('suppresses itself in the step a pressure-tier reminder went out at, and only there', async () => {
    const { agent, adapter } = await boot({
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      tiersEnabled: true,
      tiers: [0.05],
      callTool: BULK_TOOL,
      toolCallOn: [2, 3],
    })

    // The first turn measures the session and ends in text, so the second turn's
    // pre-step is the first with a real, route-coherent ratio to decide on.
    await takeTurn(agent, 'the first step of this session')
    await takeTurn(agent, 'a second step')

    // The premise: the tier reminder went out in the step whose own tool result
    // is withheld, and the step after it carries a result of exactly the same
    // size without one. The first result is on the surface of both requests, so
    // the last one holds two results of the same fixture text.
    expect(committedReminderSections(agent.session)).toEqual([pressureTierSectionName(0)])
    expect(adapter.requests).toHaveLength(4)
    expect(toolResultTexts(adapter.requests[2]!)).toEqual([BULK_TEXT])
    expect(toolResultTexts(adapter.requests[3]!)).toEqual([BULK_TEXT, BULK_TEXT])

    // The step that followed step 1's result is owed nothing: the tier signal
    // already told the model about this step's context.
    expect(pluginMessagesInRequest(adapter, 2, 'notice')).toEqual([])
    // The step that followed step 2's result — a step no tier reminder went out
    // at — is owed one, so the rule is not simply never firing.
    const notices = committedNotices(agent.session)
    expect(notices).toHaveLength(1)
    expect(pluginMessagesInRequest(adapter, 3, 'notice')).toEqual([notices[0]!.text])
  })

  it('has its own enable flag: switching it off leaves the tier reminder alone', async () => {
    const { agent, adapter } = await boot({
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      tiersEnabled: true,
      tiers: [0.05],
      oversizedEnabled: false,
      callTool: BULK_TOOL,
      toolCallOn: [2],
    })

    await takeTurn(agent, 'the first step of this session')
    await takeTurn(agent, 'a second step')

    // The oversized result reached the model and was reported to no one...
    expect(toolResultTexts(adapter.requests[2]!)).toEqual([BULK_TEXT])
    expect(committedNotices(agent.session)).toEqual([])
    expect(pluginMessagesInRequest(adapter, 2, 'notice')).toEqual([])
    // ...while the tier this session reached still spoke, because the two
    // switches are independent.
    expect(committedReminderSections(agent.session)).toEqual([pressureTierSectionName(0)])
  })

  it('reports oversized results while the tier reminders are switched off', async () => {
    const { agent } = await boot({
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      tiersEnabled: false,
      oversizedEnabled: true,
      callTool: BULK_TOOL,
      toolCallOn: [1],
    })

    await takeTurn(agent, 'the first step of this session')

    expect(committedReminderSections(agent.session)).toEqual([])
    expect(committedNotices(agent.session)).toHaveLength(1)
  })

  it('keeps its reminder when another listener rewrites the decision around it', async () => {
    const { agent, adapter } = await boot({
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      callTool: BULK_TOOL,
      toolCallOn: [1],
      // Registered AHEAD of the plugin, so this listener is downstream today and
      // its post-`next()` code runs after the plugin's own would — unless the
      // plugin is the outermost handler, which `{ prepend: true }` makes it. It
      // rebuilds the decision from the accept shape alone, dropping every
      // context it did not author.
      before: (pluginCtx) => {
        pluginCtx.on('tools/post-execute', async (_exec, _result, next) => {
          await next()
          return { kind: 'accept' }
        })
      },
    })

    await takeTurn(agent, 'the first step of this session')

    const notices = committedNotices(agent.session)
    expect(notices).toHaveLength(1)
    expect(pluginMessagesInRequest(adapter, 1, 'notice')).toEqual([notices[0]!.text])
  })

  it('leaves a blocked call blocked, and still attaches the context it was owed', async () => {
    const { agent, adapter } = await boot({
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      callTool: BULK_TOOL,
      toolCallOn: [1],
      before: (pluginCtx) => {
        pluginCtx.on('tools/post-execute', async () => ({
          kind: 'block',
          feedback: [{ type: 'text', text: 'that call is not allowed here' }],
        }))
      },
    })

    await takeTurn(agent, 'the first step of this session')

    // The block stands: the tool's own result never reached the model, and the
    // correction took its place.
    const delivered = toolResultTexts(adapter.requests[1]!).join('\n')
    expect(delivered).toContain('that call is not allowed here')
    expect(delivered).not.toContain(BULK_TEXT)

    // Adding context is not a veto: the reminder this call was owed rides the
    // same decision without turning the block into an accept. The notice is
    // true whatever became of the content — a raw result really was oversized.
    expect(committedNotices(agent.session)).toHaveLength(1)
    expect(pluginMessagesInRequest(adapter, 1, 'notice')).toHaveLength(1)
  })

  it('unloads its listener with the plugin, so later results are reported to no one', async () => {
    const { agent, adapter, fiber } = await boot({
      tools: [resultTool(BULK_TOOL, BULK_TEXT)],
      callTool: BULK_TOOL,
      toolCallOn: [1, 3],
    })

    await takeTurn(agent, 'first')
    expect(committedNotices(agent.session)).toHaveLength(1)

    await fiber.dispose()
    await takeTurn(agent, 'second')

    // The second turn's call produced the same oversized result, and the plugin
    // is no longer there to report it. Both results are on the surface of the
    // last request, so the assertion cannot be satisfied by a request that
    // simply carried fewer results.
    expect(toolResultTexts(adapter.requests[3]!)).toEqual([BULK_TEXT, BULK_TEXT])
    expect(committedNotices(agent.session)).toHaveLength(1)
  })
})

describe('oversized-result configuration at plugin load', () => {
  let booted: MinimalContext | undefined

  afterEach(async () => {
    await booted?.dispose()
    booted = undefined
  })

  it('fails the plugin at load on a threshold it cannot honour', async () => {
    booted = await bootMinimalContext()
    const { ctx } = booted

    // A threshold is a positive whole count of estimated tokens. Zero, a
    // fraction, a negative and a figure that is not finite are all refused
    // outright rather than clamped into something that would run.
    for (const tokens of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        ctx.plugin(ContextSense, { reminders: { oversized: { enabled: true, tokens } } }),
      ).rejects.toThrow(/oversized\.tokens/)
    }
    // The flag does not excuse the value: an unusable policy fails the plugin at
    // load whether or not the reminder it configures is switched on.
    await expect(
      ctx.plugin(ContextSense, { reminders: { oversized: { enabled: false, tokens: 0 } } }),
    ).rejects.toThrow(/oversized\.tokens/)
  })

  it('fails the plugin at load on a share it cannot honour', async () => {
    booted = await bootMinimalContext()
    const { ctx } = booted

    for (const share of [0, 1, -0.1, Number.NaN]) {
      await expect(
        ctx.plugin(ContextSense, { reminders: { oversized: { enabled: true, mode: 'share', share } } }),
      ).rejects.toThrow(/oversized\.share/)
    }
  })

  it('refuses a configuration naming the field the form in force does not use', async () => {
    booted = await bootMinimalContext()
    const { ctx } = booted

    // A configuration written for the share form now names a field the fixed
    // form does not read: it fails once, loudly, rather than running with a
    // threshold its operator never chose.
    await expect(
      ctx.plugin(ContextSense, { reminders: { oversized: { enabled: true, share: 0.1 } } }),
    ).rejects.toThrow(/oversized\.share/)
    await expect(
      ctx.plugin(ContextSense, { reminders: { oversized: { mode: 'tokens', tokens: 4_000, share: 0.1 } } }),
    ).rejects.toThrow(/oversized\.share/)
    // ...and the same in the other direction, once the share is the form chosen.
    await expect(
      ctx.plugin(ContextSense, { reminders: { oversized: { mode: 'share', share: 0.1, tokens: 4_000 } } }),
    ).rejects.toThrow(/oversized\.tokens/)
    // The flag does not excuse the contradiction either.
    await expect(
      ctx.plugin(ContextSense, { reminders: { oversized: { enabled: false, share: 0.1 } } }),
    ).rejects.toThrow(/oversized\.share/)
  })

  it('says nothing about the oversized rule, which explains itself when it fires', async () => {
    booted = await bootMinimalContext()
    const { ctx, harness } = booted
    ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter(CAPACITY))

    // The tier reminders are off and the oversized rule is on. The statement
    // names the absent tier rule rather than claiming silence — the notice is a
    // per-result account that carries its own explanation, so it is not
    // announced here, and nothing here promises it will not arrive.
    await ctx.plugin(ContextSense, {
      reminders: { enabled: false, tiers: [], oversized: { enabled: true, tokens: 250 } },
    })
    const agent = await harness.create(SessionId('agent-1'), { provider: PROVIDER, model: MODEL })

    const statement = (await capacitySections(ctx, agent)).map((section) => section.text).join('\n')
    expect(statement).toContain('no tier reminder will interrupt a step')
    expect(statement).not.toContain('larger than')
  })
})
