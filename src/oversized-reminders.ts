/**
 * The `tools/post-execute` listener that reports oversized tool results.
 *
 * It prices the raw dispatch result through the token meter — the one public
 * pricing seam, and the sole reason `tokenMeter` is injected — and attaches a
 * one-line advisory to the decision the waterfall returns, so the model hears
 * about a result while that result is still attached to its own step. It never
 * replaces content and never blocks a call: adding context is not a veto, so
 * every other listener's contribution travels on exactly as it was.
 *
 * @module dsh-context-sense/oversized-reminders
 */
import type { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
// Type-only and deliberately unbound: this is the module augmentation that
// declares `ctx.tokenMeter`, the one seam this rule prices every result through.
import type {} from '@deepseek-ai/dsh-token-meter'

import {
  decideOversizedResultReminder,
  oversizedResultReminderMessage,
  type OversizedResultPolicy,
  type OversizedResultReminder,
} from './reminder.js'
import { CONTEXT_SENSE_KEY } from './session-state.js'

/**
 * Register the oversized-result listener for the lifetime of `ctx`.
 *
 * It is registered `{ prepend: true }`, which puts it first in the dispatch list
 * and therefore last in the code that runs after `await next()`. That is what
 * the reminder's delivery needs: the context it attaches is folded into the
 * decision every other listener has already finished with, so a listener that
 * rebuilds the decision from the accept shape alone cannot drop it. It always
 * delegates first, and folds second, so a downstream listener may still block
 * the call or replace its content and this plugin's context survives either way.
 *
 * Unloading the plugin disposes the listener with everything else on its fiber,
 * so a removed plugin reports nothing on the very next call.
 * @param ctx - the plugin's context.
 * @param policy - the validated oversized-result policy to decide against.
 */
export function installOversizedResultReminders(ctx: Context, policy: OversizedResultPolicy): void {
  ctx.on(
    'tools/post-execute',
    async (exec, result, next) => {
      // Decided before `next()` and from the raw result only: this is the one
      // point that can both see the pre-finalization content and attach context.
      const reminder = oversizedReminderFor(ctx, exec, result, policy)
      const decision = await next()
      if (reminder === undefined) return decision
      return withAdditionalContext(decision, oversizedResultReminderMessage(reminder))
    },
    { prepend: true },
  )
}

/**
 * The reminder one call's raw result is owed, if any.
 *
 * The capacity is the same route metadata the standing statement and the
 * reading are built from, and the suppression facts are the plugin's own folded
 * state, which a child rebuilds from its own suffix: an inherited step start
 * must never masquerade as the child's current step.
 * @param ctx - the plugin's context, holding the meter and the session memory.
 * @param exec - the call that just ran.
 * @param result - the raw dispatch outcome, before finalization and before any replacement.
 * @param policy - the validated oversized-result policy.
 * @returns the reminder, or `undefined` when the call is owed none.
 */
function oversizedReminderFor(
  ctx: Context,
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  policy: OversizedResultPolicy,
): OversizedResultReminder | undefined {
  const agent = exec.agent
  // A call with no owning agent has no session: no route capacity, no folded
  // step facts, and nowhere for a reminder to belong.
  if (agent === undefined) return undefined
  const state = ctx.sessionProjections.stateOf(agent.session, CONTEXT_SENSE_KEY)
  if (state === undefined) return undefined
  // The raw result, priced as the very tool-result message the loop will commit
  // for it: the same blocks, the same call identity, the same failure flag.
  const estimatedTokens = ctx.tokenMeter.estimateMessage(
    createToolResultMessage({ callId: exec.callId, content: result.content, isError: result.isError }),
  )
  return decideOversizedResultReminder({
    toolName: exec.name,
    estimatedTokens,
    capacity: agent.session.requestContext()?.contextWindow,
    policy,
    state,
  })
}

/**
 * Add one context message to whichever post-execute decision came back.
 *
 * A block decision is as much a decision to enrich as an accept one, and both
 * variants carry `additionalContexts`: the reminder must not turn a downstream
 * block into an accept, nor replace the content another listener chose.
 * @param decision - the decision the waterfall returned.
 * @param message - the reminder to attach after every context already there.
 * @returns the same decision, with one more attached context.
 */
function withAdditionalContext(decision: PostToolDecision, message: UserMessage): PostToolDecision {
  return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), message] }
}
