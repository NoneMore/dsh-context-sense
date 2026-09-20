/**
 * The reminder rules: pressure tiers, and one oversized tool result.
 *
 * Two things live here. Each rule's **decision core** is a pure function of the
 * figures it reads, the configured policy and the folded reminder state —
 * nothing else. Neither reads a projection, a clock or module-level mutable
 * state, so tier eligibility, epoch re-arming and the oversized rule's
 * one-directional suppression are testable without a session, and the reading
 * the model is shown and the reading a reminder is decided from are built from
 * the same facts. The **frame** is the plugin-owned wrapper every reminder
 * travels in, with its interpolated values escaped so that nothing a figure or a
 * tool name carries can close the frame early.
 *
 * @module dsh-context-sense/reminder
 */
import { boundContextSummary, createUserMessage, type ContextSnapshotSection, type UserMessage } from '@deepseek-ai/dsh-llm'

import { PLUGIN_NAME } from './identity.js'
import { formatPercent } from './reading.js'
import { pressureTierSectionName, sameStepCursor, type StepCursor } from './session-state.js'

/** The opening tag of the frame this plugin owns around every reminder it injects. */
export const SYSTEM_REMINDER_OPEN = '<system-reminder>'

/** The closing tag of the frame this plugin owns around every reminder it injects. */
export const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/**
 * The default reminder tiers: a notice at 60% of the window and an imminent
 * reminder at 75%, both strictly below the assumed compaction threshold.
 */
export const DEFAULT_REMINDER_TIERS = [0.6, 0.75] as const

/**
 * The compaction threshold ratio the plugin assumes by default. It is an
 * operator-supplied assumption about the deployment, used only for headroom
 * wording and tier validation — the mounted policy is not readable, so it is
 * never presented as a reading of one.
 */
export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8

/**
 * What every reminder claims, and what it refuses to claim.
 *
 * One sentence, stated by the standing statement and by each reminder's body
 * alike: a reminder describes committed history rather than the request being
 * assembled, and the threshold it names is an assumption about the deployment.
 * Holding it here is what stops the two observation points drifting into
 * promising the model different things.
 */
export const REMINDER_DISCLAIMER =
  'A reminder describes committed history rather than the request being assembled, and the threshold it names is an assumed policy value, not a reading of the mounted compaction policy.'

/**
 * Escape the three characters that could otherwise be read as markup.
 *
 * `&` first, so an ampersand introduced by escaping a later character is not
 * escaped twice. Nothing else is escaped: a reminder quotes figures, and the
 * only escaping that matters is the one that keeps a value from closing the
 * frame the plugin owns.
 * @param value - a value about to be interpolated into the frame.
 * @returns the value with `&`, `<` and `>` replaced by their entities.
 */
export function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Wrap one body in the plugin-owned reminder frame.
 * @param body - the model-facing text, with every interpolated value already escaped.
 * @returns the framed text the message carries.
 */
export function systemReminderFrame(body: string): string {
  return `${SYSTEM_REMINDER_OPEN}\n${body}\n${SYSTEM_REMINDER_CLOSE}`
}

/**
 * The reminder policy: the configured tiers, and the compaction threshold this
 * deployment assumes.
 *
 * Tiers are kept exactly as configured: never clamped, dropped or reordered, so
 * a tier's position — which is its durable key — cannot change under a running
 * session.
 *
 * Whether the listener is registered at all is deliberately *not* part of this
 * type. That is a load-time decision, and a decision core able to see the flag
 * could return a reminder for a subsystem that was switched off.
 */
export interface ReminderPolicy {
  /** Reminder tier ratios, strictly ascending and strictly below the assumed threshold. */
  readonly tiers: readonly number[]
  /**
   * The compaction threshold this deployment assumes, as a fraction of the
   * context window. Used only for headroom wording and tier validation — never
   * read as the mounted compaction policy.
   */
  readonly compactionThresholdRatio: number
}

/**
 * Validate the configured policy and freeze it for the decision core.
 *
 * Validation is strict and fails loudly rather than repairing the value: a tier
 * is never clamped into range, dropped as unusable or reordered into ascending
 * order, because a tier's position is the durable key its firing is recorded
 * under and a silent repair would rewrite what a running session has already
 * announced. An unusable configuration is a deployment error, and it surfaces
 * at plugin load.
 * @param config - the reminder config block the loader row supplied.
 * @returns the frozen policy; the tiers are a detached copy in configured order.
 * @throws when the threshold is outside `(0, 1)` or a tier is not finite,
 * outside `(0, 1)`, at or above the threshold, or not strictly ascending.
 */
export function resolveReminderPolicy(config: ReminderPolicy): ReminderPolicy {
  const { tiers, compactionThresholdRatio } = config
  if (!isUnitRatio(compactionThresholdRatio)) {
    throw new Error(
      `${CONFIG_PATH}.compactionThresholdRatio must be a finite ratio strictly between 0 and 1, got ${String(compactionThresholdRatio)}`,
    )
  }
  let previous: number | undefined
  for (const [index, tier] of tiers.entries()) {
    if (!isUnitRatio(tier)) {
      throw new Error(`${CONFIG_PATH}.tiers[${index}] must be a finite ratio strictly between 0 and 1, got ${String(tier)}`)
    }
    if (tier >= compactionThresholdRatio) {
      throw new Error(
        `${CONFIG_PATH}.tiers[${index}] must be strictly below the assumed compaction threshold ratio ${String(compactionThresholdRatio)}, got ${String(tier)}`,
      )
    }
    if (previous !== undefined && tier <= previous) {
      throw new Error(
        `${CONFIG_PATH}.tiers must be strictly ascending; tiers[${index}] is ${String(tier)} after ${String(previous)}`,
      )
    }
    previous = tier
  }
  return Object.freeze({ tiers: Object.freeze([...tiers]), compactionThresholdRatio })
}

/** The diagnostic path every reminder-configuration failure names. */
const CONFIG_PATH = `${PLUGIN_NAME}: reminders`

/** Whether a value is a finite ratio strictly inside the open unit interval. */
function isUnitRatio(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 1
}

/** A ratio as a percentage, escaped for interpolation into the frame. */
function percent(ratio: number): string {
  return escapeXml(formatPercent(ratio))
}

/**
 * Decide whether this step owes the model a tier reminder.
 *
 * The eligible tier is the **lowest** configured tier whose ratio the projection
 * has reached and which has not fired in the current epoch. Lowest-first is what
 * makes a skipped tier impossible: a pressure that jumps past several tiers
 * announces them in order over successive steps instead of silently losing the
 * lower ones, and each still speaks at most once per epoch.
 * @param input - the paired figures, the configured policy and the folded state.
 * @returns the reminder, or `undefined` when no tier is eligible.
 */
export function decideTierReminder(input: TierReminderInput): TierReminder | undefined {
  const { pressure, capacity, routeCoherent, policy, state } = input
  // A route-incoherent pairing has exactly one effect: no reminder. A ratio
  // across two routes would be fabricated, and no tier decision follows from a
  // figure that belongs to a route this session has left.
  if (!routeCoherent) return undefined
  if (pressure === undefined || capacity === undefined || capacity <= 0) return undefined

  const ratio = pressure / capacity
  for (let tier = 0; tier < policy.tiers.length; tier += 1) {
    const tierRatio = policy.tiers[tier]
    if (tierRatio === undefined || ratio < tierRatio) {
      // Ascending by construction, so nothing above this tier is reached either.
      return undefined
    }
    const sectionName = pressureTierSectionName(tier)
    if (state.firedEpochs[sectionName] === state.epoch) continue
    return {
      tier,
      sectionName,
      text: systemReminderFrame(renderTierReminderBody({ tier, tierRatio, pressure, capacity, policy })),
    }
  }
  return undefined
}

/**
 * The context form one reminder declares, which is the shape its message has: a
 * reading is a `snapshot` of named sections, a one-off account is a `notice`
 * carrying a one-line summary.
 */
type ReminderForm =
  | { readonly form: 'snapshot'; readonly sections: readonly ContextSnapshotSection[] }
  | { readonly form: 'notice'; readonly summary: string }

/**
 * Wrap one reminder's text as the plugin-attributed user message it travels in.
 *
 * Both reminders are one artifact: a user-role message this plugin attributes to
 * itself, whose declared context form is what renders it as an attributed
 * transcript row the human sees as well as the model. Building both here is what
 * keeps that one artifact one piece of code.
 * @param text - the complete model-facing text, frame included.
 * @param form - the context form matching the reminder's own shape.
 * @returns the message to append to the step's decision.
 */
function reminderMessage(text: string, form: ReminderForm): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME, ...form },
  })
}

/**
 * Build the user-role message one tier reminder is delivered as.
 *
 * The message is attributed to this plugin and declares the `snapshot` context
 * form naming the tier's section, which is both the transcript contribution the
 * human sees and the durable key the fold reads a firing back from.
 * @param reminder - the decided reminder.
 * @returns the message to append to the step's decision.
 */
export function tierReminderMessage(reminder: TierReminder): UserMessage {
  return reminderMessage(reminder.text, {
    form: 'snapshot',
    sections: [{ name: reminder.sectionName, text: reminder.text }],
  })
}

/** The facts the tier decision is a pure function of, and of nothing else. */
export interface TierReminderInput {
  /** The projected prompt size in tokens, absent while nothing has measured the session. */
  readonly pressure: number | undefined
  /** The route's context window in tokens, absent when no recorded route advertised one. */
  readonly capacity: number | undefined
  /** Whether the two figures were confirmed to belong to the same resolved route. */
  readonly routeCoherent: boolean
  /** The configured policy. */
  readonly policy: ReminderPolicy
  /** The folded reminder state, which is per session and rebuilt from the durable log. */
  readonly state: TierFiringState
}

/**
 * The part of the folded reminder state a tier decision reads.
 *
 * `ContextSenseState` satisfies this structurally, so the listener passes the
 * projection's state through unchanged while the core stays independent of the
 * fold's other facts.
 */
export interface TierFiringState {
  /** Summary compactions in the session's own suffix: the unit a tier fires once in. */
  readonly epoch: number
  /** Section name → the epoch that tier fired in. */
  readonly firedEpochs: Readonly<Record<string, number | undefined>>
}

/** One decided tier reminder, ready to be framed into a message. */
export interface TierReminder {
  /** The tier's position in the configured list, which is also its durable key. */
  readonly tier: number
  /** The stable section name the fold reads this tier's firing back from. */
  readonly sectionName: string
  /** The complete model-facing text, frame included. */
  readonly text: string
}

/** The facts one reminder's body states, before anything derivable is derived. */
interface ReminderBodyFacts {
  /** The tier's position in the configured list. */
  readonly tier: number
  /** The ratio of the tier being announced. */
  readonly tierRatio: number
  /** The projected prompt size the ratio was formed from. */
  readonly pressure: number
  /** The route's advertised context window. */
  readonly capacity: number
  /** The policy in force, which the headroom wording also quotes. */
  readonly policy: ReminderPolicy
}

/**
 * Render the model-facing body of one tier reminder.
 *
 * It quotes names and sizes only: the tier that was reached, the two figures the
 * ratio was formed from, and the headroom to the assumed compaction threshold.
 * The threshold is named as an assumption about the deployment, never as a
 * reading of the policy the mounted compaction backend actually enforces.
 * @param facts - the tier reached, the paired figures and the policy in force.
 * @returns the body, with every interpolated value escaped.
 */
function renderTierReminderBody(facts: ReminderBodyFacts): string {
  const { tier, tierRatio, pressure, capacity, policy } = facts
  const ratio = pressure / capacity
  const thresholdTokens = Math.floor(capacity * policy.compactionThresholdRatio)
  const remainingTokens = capacity - pressure
  return [
    `Context reminder: committed history has reached the ${percent(tierRatio)} tier (tier ${escapeXml(String(tier + 1))} of ${escapeXml(String(policy.tiers.length))}).`,
    `Committed history projects to ${escapeXml(String(pressure))} tokens of the current route's ${escapeXml(String(capacity))}-token context window — ${percent(ratio)} used, ${escapeXml(String(remainingTokens))} tokens remaining in the window.`,
    `The configured reminder tiers are ${policy.tiers.map(percent).join(' and ')}, and the compaction threshold this deployment assumes is ${percent(policy.compactionThresholdRatio)} (${escapeXml(String(thresholdTokens))} tokens): ${escapeXml(String(thresholdTokens - pressure))} tokens of headroom remain before that point.`,
    REMINDER_DISCLAIMER,
  ].join('\n')
}

/**
 * The share of the route's capacity one raw tool result may occupy before the
 * model hears about it.
 *
 * A tenth by default, which is deliberately conservative: one result priced
 * against the whole window, reported while it is still attached to the step that
 * produced it, rather than a running total the plugin would have to maintain.
 */
export const DEFAULT_OVERSIZED_RESULT_SHARE = 0.1

/**
 * The oversized-result rule's policy: how much of the window one result may take.
 *
 * Whether the listener is registered at all is, like the tier policy's own flag,
 * deliberately not part of this type: that is a load-time decision, and a
 * decision core able to see the flag could return a reminder for a rule that was
 * switched off.
 */
export interface OversizedResultPolicy {
  /** The largest fraction of the route's context window one raw result may occupy unreported. */
  readonly share: number
}

/**
 * Validate the configured policy and freeze it for the decision core.
 *
 * Strict, like the tier ratios and for the same reason: a share is never clamped
 * into range, dropped or replaced by a default, because an unusable value is a
 * deployment error whose only honest outcome is failing the plugin at load.
 * @param config - the oversized-result config block the loader row supplied.
 * @returns the frozen policy.
 * @throws when the share is not a finite ratio strictly between 0 and 1.
 */
export function resolveOversizedResultPolicy(config: OversizedResultPolicy): OversizedResultPolicy {
  const { share } = config
  if (!isUnitRatio(share)) {
    throw new Error(
      `${CONFIG_PATH}.oversized.share must be a finite ratio strictly between 0 and 1, got ${String(share)}`,
    )
  }
  return Object.freeze({ share })
}

/**
 * The part of the folded reminder state an oversized-result decision reads.
 *
 * `ContextSenseState` satisfies this structurally, so the listener passes the
 * projection's state through unchanged while the core stays independent of the
 * fold's other facts.
 */
export interface OversizedSuppressionState {
  /** `(turn, step)` of the latest own `step/start`, or `null` before the session's first step. */
  readonly cursor: StepCursor | null
  /** The step a pressure-tier reminder went out at, or `null` before one has. */
  readonly pressureReminder: StepCursor | null
}

/** The facts the oversized-result decision is a pure function of, and of nothing else. */
export interface OversizedResultReminderInput {
  /** The dispatched tool's name, which the reminder names and never quotes further. */
  readonly toolName: string
  /**
   * What the harness's meter priced the raw result at, priced by the caller: the
   * core never estimates, and never re-derives a price from the meter's
   * internals or a heuristic of its own.
   */
  readonly estimatedTokens: number
  /** The route's context window, absent when no recorded route advertised one. */
  readonly capacity: number | undefined
  /** The configured policy. */
  readonly policy: OversizedResultPolicy
  /** The folded step facts the one-directional suppression is decided from. */
  readonly state: OversizedSuppressionState
}

/** One decided oversized-result reminder, ready to be framed into a message. */
export interface OversizedResultReminder {
  /** The complete model-facing text, frame included. */
  readonly text: string
  /** The one-line account the `notice` form carries, bounded for a collapsed row. */
  readonly summary: string
}

/**
 * Decide whether one raw tool result is oversized enough to report.
 *
 * The rule is deliberately conservative about what it can prove. It reports the
 * price the harness put on the raw dispatch result — before the tool's own
 * `finalizeContent`, which is the only point the content could shrink — and it
 * applies to one result at a time, never to a running total the plugin cannot
 * see.
 *
 * Suppression is one-directional: a pressure-tier reminder that went out in this
 * step already told the model where its context stands, so the oversized report
 * gives way. The reverse never happens — a tier signal is once per epoch, and
 * withholding it to make room for a per-result notice would lose it for the
 * whole epoch.
 * @param input - the tool, the priced result, the capacity, the policy and the folded step facts.
 * @returns the reminder, or `undefined` when nothing is owed.
 */
export function decideOversizedResultReminder(
  input: OversizedResultReminderInput,
): OversizedResultReminder | undefined {
  const { toolName, estimatedTokens, capacity, policy, state } = input
  // A share is a share OF a window: with no advertised capacity there is no
  // denominator, and no reminder is fabricated from a single figure.
  if (capacity === undefined || capacity <= 0) return undefined
  // Exactly the share is not more than the share.
  if (estimatedTokens <= capacity * policy.share) return undefined
  if (sameStepCursor(state.pressureReminder, state.cursor)) return undefined
  return {
    text: systemReminderFrame(
      renderOversizedResultReminderBody({ toolName, estimatedTokens, capacity, share: policy.share }),
    ),
    summary: oversizedResultSummary(toolName, estimatedTokens, capacity),
  }
}

/**
 * Build the user-role message one oversized-result reminder is delivered as.
 *
 * The message is attributed to this plugin and declares the `notice` context
 * form: one collapsed transcript row whose summary stands in for the body until
 * expanded, which is the shape this reminder is. It carries no sections, so the
 * fold reads it as no tier's firing and never as the step a tier reminder went
 * out at.
 * @param reminder - the decided reminder.
 * @returns the message to attach to the step's decision.
 */
export function oversizedResultReminderMessage(reminder: OversizedResultReminder): UserMessage {
  return reminderMessage(reminder.text, { form: 'notice', summary: reminder.summary })
}

/**
 * What the oversized reminder says about its own figure.
 *
 * The price comes from `tools/post-execute`, which runs before the definition's
 * `finalizeContent` and before any listener may replace the content, so the
 * reminder describes the raw dispatch result rather than the bytes the model
 * received. Stating that is what keeps a rule that may over-report honest.
 */
const OVERSIZED_RESULT_BASIS =
  'The figure prices the raw dispatch result, before the tool’s own finalization, so a tool that shrinks its output may be reported larger than what the model received.'

/** The facts one oversized reminder's body states, before anything derivable is derived. */
interface OversizedResultBodyFacts {
  /** The dispatched tool's name. */
  readonly toolName: string
  /** The price the harness put on the raw result. */
  readonly estimatedTokens: number
  /** The route's advertised context window. */
  readonly capacity: number
  /** The configured share of that window. */
  readonly share: number
}

/**
 * Render the model-facing body of one oversized-result reminder.
 *
 * It names the tool and the sizes only — never a byte of the result itself. A
 * result is arbitrary content, and a reminder that quoted it would put the very
 * payload the report is about back into the context.
 * @param facts - the tool, the priced result, the capacity and the share in force.
 * @returns the body, with every interpolated value escaped.
 */
function renderOversizedResultReminderBody(facts: OversizedResultBodyFacts): string {
  const { toolName, estimatedTokens, capacity, share } = facts
  return [
    `Context reminder: one tool result is oversized — the \`${escapeXml(toolName)}\` result prices at an estimated ${escapeXml(String(estimatedTokens))} tokens, ${percent(estimatedTokens / capacity)} of the current route's ${escapeXml(String(capacity))}-token context window and above the configured ${percent(share)} share.`,
    OVERSIZED_RESULT_BASIS,
  ].join('\n')
}

/**
 * The one-line account a collapsed notice row shows.
 * @param toolName - the dispatched tool's name.
 * @param estimatedTokens - the price the harness put on the raw result.
 * @param capacity - the route's advertised context window.
 * @returns the account, ellipsized by the harness's own bound when too long.
 */
function oversizedResultSummary(toolName: string, estimatedTokens: number, capacity: number): string {
  return boundContextSummary(`${toolName}: about ${estimatedTokens} tokens of ${capacity}`)
}
