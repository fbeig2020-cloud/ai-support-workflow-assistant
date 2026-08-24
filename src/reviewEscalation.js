/**
 * STORY-006 — Human Approval of an Escalation Recommendation (REQ-006).
 *
 * A support agent must review an escalation recommendation (from
 * generateEscalationRecommendation.js) before anything happens with it —
 * mirrors reviewClassification.js's (STORY-002) approve/reject shape exactly,
 * for the same reason: guardrail.js's R4 forbids the assistant from
 * escalating a case itself, so a human decision is the only path forward.
 *
 * This module does not decide whether escalation is warranted (that's
 * generateEscalationRecommendation.js) and does not persist the log entry
 * anywhere (that's auditedActions.js) — it only records the review decision
 * and reports the outcome. Approving here does NOT perform an escalation
 * against any external system (no ticketing integration exists in this
 * repo) — it only records that a human approved the assistant's
 * recommendation, same as reviewClassification.js's approve never calls
 * anything downstream either. Rejecting simply records that the
 * recommendation was declined; there is no reclassification-style loop to
 * close here since "don't escalate" needs no further action.
 *
 * Fails closed on:
 *  - A recommendation that isn't actually a recommended-escalation shape
 *    (missing/false `recommended`, missing `action`, or an `action` that
 *    doesn't match guardrail.js's required shape) — covers "Approval
 *    interface not available" by refusing to let a malformed or
 *    not-actually-recommended item reach a reviewer as if it were one.
 *  - A malformed decision (invalid action, missing/blank reviewer).
 * Never throws.
 *
 * @typedef {import('./generateEscalationRecommendation.js').EscalationRecommendation} EscalationRecommendation
 *
 * @typedef {Object} EscalationReviewDecision
 * @property {'approve'|'reject'} action
 * @property {string} reviewer        Non-empty. Who made the decision — required for the audit trail.
 * @property {string} [reason]        Optional context, especially useful on reject.
 *
 * @typedef {Object} EscalationReviewResult
 * @property {boolean} ok
 * @property {'approved'|'rejected'|'error'} outcome
 * @property {string} [reason]                            Present on reject or error.
 * @property {EscalationRecommendation} [recommendation]   Present on approve or reject.
 * @property {Object} logEntry
 */

const REVIEW_ACTIONS = ['approve', 'reject'];

/**
 * @param {unknown} recommendation
 * @returns {boolean}
 */
function isValidRecommendation(recommendation) {
  return (
    recommendation !== null &&
    typeof recommendation === 'object' &&
    !Array.isArray(recommendation) &&
    recommendation.recommended === true &&
    recommendation.action !== null &&
    typeof recommendation.action === 'object' &&
    recommendation.action.type === 'escalate' &&
    recommendation.action.requiresApproval === true &&
    recommendation.action.status === 'proposed'
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
 * Review an escalation recommendation: approve it, reject it, or fail closed
 * on malformed input. Pure and idempotent — same input always yields the
 * same result, no side effects.
 *
 * @param {unknown} recommendation
 * @param {unknown} decision
 * @returns {EscalationReviewResult}
 */
export function reviewEscalation(recommendation, decision) {
  if (!isValidRecommendation(recommendation)) {
    return buildErrorResult('invalid_recommendation', recommendation, decision);
  }
  if (!isValidDecision(decision)) {
    return buildErrorResult('invalid_decision', recommendation, decision);
  }

  if (decision.action === 'approve') {
    return {
      ok: true,
      outcome: 'approved',
      recommendation,
      logEntry: buildLogEntry({
        event: 'escalation_approved',
        outcome: 'success',
        recommendation,
        decision,
      }),
    };
  }

  // action === 'reject'
  return {
    ok: true,
    outcome: 'rejected',
    reason: decision.reason ?? null,
    recommendation,
    logEntry: buildLogEntry({
      event: 'escalation_rejected',
      outcome: 'success',
      recommendation,
      decision,
    }),
  };
}

/**
 * @param {'invalid_recommendation'|'invalid_decision'} reason
 * @param {unknown} recommendation
 * @param {unknown} decision
 * @returns {EscalationReviewResult}
 */
function buildErrorResult(reason, recommendation, decision) {
  return {
    ok: false,
    outcome: 'error',
    reason,
    logEntry: buildLogEntry({
      event: 'escalation_review_failed',
      outcome: 'failure',
      recommendation,
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
 * @param {{ event: string, outcome: 'success'|'failure', recommendation: unknown,
 *   decision: unknown, errorClass?: string, errorReason?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ event, outcome, recommendation, decision, errorClass, errorReason }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'reviewEscalation',
    event,
    outcome,
    context: {
      escalationReason:
        recommendation && typeof recommendation === 'object' ? recommendation.reason : undefined,
      action: decision && typeof decision === 'object' ? decision.action : undefined,
      reviewer: decision && typeof decision === 'object' ? decision.reviewer : undefined,
      reason: decision && typeof decision === 'object' ? decision.reason : undefined,
    },
  };
  if (errorClass) entry.error_class = errorClass;
  if (errorReason) entry.context.errorReason = errorReason;
  return entry;
}
