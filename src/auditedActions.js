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
 * STORY-008 (Classification Learning) adds three more wrappers following
 * that same shape — recordClassificationCorrectionAndLog,
 * checkForSuggestedRuleAndLog, reviewSuggestedRuleAndLog — with two
 * deliberate differences on the last. First: when a suggestion is approved,
 * reviewSuggestedRuleAndLog also calls classify.js's
 * applyApprovedClassificationRule() and persists a second, distinct audit
 * record for that write. This is the one place in this file where the
 * wrapper does more than "call the pure function, log its result" — because
 * this is the one action in this repo where a human approval is supposed to
 * actually change future behavior, not just get recorded. Second: a decided
 * suggestion (approved or rejected) is removed from the ticket queue
 * afterward via ticketQueue.js's removeTicketFromQueue — reject removes it
 * unconditionally, approve only removes it once applyResult.applied is true,
 * so a suggestion whose apply-write failed stays visible in the queue rather
 * than silently disappearing with nothing to show for it. (Fixed after
 * initially shipping without this — see STORY-009's PROGRESS.md entry,
 * which flagged the inconsistency against knowledgeBaseCorrections.js's
 * matching behavior below.)
 *
 * STORY-009 (Knowledge Base Learning) adds proposeKnowledgeBaseArticleAndLog
 * and reviewKnowledgeBaseProposalAndLog, the same shape again. Unlike
 * STORY-008's pair, reviewKnowledgeBaseProposalAndLog makes only ONE
 * underlying call for the KB write — knowledgeBaseCorrections.js's
 * reviewKnowledgeBaseProposal() itself performs the knowledgeBase.json write
 * on approve and the queue removal on either decision, per that story's spec
 * (one file, two exports, no separate apply step). It makes a second call of
 * its own, though: on a successful approve, it also builds and saves a
 * summary document for the newly added article via the existing, unmodified
 * saveSupportSummaryAndLog() (defined below) — reusing the same "finished
 * work gets a summary" pattern STORY-007 established for tickets, per
 * explicit user request. This intentionally does NOT go through
 * generateSupportSummary.js, whose validation requires a full ticket-workflow
 * bundle (classification, review, draft response, ...) that a KB proposal
 * never has — building the summary text directly here avoids fabricating
 * those fields just to satisfy a contract that doesn't fit.
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

import { classifySupportRequest, applyApprovedClassificationRule, revokeApprovedRule } from './classify.js';
import { reviewClassification } from './reviewClassification.js';
import { searchKnowledgeBase } from './knowledgeBaseSearch.js';
import { generateDraftResponse } from './generateDraftResponse.js';
import { generateEscalationRecommendation } from './generateEscalationRecommendation.js';
import { reviewEscalation } from './reviewEscalation.js';
import { generateSupportSummary } from './generateSupportSummary.js';
import { saveSupportSummary } from './saveSupportSummary.js';
import { recordClassificationCorrection, checkForSuggestedRule } from './classificationCorrections.js';
import { reviewSuggestedRule } from './reviewSuggestedRule.js';
import { proposeKnowledgeBaseArticle, reviewKnowledgeBaseProposal } from './knowledgeBaseCorrections.js';
import { removeTicketFromQueue } from './ticketQueue.js';
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

/**
 * Record a human's correction of a wrong classification and persist the
 * resulting logEntry to the audit trail.
 *
 * @param {unknown} correction
 * @param {{ logPath?: string, correctionsPath?: string|URL }} [options]
 *   `logPath` is passed through to appendAuditEntry (tests only); `correctionsPath`
 *   is passed through to recordClassificationCorrection (tests only).
 * @returns {import('./classificationCorrections.js').RecordCorrectionResult & { auditResult: import('./auditLog.js').AuditAppendResult }}
 */
export function recordClassificationCorrectionAndLog(correction, options = {}) {
  const result = recordClassificationCorrection(correction, options);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}

/**
 * Check recorded corrections for a repeating pattern, queue any resulting
 * suggestion(s) (via ticketQueue.js), and persist the resulting logEntry to
 * the audit trail.
 *
 * @param {{ logPath?: string, correctionsPath?: string|URL, queueDir?: string }} [options]
 *   `logPath` is passed through to appendAuditEntry (tests only); `correctionsPath`/`queueDir`
 *   are passed through to checkForSuggestedRule (tests only).
 * @returns {import('./classificationCorrections.js').CheckSuggestionsResult & { auditResult: import('./auditLog.js').AuditAppendResult }}
 */
export function checkForSuggestedRuleAndLog(options = {}) {
  const result = checkForSuggestedRule(options);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}

/**
 * Review a suggested classification rule change and persist the resulting
 * logEntry to the audit trail. On approval only, also applies the rule via
 * classify.js's applyApprovedClassificationRule() and persists a second,
 * distinct audit record for that write — see this file's header comment for
 * why this one wrapper does more than its siblings. Rejecting persists only
 * the decision; nothing is applied.
 *
 * @param {unknown} suggestion
 * @param {unknown} decision
 * @param {{ logPath?: string, rulesPath?: string|URL }} [options]
 *   `logPath` is passed through to appendAuditEntry (tests only); `rulesPath`
 *   is passed through to applyApprovedClassificationRule (tests only, approve path only).
 * @returns {import('./reviewSuggestedRule.js').SuggestedRuleReviewResult &
 *   { auditResult: import('./auditLog.js').AuditAppendResult,
 *     applyResult?: ReturnType<typeof applyApprovedClassificationRule>,
 *     applyAuditResult?: import('./auditLog.js').AuditAppendResult }}
 */
export function reviewSuggestedRuleAndLog(suggestion, decision, options = {}) {
  const result = reviewSuggestedRule(suggestion, decision);
  const auditResult = appendAuditEntry(result.logEntry, options);
  const requestId = suggestion && typeof suggestion === 'object' ? suggestion.requestId : undefined;

  if (result.outcome === 'rejected') {
    if (typeof requestId === 'string') removeTicketFromQueue(requestId, { queueDir: options.queueDir });
    return { ...result, auditResult };
  }

  if (result.outcome !== 'approved') {
    return { ...result, auditResult };
  }

  const applyResult = applyApprovedClassificationRule(
    { keyword: suggestion.keyword, category: suggestion.correctCategory },
    options,
  );
  const applyAuditResult = appendAuditEntry(applyResult.logEntry, options);

  // Only remove the suggestion from the queue once its effect actually landed —
  // a failed apply must not make a still-unresolved suggestion disappear.
  if (applyResult.applied && typeof requestId === 'string') {
    removeTicketFromQueue(requestId, { queueDir: options.queueDir });
  }

  return { ...result, auditResult, applyResult, applyAuditResult };
}

/**
 * Revoke a previously approved classification rule and persist the
 * resulting logEntry to the audit trail. See classify.js's
 * revokeApprovedRule() for revocation semantics — it marks the rule
 * `revoked: true` rather than deleting it, and is idempotent (revoking an
 * already-revoked rule is a no-op, not an error).
 *
 * @param {unknown} revocation
 * @param {{ logPath?: string, rulesPath?: string|URL }} [options]
 *   `logPath` is passed through to appendAuditEntry (tests only); `rulesPath`
 *   is passed through to revokeApprovedRule (tests only).
 * @returns {ReturnType<typeof revokeApprovedRule> & { auditResult: import('./auditLog.js').AuditAppendResult }}
 */
export function revokeApprovedRuleAndLog(revocation, options = {}) {
  const result = revokeApprovedRule(revocation, options);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}

/**
 * Propose a new knowledge base article from a human-solved ticket and
 * persist the resulting logEntry to the audit trail.
 *
 * @param {unknown} proposal
 * @param {{ logPath?: string, kbPath?: string|URL, queueDir?: string }} [options]
 *   `logPath` is passed through to appendAuditEntry (tests only); `kbPath`/`queueDir`
 *   are passed through to proposeKnowledgeBaseArticle (tests only).
 * @returns {import('./knowledgeBaseCorrections.js').ProposeArticleResult & { auditResult: import('./auditLog.js').AuditAppendResult }}
 */
export function proposeKnowledgeBaseArticleAndLog(proposal, options = {}) {
  const result = proposeKnowledgeBaseArticle(proposal, options);
  const auditResult = appendAuditEntry(result.logEntry, options);
  return { ...result, auditResult };
}

/**
 * Plain-text summary for a newly approved knowledge base article — the KB
 * counterpart to generateSupportSummary.js's ticket summary, built directly
 * rather than through that module (see this file's header comment for why).
 * Only ever called with real, already-produced data: the article as written
 * to knowledgeBase.json, the originating ticket, and who proposed/approved it.
 *
 * @param {{ article: Object, sourceTicketId: string|undefined, proposedBy: string|undefined,
 *   reviewer: string }} fields
 * @returns {string}
 */
function buildKbProposalSummaryText({ article, sourceTicketId, proposedBy, reviewer }) {
  const lines = [];
  lines.push(`Knowledge Base Article Approved — ${article.id}`);
  lines.push('');
  lines.push(`Title: ${article.title}`);
  lines.push(`Category: ${article.category}`);
  lines.push(`Tags: ${article.tags.join(', ')}`);
  lines.push('');
  lines.push('Steps:');
  article.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push('');
  lines.push(`Originating ticket: ${sourceTicketId ?? 'unknown'}`);
  lines.push(`Proposed by: ${proposedBy ?? 'unknown'}`);
  lines.push(`Approved by: ${reviewer}`);
  return lines.join('\n');
}

/**
 * Review a knowledge base article proposal by id and persist the resulting
 * logEntry to the audit trail. On approve, knowledgeBaseCorrections.js's
 * reviewKnowledgeBaseProposal() itself writes the new article into
 * knowledgeBase.json and removes the proposal from the queue — unlike
 * reviewSuggestedRuleAndLog, this wrapper doesn't need a second call to make
 * that part happen, since it's intrinsic to that one decision (per this
 * story's spec: one file, two exports). It does make one call of its own,
 * though: on a successful approve, it builds and saves a summary document
 * for the newly added article via the existing saveSupportSummaryAndLog()
 * (unmodified — reused exactly as STORY-007 built it), per explicit user
 * request that approved KB articles get the same "finished work gets a
 * summary" treatment tickets already do. Reject saves no summary — nothing
 * changed, so there's nothing finished to document.
 *
 * @param {unknown} proposalId
 * @param {unknown} decision
 * @param {{ logPath?: string, kbPath?: string|URL, queueDir?: string, summariesDir?: string }} [options]
 *   `logPath` is passed through to appendAuditEntry (tests only); `kbPath`/`queueDir`
 *   are passed through to reviewKnowledgeBaseProposal (tests only); `summariesDir`
 *   is passed through to saveSupportSummary (tests only).
 * @returns {import('./knowledgeBaseCorrections.js').KnowledgeBaseReviewResult &
 *   { auditResult: import('./auditLog.js').AuditAppendResult,
 *     summaryResult?: import('./saveSupportSummary.js').SaveSummaryResult & { auditResult: import('./auditLog.js').AuditAppendResult } }}
 */
export function reviewKnowledgeBaseProposalAndLog(proposalId, decision, options = {}) {
  const result = reviewKnowledgeBaseProposal(proposalId, decision, options);
  const auditResult = appendAuditEntry(result.logEntry, options);

  if (result.outcome !== 'approved' || !result.article) {
    return { ...result, auditResult };
  }

  const summaryText = buildKbProposalSummaryText({
    article: result.article,
    sourceTicketId: result.sourceTicketId,
    proposedBy: result.proposedBy,
    reviewer: decision.reviewer,
  });
  const summaryResult = saveSupportSummaryAndLog({ generated: true, ticketId: result.article.id, summaryText }, options);

  return { ...result, auditResult, summaryResult };
}
