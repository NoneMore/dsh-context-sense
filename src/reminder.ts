/**
 * The pressure-tier reminder: when committed history has used enough of the
 * route's context window to reach a configured tier, the model is told so.
 *
 * Two things live here. The **decision core** is a pure function of the
 * pressure figure, the capacity, whether the two were confirmed to belong to
 * the same route, the configured policy and the folded reminder state — nothing
 * else. It reads no projection, no clock and no module-level mutable state, so
 * tier eligibility and epoch re-arming are testable without a session, and the
 * reading the model is shown and the reading a reminder is decided from are
 * built from the same facts. The **frame** is the plugin-owned wrapper every
 * reminder travels in, with its interpolated values escaped so that nothing a
 * figure carries can close the frame early.
 *
 * @module dsh-context-sense/reminder
 */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

import { PLUGIN_NAME } from './identity.js'
import { formatPercent } from './reading.js'
import { pressureTierSectionName } from './session-state.js'

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
 * Build the user-role message one tier reminder is delivered as.
 *
 * The message is attributed to this plugin and declares the `snapshot` context
 * form naming the tier's section, which is both the transcript contribution the
 * human sees and the durable key the fold reads a firing back from.
 * @param reminder - the decided reminder.
 * @returns the message to append to the step's decision.
 */
export function tierReminderMessage(reminder: TierReminder): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: reminder.text }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: 'snapshot',
      sections: [{ name: reminder.sectionName, text: reminder.text }],
    },
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
