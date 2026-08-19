/**
 * STORY-002 — Human Approval of Classification and Priority.
 *
 * A support agent must review a classification (from src/classify.js) before
 * it is acted on. This module records that review decision — approve or
 * reject — and always produces a structured audit-trail log entry, per
 * REQ-005 ("review, approve, edit, or reject") and REQ-008 (the assistant
 * must never act on its own; a human approves first).
 *
 * This module does not classify (that's classify.js) and does not persist
 * the log entry anywhere (that's STORY-003) — it only builds the record and
 * reports the outcome. On reject, the caller re-runs classifySupportRequest()
 * on the original request text to close the reclassification loop; this
 * module does not call classify.js itself, to keep "record a decision" and
 * "produce a classification" as separate responsibilities.
 *
 * @typedef {import('./classify.js').ClassificationResult} ClassificationResult
 *
 * @typedef {Object} ReviewDecision
 * @property {'approve'|'reject'} action
 * @property {string} reviewer        Non-empty. Who made the decision — required for the audit trail.
 * @property {string} [reason]        Optional context, especially useful on reject.
 *
 * @typedef {Object} ReviewResult
 * @property {boolean} ok
 * @property {'approved'|'rejected'|'error'} outcome
 * @property {string} [reason]                        Present on reject or error.
 * @property {'pending_reclassification'} [status]     Present only when outcome === 'rejected'.
 * @property {ClassificationResult} [classification]   Present only when outcome === 'approved'.
 * @property {Object} logEntry
 */

const REVIEW_ACTIONS = ['approve', 'reject'];

/**
 * @param {unknown} classification
 * @returns {boolean}
 */
function isValidClassification(classification) {
  return (
    classification !== null &&
    typeof classification === 'object' &&
    typeof classification.category === 'string' &&
    classification.category.trim() !== '' &&
    typeof classification.priority === 'string' &&
    classification.priority.trim() !== ''
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
    REVIEW_ACTIONS.includes(decision.action) &&
    typeof decision.reviewer === 'string' &&
    decision.reviewer.trim() !== ''
  );
}

/**
 * Review a classification: approve it, reject it, or fail closed on
 * malformed input. Pure and idempotent — same input always yields the same
 * result, no side effects.
 *
 * @param {unknown} classification
 * @param {unknown} decision
 * @returns {ReviewResult}
 */
export function reviewClassification(classification, decision) {
  if (!isValidClassification(classification)) {
    return buildErrorResult('invalid_classification', classification, decision);
  }
  if (!isValidDecision(decision)) {
    return buildErrorResult('invalid_decision', classification, decision);
  }

  if (decision.action === 'approve') {
    return {
      ok: true,
      outcome: 'approved',
      classification,
      logEntry: buildLogEntry({
        event: 'classification_approved',
        outcome: 'success',
        classification,
        decision,
      }),
    };
  }

  // action === 'reject'
  return {
    ok: true,
    outcome: 'rejected',
    status: 'pending_reclassification',
    reason: decision.reason ?? null,
    logEntry: buildLogEntry({
      event: 'classification_rejected',
      outcome: 'success',
      classification,
      decision,
    }),
  };
}

/**
 * @param {'invalid_classification'|'invalid_decision'} reason
 * @param {unknown} classification
 * @param {unknown} decision
 * @returns {ReviewResult}
 */
function buildErrorResult(reason, classification, decision) {
  return {
    ok: false,
    outcome: 'error',
    reason,
    logEntry: buildLogEntry({
      event: 'classification_review_failed',
      outcome: 'failure',
      classification,
      decision,
      errorClass: 'ValidationError',
      errorReason: reason,
    }),
  };
}

/**
 * Build a structured, stdout-log-shaped record of a review decision (per
 * CLAUDE.md's Observability Framework). Only builds the record — does not
 * write it anywhere; persistent audit trail storage is STORY-003.
 *
 * @param {{ event: string, outcome: 'success'|'failure', classification: unknown,
 *   decision: unknown, errorClass?: string, errorReason?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ event, outcome, classification, decision, errorClass, errorReason }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'reviewClassification',
    event,
    outcome,
    context: {
      category: classification && typeof classification === 'object' ? classification.category : undefined,
      priority: classification && typeof classification === 'object' ? classification.priority : undefined,
      action: decision && typeof decision === 'object' ? decision.action : undefined,
      reviewer: decision && typeof decision === 'object' ? decision.reviewer : undefined,
      reason: decision && typeof decision === 'object' ? decision.reason : undefined,
    },
  };
  if (errorClass) entry.error_class = errorClass;
  if (errorReason) entry.context.errorReason = errorReason;
  return entry;
}
