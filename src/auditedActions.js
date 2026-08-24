/**
 * STORY-003 — audit trail wiring boundary. Extended by STORY-004 with
 * searchKnowledgeBaseAndLog (same shape, added below) so a knowledge-base
 * search's query and results are also persisted, not just classify/review.
 * Further extended by STORY-005 (generateDraftResponseAndLog), STORY-006
 * (generateEscalationRecommendationAndLog, reviewEscalationAndLog), and
 * STORY-007 (generateSupportSummaryAndLog, saveSupportSummaryAndLog) — every
 * new workflow action follows this same thin-wrapper shape.
 *
 * classify.js and reviewClassification.js are documented and tested as
 * pure, side-effect-free functions; knowledgeBaseSearch.js is side-effect-free
 * but not pure (it reads a file). Either way, none of the three persist
 * anything themselves — adding a write inside them would break that
 * contract for every existing consumer. This module is a thin, caller-side
 * wrapper instead — the same shape presentToAgent.js already uses around
 * guardrail.js: call the underlying function, then persist the logEntry it
 * produced via auditLog.js's sanctioned write path.
 *
 * SCOPE NOTE: this module is not something STORY-003's story text asked
 * for. The story only asked to persist the logEntry objects classify.js
 * and reviewClassification.js already build. But nothing in this repo
 * called those pure functions in sequence outside of test files, so
 * without a caller, appendAuditEntry() would never run in practice and
 * STORY-003's own acceptance line ("given an action on a support request,
 * when it occurs, then it is logged in the audit trail") would not be
 * demonstrable. This is the minimal caller added to close that gap —
 * flagged here per CLAUDE.md's scope-lock rule (log the expansion, don't
 * silently build it in), not a silent scope expansion.
 *
 * A failed audit write does not block returning the underlying
 * classification/review result — STORY-003 requires alerting on a logging
 * failure, not blocking the recommend-only action that R4 already gates
 * behind human approval elsewhere. The failure is still surfaced via
 * `auditResult.ok === false` (and the ALERT already went to stderr from
 * auditLog.js) so a caller can decide how to react.
 */

import { classifySupportRequest } from './classify.js';
import { reviewClassification } from './reviewClassification.js';
import { searchKnowledgeBase } from './knowledgeBaseSearch.js';
import { generateDraftResponse } from './generateDraftResponse.js';
import { generateEscalationRecommendation } from './generateEscalationRecommendation.js';
import { reviewEscalation } from './reviewEscalation.js';
import { generateSupportSummary } from './generateSupportSummary.js';
import { saveSupportSummary } from './saveSupportSummary.js';
import { appendAuditEntry } from './auditLog.js';

/**
 * Classify a support request and persist the resulting logEntry to the
 * audit trail.
 *
 * @param {unknown} requestText
 * @param {{ logPath?: string }} [options]   Passed through to appendAuditEntry (tests only).
 * @returns {import('./classify.js').ClassificationResult & { auditResult: import('./auditLog.js').AuditAppendResult }}
 */
export function classifyAndLog(requestText, options = {}) {
  const result = classifySupportRequest(requestText);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}

/**
 * Review a classification decision and persist the resulting logEntry to
 * the audit trail.
 *
 * @param {unknown} classification
 * @param {unknown} decision
 * @param {{ logPath?: string }} [options]   Passed through to appendAuditEntry (tests only).
 * @returns {import('./reviewClassification.js').ReviewResult & { auditResult: import('./auditLog.js').AuditAppendResult }}
 */
export function reviewAndLog(classification, decision, options = {}) {
  const result = reviewClassification(classification, decision);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}

/**
 * Search the knowledge base for a classification and persist the resulting
 * logEntry (the search query and result summary) to the audit trail.
 *
 * @param {unknown} classification
 * @param {{ logPath?: string, kbPath?: string|URL, timeoutMs?: number }} [options]
 *   `logPath` is passed through to appendAuditEntry (tests only); `kbPath`/`timeoutMs`
 *   are passed through to searchKnowledgeBase (tests only).
 * @returns {Promise<import('./knowledgeBaseSearch.js').KnowledgeBaseSearchResult & { auditResult: import('./auditLog.js').AuditAppendResult }>}
 */
export async function searchKnowledgeBaseAndLog(classification, options = {}) {
  const result = await searchKnowledgeBase(classification, options);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}

/**
 * Generate a draft response for a classification (and its knowledge-base
 * search result) and persist the resulting logEntry to the audit trail.
 *
 * @param {unknown} classification
 * @param {unknown} kbSearchResult
 * @param {{ logPath?: string, templatesPath?: string|URL, timeoutMs?: number }} [options]
 *   `logPath` is passed through to appendAuditEntry (tests only); `templatesPath`/`timeoutMs`
 *   are passed through to generateDraftResponse (tests only).
 * @returns {Promise<import('./generateDraftResponse.js').DraftResponseResult & { auditResult: import('./auditLog.js').AuditAppendResult }>}
 */
export async function generateDraftResponseAndLog(classification, kbSearchResult, options = {}) {
  const result = await generateDraftResponse(classification, kbSearchResult, options);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}

/**
 * Decide whether to recommend escalation for a classification (and its
 * knowledge-base search result) and persist the resulting logEntry to the
 * audit trail.
 *
 * @param {unknown} classification
 * @param {unknown} kbSearchResult
 * @param {{ logPath?: string }} [options]   Passed through to appendAuditEntry (tests only).
 * @returns {import('./generateEscalationRecommendation.js').EscalationRecommendation & { auditResult: import('./auditLog.js').AuditAppendResult }}
 */
export function generateEscalationRecommendationAndLog(classification, kbSearchResult, options = {}) {
  const result = generateEscalationRecommendation(classification, kbSearchResult);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}

/**
 * Review an escalation recommendation decision and persist the resulting
 * logEntry to the audit trail.
 *
 * @param {unknown} recommendation
 * @param {unknown} decision
 * @param {{ logPath?: string }} [options]   Passed through to appendAuditEntry (tests only).
 * @returns {import('./reviewEscalation.js').EscalationReviewResult & { auditResult: import('./auditLog.js').AuditAppendResult }}
 */
export function reviewEscalationAndLog(recommendation, decision, options = {}) {
  const result = reviewEscalation(recommendation, decision);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}

/**
 * Compile a completed workflow into a final support summary and persist the
 * resulting logEntry to the audit trail.
 *
 * @param {unknown} workflow
 * @param {{ logPath?: string }} [options]   Passed through to appendAuditEntry (tests only).
 * @returns {import('./generateSupportSummary.js').SupportSummaryResult & { auditResult: import('./auditLog.js').AuditAppendResult }}
 */
export function generateSupportSummaryAndLog(workflow, options = {}) {
  const result = generateSupportSummary(workflow);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}

/**
 * Manually save a generated support summary and persist the resulting
 * logEntry to the audit trail.
 *
 * @param {unknown} summary
 * @param {{ logPath?: string, summariesDir?: string }} [options]
 *   `logPath` is passed through to appendAuditEntry (tests only); `summariesDir`
 *   is passed through to saveSupportSummary (tests only).
 * @returns {import('./saveSupportSummary.js').SaveSummaryResult & { auditResult: import('./auditLog.js').AuditAppendResult }}
 */
export function saveSupportSummaryAndLog(summary, options = {}) {
  const result = saveSupportSummary(summary, options);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}
