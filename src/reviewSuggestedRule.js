/**
 * STORY-008 — Human Approval of a Suggested Classification Rule Change.
 *
 * A support agent must review a rule-change suggestion (from
 * src/classificationCorrections.js's checkForSuggestedRule) before it can
 * ever affect classify.js — mirrors reviewClassification.js's (STORY-002)
 * and reviewEscalation.js's (STORY-006) approve/reject shape exactly, for
 * the same reason: this is a new domain object (a suggestion, not a
 * classification or an escalation recommendation), so it gets its own
 * sibling review module with an identical shape rather than overloading
 * reviewClassification.js, which would reject a suggestion outright (it
 * validates `classification.category`/`priority`, neither of which a
 * suggestion has).
 *
 * Unlike reviewClassification.js/reviewEscalation.js, approving here IS
 * meant to change something downstream — that is the entire point of this
 * story ("only once a suggestion is approved does classify.js's behavior
 * actually change"). This module itself still only records the decision and
 * stays side-effect-free; the actual write to
 * src/data/approvedClassificationRules.json happens one layer up, in
 * auditedActions.js's reviewSuggestedRuleAndLog, which calls classify.js's
 * applyApprovedClassificationRule() only when outcome === 'approved'. That
 * keeps this module testable and consistent with its siblings, while the
 * side effect it triggers is documented once, at the one call site
 * responsible for triggering it.
 *
 * Fails closed on:
 *  - A suggestion that isn't actually a suggested_rule_change shape (wrong
 *    `type`, missing/blank keyword or categories, or timesSeen below
 *    SUGGESTION_THRESHOLD) — covers "a malformed or not-actually-a-suggestion
 *    item reaching a reviewer as if it were one."
 *  - A malformed decision (invalid action, missing/blank reviewer).
 * Never throws.
 *
 * @typedef {import('./classificationCorrections.js').SuggestedRuleChange} SuggestedRuleChange
 *
 * @typedef {Object} SuggestedRuleReviewDecision
 * @property {'approve'|'reject'} action
 * @property {string} reviewer        Non-empty. Who made the decision — required for the audit trail.
 * @property {string} [reason]        Optional context, especially useful on reject.
 *
 * @typedef {Object} SuggestedRuleReviewResult
 * @property {boolean} ok
 * @property {'approved'|'rejected'|'error'} outcome
 * @property {string} [reason]                        Present on reject or error.
 * @property {SuggestedRuleChange} [suggestion]       Present on approve or reject.
 * @property {Object} logEntry
 */

import { SUGGESTION_THRESHOLD } from './classificationCorrections.js';

const REVIEW_ACTIONS = ['approve', 'reject'];

/**
 * @param {unknown} suggestion
 * @returns {boolean}
 */
function isValidSuggestion(suggestion) {
  return (
    suggestion !== null &&
    typeof suggestion === 'object' &&
    !Array.isArray(suggestion) &&
    suggestion.type === 'suggested_rule_change' &&
    typeof suggestion.keyword === 'string' &&
    suggestion.keyword.trim() !== '' &&
    typeof suggestion.wrongCategory === 'string' &&
    suggestion.wrongCategory.trim() !== '' &&
    typeof suggestion.correctCategory === 'string' &&
    suggestion.correctCategory.trim() !== '' &&
    typeof suggestion.timesSeen === 'number' &&
    suggestion.timesSeen >= SUGGESTION_THRESHOLD
  );
}

/**
 * @param {unknown} decision
 * @returns {boolean}
 */
function isValidDecision(decision) {
  return (
    decision !== null &&
    typeof decision === 'object' &&
    !Array.isArray(decision) &&
    REVIEW_ACTIONS.includes(decision.action) &&
    typeof decision.reviewer === 'string' &&
    decision.reviewer.trim() !== ''
  );
}

/**
 * Review a suggested rule change: approve it, reject it, or fail closed on
 * malformed input. Pure and idempotent — same input always yields the same
 * result, no side effects. Approving does NOT itself write
 * approvedClassificationRules.json — see this file's header comment.
 *
 * @param {unknown} suggestion
 * @param {unknown} decision
 * @returns {SuggestedRuleReviewResult}
 */
export function reviewSuggestedRule(suggestion, decision) {
  if (!isValidSuggestion(suggestion)) {
    return buildErrorResult('invalid_suggestion', suggestion, decision);
  }
  if (!isValidDecision(decision)) {
    return buildErrorResult('invalid_decision', suggestion, decision);
  }

  if (decision.action === 'approve') {
    return {
      ok: true,
      outcome: 'approved',
      suggestion,
      logEntry: buildLogEntry({
        event: 'rule_suggestion_approved',
        outcome: 'success',
        suggestion,
        decision,
      }),
    };
  }

  // action === 'reject'
  return {
    ok: true,
    outcome: 'rejected',
    reason: decision.reason ?? null,
    suggestion,
    logEntry: buildLogEntry({
      event: 'rule_suggestion_rejected',
      outcome: 'success',
      suggestion,
      decision,
    }),
  };
}

/**
 * @param {'invalid_suggestion'|'invalid_decision'} reason
 * @param {unknown} suggestion
 * @param {unknown} decision
 * @returns {SuggestedRuleReviewResult}
 */
function buildErrorResult(reason, suggestion, decision) {
  return {
    ok: false,
    outcome: 'error',
    reason,
    logEntry: buildLogEntry({
      event: 'rule_suggestion_review_failed',
      outcome: 'failure',
      suggestion,
      decision,
      errorClass: 'ValidationError',
      errorReason: reason,
    }),
  };
}

/**
 * Build a structured, stdout-log-shaped record of a review decision (per
 * CLAUDE.md's Observability Framework). Only builds the record — does not
 * write it anywhere; persistence is auditedActions.js.
 *
 * @param {{ event: string, outcome: 'success'|'failure', suggestion: unknown,
 *   decision: unknown, errorClass?: string, errorReason?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ event, outcome, suggestion, decision, errorClass, errorReason }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'reviewSuggestedRule',
    event,
    outcome,
    context: {
      keyword: suggestion && typeof suggestion === 'object' ? suggestion.keyword : undefined,
      wrongCategory: suggestion && typeof suggestion === 'object' ? suggestion.wrongCategory : undefined,
      correctCategory: suggestion && typeof suggestion === 'object' ? suggestion.correctCategory : undefined,
      timesSeen: suggestion && typeof suggestion === 'object' ? suggestion.timesSeen : undefined,
      action: decision && typeof decision === 'object' ? decision.action : undefined,
      reviewer: decision && typeof decision === 'object' ? decision.reviewer : undefined,
      reason: decision && typeof decision === 'object' ? decision.reason : undefined,
    },
  };
  if (errorClass) entry.error_class = errorClass;
  if (errorReason) entry.context.errorReason = errorReason;
  return entry;
}
