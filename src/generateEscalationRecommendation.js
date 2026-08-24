/**
 * STORY-006 — Recommend Escalation with Explanation (REQ-006).
 *
 * Deterministic decision (no model call, per CLAUDE.md's "LLMs are
 * probabilistic. Production systems must be deterministic."): recommend
 * escalation when the knowledge base could not resolve the issue
 * (searchKnowledgeBase's `found: false`), and always pair a recommendation
 * with a clear, human-readable explanation — REQ-006's literal text
 * ("recommend escalation when an issue cannot be solved using the available
 * knowledge, explaining the reason for escalation").
 *
 * `found: false` covers both an explicit no-match AND a knowledge-base
 * search failure (missing/corrupt/timed-out file — see knowledgeBaseSearch.js).
 * Treating both the same way is a deliberate, logged choice: if the assistant
 * cannot confirm an answer either way, escalating to a human is the safe
 * fail-closed default, not a special case to branch on separately. A
 * low-confidence match (`found: true`, `confidence: 'low'`) is NOT escalated —
 * knowledgeBaseSearch.js already flags that case with a human-review caveat
 * at the draft-response stage; escalation is reserved for "nothing usable was
 * found at all", per the requirement's literal wording, not "found something
 * shaky". This is a scope decision, not a hidden assumption.
 *
 * Escalation is one of guardrail.js's RESTRICTED_ACTIONS: the assistant may
 * never escalate a case itself, only recommend it. So the `action` this
 * module builds is shaped exactly as guardrail.js's validateAssistantOutput
 * requires (requiresApproval: true, status: 'proposed') — this is the first
 * story where a module's output is meant to actually pass through
 * presentToAgent.js/guardrail.js, not just sit beside it (see the
 * integration test in tests/generateEscalationRecommendation.test.js).
 *
 * Pure and idempotent like classify.js/reviewClassification.js — no I/O, same
 * input always yields the same output. Only builds a logEntry; persistence is
 * auditedActions.js's generateEscalationRecommendationAndLog.
 *
 * Failure paths handled (never throws — every branch returns a result object):
 *  - Malformed/unrecognized classification -> fails closed, ValidationError, not recommended.
 *  - Malformed kbSearchResult (missing/wrong-typed `found`) -> fails closed, ValidationError.
 *  - Escalation criteria met (found: false) -> recommended: true, explanation always present.
 *  - Escalation criteria not met (found: true) -> recommended: false, reason still explained
 *    (an explanation is never conditionally omitted, guarding "Explanation missing").
 *
 * @typedef {import('./classify.js').ClassificationResult} ClassificationResult
 * @typedef {import('./knowledgeBaseSearch.js').KnowledgeBaseSearchResult} KnowledgeBaseSearchResult
 *
 * @typedef {Object} EscalationRecommendation
 * @property {boolean} ok
 * @property {boolean} recommended
 * @property {'no_knowledge_base_match'|'resolved_by_knowledge_base'|'invalid_classification'|'invalid_kb_search_result'} reason
 * @property {string|null} explanation   Always non-null when ok is true.
 * @property {import('./guardrail.js').RecommendedAction|null} action   Present only when recommended is true.
 * @property {Object} logEntry
 */

import { CATEGORIES } from './classify.js';

/** Human-readable phrasing per category, for a natural-reading explanation. */
const HUMAN_CATEGORY_LABELS = {
  login_problem: 'login problem',
  access_permission_issue: 'access/permission issue',
  power_bi_report_issue: 'Power BI report issue',
  sql_database_issue: 'SQL/database issue',
  data_issue: 'data issue',
  technical_question: 'technical question',
  general_support_request: 'general support request',
};

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
    CATEGORIES.includes(classification.category)
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
 * @param {{ event: string, outcome: 'success'|'failure', category: string|undefined,
 *   recommended: boolean, reason: string, errorClass?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ event, outcome, category, recommended, reason, errorClass }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'generateEscalationRecommendation',
    event,
    outcome,
    context: { category, recommended, reason },
  };
  if (errorClass) entry.error_class = errorClass;
  return entry;
}

/**
 * @param {'invalid_classification'|'invalid_kb_search_result'} reason
 * @param {unknown} classification
 * @returns {EscalationRecommendation}
 */
function invalidInputResult(reason, classification) {
  return {
    ok: false,
    recommended: false,
    reason,
    explanation: null,
    action: null,
    logEntry: buildLogEntry({
      event: 'escalation_recommendation_failed',
      outcome: 'failure',
      category: classification && typeof classification === 'object' ? classification.category : undefined,
      recommended: false,
      reason,
      errorClass: 'ValidationError',
    }),
  };
}

/**
 * Decide whether to recommend escalation for a classified request, given the
 * result of a prior searchKnowledgeBase() call. Never throws.
 *
 * @param {unknown} classification    Output of classify.js's classifySupportRequest.
 * @param {unknown} kbSearchResult    Output of knowledgeBaseSearch.js's searchKnowledgeBase.
 * @returns {EscalationRecommendation}
 */
export function generateEscalationRecommendation(classification, kbSearchResult) {
  if (!isValidClassification(classification)) {
    return invalidInputResult('invalid_classification', classification);
  }
  if (!isValidKbSearchResult(kbSearchResult)) {
    return invalidInputResult('invalid_kb_search_result', classification);
  }

  const { category } = classification;
  const label = HUMAN_CATEGORY_LABELS[category] ?? category;

  if (kbSearchResult.found === false) {
    const explanation =
      `No relevant troubleshooting steps were found in the knowledge base for this ${label}. ` +
      `Escalating to a specialist is recommended so the issue can be resolved with expertise ` +
      `beyond the available knowledge base.`;
    return {
      ok: true,
      recommended: true,
      reason: 'no_knowledge_base_match',
      explanation,
      action: {
        type: 'escalate',
        description: explanation,
        requiresApproval: true,
        status: 'proposed',
      },
      logEntry: buildLogEntry({
        event: 'escalation_recommended',
        outcome: 'success',
        category,
        recommended: true,
        reason: 'no_knowledge_base_match',
      }),
    };
  }

  const explanation =
    `Relevant troubleshooting steps were found in the knowledge base for this ${label}, ` +
    `so escalation is not recommended at this time.`;
  return {
    ok: true,
    recommended: false,
    reason: 'resolved_by_knowledge_base',
    explanation,
    action: null,
    logEntry: buildLogEntry({
      event: 'escalation_not_recommended',
      outcome: 'success',
      category,
      recommended: false,
      reason: 'resolved_by_knowledge_base',
    }),
  };
}
