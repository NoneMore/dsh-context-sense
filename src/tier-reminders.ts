/**
 * The `agent/pre-step` listener that delivers tier reminders.
 *
 * It is registered `{ prepend: true }`, which puts it first in the dispatch
 * list, and it injects only after `await next()` — the one point at which the
 * step's final decision exists. Everything the decision is based on is read
 * before that call, and the reminder it computed is re-checked against the
 * folded state afterwards, because a downstream listener — compaction among
 * them — may have committed a summary compaction in between and closed the
 * epoch the reminder belonged to.
 *
 * @module dsh-context-sense/tier-reminders
 */
import type { Context } from '@deepseek-ai/cordis'

import { projectedPressureTokens } from './reading.js'
import { decideTierReminder, tierReminderMessage, type ReminderPolicy } from './reminder.js'
import { CONTEXT_SENSE_KEY, isPressureRouteCoherent } from './session-state.js'

/**
 * Register the tier-reminder listener for the lifetime of `ctx`.
 *
 * Unloading the plugin disposes the listener with everything else on its fiber,
 * so a removed plugin stops reminding on the very next step.
 * @param ctx - the plugin's context.
 * @param policy - the validated reminder policy to decide against.
 */
export function installTierReminders(ctx: Context, policy: ReminderPolicy): void {
  ctx.on(
    'agent/pre-step',
    async ({ agent, signal }, next) => {
      // (1) The pressure snapshot, read before `next()`. The projection folds
      // committed events, so this describes the surface as of the previous
      // step: the messages this step is about to claim are not in it yet.
      const { contextPressure } = ctx.sessionProjections.snapshot(agent.session, ['contextPressure']).values
      // The same route metadata the standing statement and the reading are
      // built from, so the pair the gate tests is the pair the model is shown.
      const route = agent.session.requestContext()

      // (2) The folded reminder state, and the decision. Nothing is written
      // here: the reminder stays a candidate until the step's other listeners
      // have finished with the decision.
      const stateBefore = ctx.sessionProjections.stateOf(agent.session, CONTEXT_SENSE_KEY)
      const epochBefore = stateBefore?.epoch
      const reminder =
        stateBefore === undefined
          ? undefined
          : decideTierReminder({
              pressure: projectedPressureTokens(contextPressure),
              capacity: route?.contextWindow,
              routeCoherent: isPressureRouteCoherent(stateBefore, route),
              policy,
              state: stateBefore,
            })

      // (3) Downstream listeners run here, compaction among them.
      const decision = await next()

      // A rejected step has no messages to add to, and an aborted turn has no
      // next request to inform.
      if (reminder === undefined || decision.kind !== 'enter' || signal.aborted) return decision

      // (4) Re-read the state. A summary compaction committed inside this
      // waterfall opens a new epoch, so the candidate was decided in an epoch
      // that has just closed: it is dropped, nothing is recorded as fired, and
      // the decision every other listener contributed to is returned unchanged.
      const stateAfter = ctx.sessionProjections.stateOf(agent.session, CONTEXT_SENSE_KEY)
      if (stateAfter === undefined || stateAfter.epoch !== epochBefore) return decision

      // (5) Otherwise the reminder joins the decision's messages, leaving every
      // other listener's contribution exactly as it was.
      return { ...decision, messages: [...decision.messages, tierReminderMessage(reminder)] }
    },
    { prepend: true },
  )
}
