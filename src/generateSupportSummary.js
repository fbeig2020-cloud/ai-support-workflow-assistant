/**
 * STORY-007 — Generate Final Support Summary (REQ-007).
 *
 * Compiles the artifacts already produced elsewhere in this repo's workflow
 * (classification, its human review, the knowledge-base search, the draft
 * response, and — only when it happened — an escalation recommendation and
 * its review) into one coherent, human-readable document after a workflow is
 * complete. Per CLAUDE.md's core principle ("LLMs are probabilistic.
 * Production systems must be deterministic."), this is template assembly
 * from already-produced, already-validated data — no model call, same
 * approach classify.js/generateDraftResponse.js already use.
 *
 * This is the first story to need a "workflow bundle" shape tying one
 * ticket's artifacts together (`ticketId`, `requestText`, plus the outputs
 * of STORY-001/002/004/005/006). No earlier story defined that shape; it is
 * introduced here, not silently — see PROGRESS.md's STORY-007 entry.
 *
 * Pure and idempotent: same input always yields the same output, no I/O, no
 * side effects. Only builds a logEntry and the summary text — persistence to
 * the audit trail is the caller-side wrapper in auditedActions.js (STORY-003
 * pattern), and *saving* the summary itself is the separate, explicitly
 * manual src/saveSupportSummary.js — this module never writes anything, so
 * generating a summary can never, by itself, "save" or finalize a ticket.
 *
 * This module only compiles and reports. It never sends, closes, resolves,
 * or escalates anything, so it does not touch guardrail.js (R4 governs
 * restricted *actions*; producing a read-only summary document isn't one of
 * RESTRICTED_ACTIONS).
 *
 * Failure paths handled (never throws — every branch returns a result object):
 *  - Malformed/incomplete workflow bundle (missing ticketId/requestText/
 *    classification/classificationReview/draftResponse, or a malformed
 *    classification/review shape) -> fails closed, ValidationError
 *    ("Summary not generated").
 *  - Escalation data present but inconsistent (an escalationReview without a
 *    matching recommended escalationRecommendation, or vice versa, or a
 *    review that doesn't reference the same recommendation) -> fails closed,
 *    EscalationMismatchError -- the concrete guard against "Incorrect
 *    summary details".
 *  - kbSearchResult missing/malformed -> not a hard failure; the summary
 *    notes "no knowledge-base search recorded" rather than fabricating a
 *    result -- guards "Summary incomplete" by degrading gracefully instead
 *    of refusing to generate.
 *  - Assembled summary ends up empty after compilation (should be
 *    unreachable given the required-field validation above, but checked
 *    explicitly rather than assumed) -> fails closed, SummaryRenderError.
 *
 * @typedef {import('./classify.js').ClassificationResult} ClassificationResult
 * @typedef {import('./reviewClassification.js').ReviewResult} ReviewResult
 * @typedef {import('./knowledgeBaseSearch.js').KnowledgeBaseSearchResult} KnowledgeBaseSearchResult
 * @typedef {import('./generateDraftResponse.js').DraftResponseResult} DraftResponseResult
 * @typedef {import('./generateEscalationRecommendation.js').EscalationRecommendation} EscalationRecommendation
 * @typedef {import('./reviewEscalation.js').EscalationReviewResult} EscalationReviewResult
 *
 * @typedef {Object} SupportWorkflowBundle
 * @property {string} ticketId                                Non-empty. Identifies the ticket this summary belongs to.
 * @property {string} requestText                              The original support request text.
 * @property {ClassificationResult} classification
 * @property {ReviewResult} classificationReview
 * @property {KnowledgeBaseSearchResult} [kbSearchResult]       Optional — degrades gracefully if absent.
 * @property {DraftResponseResult} draftResponse
 * @property {EscalationRecommendation} [escalationRecommendation]  Present only when STORY-006 ran.
 * @property {EscalationReviewResult} [escalationReview]        Present only when an escalation was recommended.
 *
 * @typedef {Object} SupportSummaryResult
 * @property {boolean} generated
 * @property {string} summaryText      '' when generated is false.
 * @property {string} [ticketId]
 * @property {string} [message]        Present when generated is false.
 * @property {Object} logEntry         Structured, stdout-log-shaped record (Observability Framework
 *                                       shape). Not persisted here — persistence is auditedActions.js.
 */

import { CATEGORIES, PRIORITIES } from './classify.js';

const REVIEW_OUTCOMES = ['approved', 'rejected'];

/**
 * @param {unknown} workflow
 * @returns {boolean}
 */
function hasValidTicketId(workflow) {
  return typeof workflow.ticketId === 'string' && workflow.ticketId.trim() !== '';
}

/**
 * @param {unknown} classification
 * @returns {boolean}
 */
function isValidClassification(classification) {
  return (
    classification !== null &&
    typeof classification === 'object' &&
    !Array.isArray(classification) &&
    typeof classification.category === 'string' &&
    CATEGORIES.includes(classification.category) &&
    typeof classification.priority === 'string' &&
    PRIORITIES.includes(classification.priority)
  );
}

/**
 * @param {unknown} review
 * @returns {boolean}
 */
function isValidReview(review) {
  return (
    review !== null &&
    typeof review === 'object' &&
    !Array.isArray(review) &&
    REVIEW_OUTCOMES.includes(review.outcome) &&
    review.logEntry !== null &&
    typeof review.logEntry === 'object' &&
    review.logEntry.context !== null &&
    typeof review.logEntry.context === 'object' &&
    typeof review.logEntry.context.reviewer === 'string' &&
    review.logEntry.context.reviewer.trim() !== ''
  );
}

/**
 * @param {unknown} draftResponse
 * @returns {boolean}
 */
function isValidDraftResponse(draftResponse) {
  return (
    draftResponse !== null &&
    typeof draftResponse === 'object' &&
    !Array.isArray(draftResponse) &&
    typeof draftResponse.generated === 'boolean'
  );
}

/**
 * @param {unknown} kbSearchResult
 * @returns {boolean}
 */
function isValidKbSearchResult(kbSearchResult) {
  return (
    kbSearchResult !== null &&
    typeof kbSearchResult === 'object' &&
    !Array.isArray(kbSearchResult) &&
    typeof kbSearchResult.found === 'boolean'
  );
}

/**
 * @param {unknown} recommendation
 * @returns {boolean}
 */
function isValidEscalationRecommendation(recommendation) {
  return (
    recommendation !== null &&
    typeof recommendation === 'object' &&
    !Array.isArray(recommendation) &&
    typeof recommendation.recommended === 'boolean' &&
    typeof recommendation.explanation === 'string'
  );
}

/**
 * The escalation review, when present, must actually be a review of the
 * same recommendation carried in this workflow — not just any review-shaped
 * object. This is the guard against "Incorrect summary details": a summary
 * must never claim an escalation was approved/rejected unless that decision
 * really was made about the recommendation being summarized.
 *
 * @param {unknown} review
 * @param {unknown} recommendation
 * @returns {boolean}
 */
function isValidEscalationReview(review, recommendation) {
  return (
    review !== null &&
    typeof review === 'object' &&
    !Array.isArray(review) &&
    REVIEW_OUTCOMES.includes(review.outcome) &&
    review.logEntry !== null &&
    typeof review.logEntry === 'object' &&
    review.logEntry.context !== null &&
    typeof review.logEntry.context === 'object' &&
    typeof review.logEntry.context.reviewer === 'string' &&
    review.logEntry.context.reviewer.trim() !== '' &&
    JSON.stringify(review.recommendation) === JSON.stringify(recommendation)
  );
}

/**
 * @param {unknown} workflow
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateWorkflow(workflow) {
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
    return { ok: false, reason: 'invalid_workflow' };
  }
  if (!hasValidTicketId(workflow)) {
    return { ok: false, reason: 'invalid_ticket_id' };
  }
  if (typeof workflow.requestText !== 'string' || workflow.requestText.trim() === '') {
    return { ok: false, reason: 'invalid_request_text' };
  }
  if (!isValidClassification(workflow.classification)) {
    return { ok: false, reason: 'invalid_classification' };
  }
  if (!isValidReview(workflow.classificationReview)) {
    return { ok: false, reason: 'invalid_classification_review' };
  }
  if (!isValidDraftResponse(workflow.draftResponse)) {
    return { ok: false, reason: 'invalid_draft_response' };
  }
  if (workflow.kbSearchResult !== undefined && !isValidKbSearchResult(workflow.kbSearchResult)) {
    return { ok: false, reason: 'invalid_kb_search_result' };
  }

  const hasRecommendation = workflow.escalationRecommendation !== undefined;
  const hasReview = workflow.escalationReview !== undefined;

  if (hasRecommendation && !isValidEscalationRecommendation(workflow.escalationRecommendation)) {
    return { ok: false, reason: 'invalid_escalation_recommendation' };
  }
  if (hasReview && !hasRecommendation) {
    return { ok: false, reason: 'escalation_review_without_recommendation' };
  }
  if (hasRecommendation && workflow.escalationRecommendation.recommended === true && !hasReview) {
    return { ok: false, reason: 'escalation_recommended_without_review' };
  }
  if (hasRecommendation && workflow.escalationRecommendation.recommended === false && hasReview) {
    return { ok: false, reason: 'escalation_review_without_recommendation' };
  }
  if (
    hasReview &&
    hasRecommendation &&
    !isValidEscalationReview(workflow.escalationReview, workflow.escalationRecommendation)
  ) {
    return { ok: false, reason: 'escalation_review_mismatch' };
  }

  return { ok: true };
}

/**
 * @param {{ event: string, outcome: 'success'|'failure', ticketId: string|undefined,
 *   category?: string, escalated?: boolean, summaryLength: number, errorClass?: string,
 *   reason?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ event, outcome, ticketId, category, escalated, summaryLength, errorClass, reason }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'generateSupportSummary',
    event,
    outcome,
    context: { ticketId, category, escalated, summaryLength },
  };
  if (errorClass) entry.error_class = errorClass;
  if (reason) entry.context.reason = reason;
  return entry;
}

/**
 * @param {string} reason
 * @param {unknown} workflow
 * @returns {SupportSummaryResult}
 */
function notGenerated(reason, workflow) {
  const ticketId =
    workflow && typeof workflow === 'object' && typeof workflow.ticketId === 'string'
      ? workflow.ticketId
      : undefined;
  return {
    generated: false,
    summaryText: '',
    message: `Support summary not generated: ${reason.replace(/_/g, ' ')}.`,
    logEntry: buildLogEntry({
      event: 'support_summary_failed',
      outcome: 'failure',
      ticketId,
      summaryLength: 0,
      errorClass: reason === 'escalation_review_mismatch' || reason === 'escalation_recommended_without_review' || reason === 'escalation_review_without_recommendation'
        ? 'EscalationMismatchError'
        : 'ValidationError',
      reason,
    }),
  };
}

/**
 * @param {ReviewResult} review
 * @returns {string}
 */
function describeReview(review) {
  const reviewer = review.logEntry.context.reviewer;
  if (review.outcome === 'approved') return `Approved by ${reviewer}.`;
  return `Rejected by ${reviewer}${review.reason ? ` (reason: ${review.reason})` : ''}.`;
}

/**
 * Compile a completed support workflow into a final, human-readable summary
 * for a support agent to review and manually save with the ticket. Never
 * throws — every branch returns a result object. Never saves, sends, closes,
 * or escalates anything itself.
 *
 * @param {unknown} workflow
 * @returns {SupportSummaryResult}
 */
export function generateSupportSummary(workflow) {
  const validation = validateWorkflow(workflow);
  if (!validation.ok) {
    return notGenerated(validation.reason, workflow);
  }

  const {
    ticketId,
    requestText,
    classification,
    classificationReview,
    draftResponse,
    kbSearchResult,
    escalationRecommendation,
    escalationReview,
  } = workflow;

  const lines = [];
  lines.push(`Support Summary — Ticket ${ticketId}`);
  lines.push('');
  lines.push('Original Request:');
  lines.push(requestText.trim());
  lines.push('');
  lines.push('Classification:');
  lines.push(`Category: ${classification.category}`);
  lines.push(`Priority: ${classification.priority}`);
  lines.push(`Review: ${describeReview(classificationReview)}`);
  lines.push('');
  lines.push('Knowledge Base Search:');
  if (kbSearchResult === undefined) {
    lines.push('No knowledge-base search recorded for this ticket.');
  } else if (kbSearchResult.found) {
    const titles = kbSearchResult.results.map((r) => r.title).join(', ');
    lines.push(`Found (confidence: ${kbSearchResult.confidence}). Articles used: ${titles}.`);
  } else {
    lines.push('No relevant knowledge-base match was found.');
  }
  lines.push('');
  lines.push('Draft Response:');
  lines.push(
    draftResponse.generated
      ? `Generated (template: ${draftResponse.templateUsed}).`
      : `Not generated — ${draftResponse.message ?? 'unknown reason'}.`
  );
  lines.push('');
  lines.push('Escalation:');
  if (escalationRecommendation === undefined) {
    lines.push('Not recommended — issue was resolved without escalation.');
  } else if (escalationRecommendation.recommended) {
    lines.push(`Recommended: ${escalationRecommendation.explanation}`);
    lines.push(`Decision: ${describeReview(escalationReview)}`);
  } else {
    lines.push(`Not recommended: ${escalationRecommendation.explanation}`);
  }

  const summaryText = lines.join('\n');

  if (summaryText.trim() === '') {
    return notGenerated('summary_render_failed', workflow);
  }

  const escalated = escalationRecommendation !== undefined && escalationRecommendation.recommended === true;

  return {
    generated: true,
    summaryText,
    ticketId,
    logEntry: buildLogEntry({
      event: 'support_summary_generated',
      outcome: 'success',
      ticketId,
      category: classification.category,
      escalated,
      summaryLength: summaryText.length,
    }),
  };
}
