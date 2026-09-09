import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyAndLog,
  reviewAndLog,
  generateEscalationRecommendationAndLog,
  reviewEscalationAndLog,
  generateSupportSummaryAndLog,
  saveSupportSummaryAndLog,
  recordClassificationCorrectionAndLog,
  checkForSuggestedRuleAndLog,
  reviewSuggestedRuleAndLog,
  revokeApprovedRuleAndLog,
  proposeKnowledgeBaseArticleAndLog,
  reviewKnowledgeBaseProposalAndLog,
} from '../src/auditedActions.js';
import { classifySupportRequest, applyApprovedClassificationRule } from '../src/classify.js';
import { SUGGESTION_THRESHOLD } from '../src/classificationCorrections.js';
import { addTicketToQueue, listQueuedTickets } from '../src/ticketQueue.js';

// Each test file gets its own unique subdirectory (not the shared 'tests/tmp'
// root) because node --test runs files concurrently in separate processes;
// a shared literal directory name means one file's cleanup can delete the
// directory out from under another file's still-running test.
const TMP_DIR = join('tests/tmp', `auditedActions-${randomUUID()}`);

function tempLogPath() {
  return join(TMP_DIR, `audit-${randomUUID()}.log`);
}

function readLines(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- classifyAndLog: an action is logged when it occurs -------------------

test('classifyAndLog returns the same shape classifySupportRequest would', () => {
  const logPath = tempLogPath();
  const direct = classifySupportRequest("I can't log in, locked out.");
  const wrapped = classifyAndLog("I can't log in, locked out.", { logPath });

  assert.equal(wrapped.category, direct.category);
  assert.equal(wrapped.priority, direct.priority);
  assert.equal(wrapped.summary, direct.summary);
});

test('classifyAndLog persists the classification logEntry to the audit trail', () => {
  const logPath = tempLogPath();
  const result = classifyAndLog('Power BI dashboard is blank.', { logPath });

  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.deepEqual(record.entry, result.logEntry);
  assert.equal(record.entry.event, 'support_request_classified');
});

test('classifyAndLog logs even a failed classification (empty input)', () => {
  const logPath = tempLogPath();
  const result = classifyAndLog('', { logPath });

  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.outcome, 'failure');
});

// --- reviewAndLog: an action is logged when it occurs ----------------------

const VALID_CLASSIFICATION = { category: 'login_problem', priority: 'high', summary: 'locked out' };

test('reviewAndLog returns the same shape reviewClassification would, for approve', () => {
  const logPath = tempLogPath();
  const decision = { action: 'approve', reviewer: 'agent.jane' };
  const result = reviewAndLog(VALID_CLASSIFICATION, decision, { logPath });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'approved');
  assert.deepEqual(result.classification, VALID_CLASSIFICATION);
});

test('reviewAndLog persists the approval logEntry to the audit trail', () => {
  const logPath = tempLogPath();
  const decision = { action: 'approve', reviewer: 'agent.jane' };
  const result = reviewAndLog(VALID_CLASSIFICATION, decision, { logPath });

  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.event, 'classification_approved');
  assert.equal(record.entry.context.reviewer, 'agent.jane');
});

test('reviewAndLog persists the rejection logEntry to the audit trail', () => {
  const logPath = tempLogPath();
  const decision = { action: 'reject', reviewer: 'agent.jane', reason: 'wrong category' };
  const result = reviewAndLog(VALID_CLASSIFICATION, decision, { logPath });

  assert.equal(result.outcome, 'rejected');
  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.event, 'classification_rejected');
});

test('reviewAndLog still logs a failure entry for malformed decisions (fails closed)', () => {
  const logPath = tempLogPath();
  const result = reviewAndLog(VALID_CLASSIFICATION, { action: 'approve' }, { logPath });

  assert.equal(result.ok, false);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.event, 'classification_review_failed');
});

// --- humanSummary: plain-English audit field on reject / recommended-escalation ---

test('reviewAndLog adds a plain-English humanSummary on reject, naming the real reason', () => {
  const logPath = tempLogPath();
  const decision = { action: 'reject', reviewer: 'agent.jane', reason: 'Wrong category, this is a billing issue' };
  const result = reviewAndLog(VALID_CLASSIFICATION, decision, { logPath });

  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /rejected/);
  assert.ok(result.logEntry.humanSummary.includes('Wrong category, this is a billing issue'));
});

test('reviewAndLog\'s humanSummary does not double up the period when the reason already ends in terminal punctuation', () => {
  const logPath = tempLogPath();
  const decision = { action: 'reject', reviewer: 'agent.jane', reason: 'Wrong category.' };
  const result = reviewAndLog(VALID_CLASSIFICATION, decision, { logPath });

  assert.ok(result.logEntry.humanSummary.includes('Wrong category.'));
  assert.ok(!result.logEntry.humanSummary.endsWith('..'));
});

test('reviewAndLog does NOT add humanSummary on approve', () => {
  const logPath = tempLogPath();
  const decision = { action: 'approve', reviewer: 'agent.jane' };
  const result = reviewAndLog(VALID_CLASSIFICATION, decision, { logPath });

  assert.equal(result.outcome, 'approved');
  assert.equal(result.logEntry.humanSummary, undefined);
});

const ESCALATION_CLASSIFICATION = { category: 'sql_database_issue', priority: 'high', summary: 'Query is timing out.' };
const NOT_FOUND_KB_RESULT = { found: false };
const FOUND_KB_RESULT = { found: true };

test('generateEscalationRecommendationAndLog adds a plain-English humanSummary when recommended, including the real explanation', () => {
  const logPath = tempLogPath();
  const result = generateEscalationRecommendationAndLog(ESCALATION_CLASSIFICATION, NOT_FOUND_KB_RESULT, { logPath });

  assert.equal(result.recommended, true);
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /(escalat|human specialist|human review)/i);
  assert.ok(result.explanation && result.logEntry.humanSummary.includes(result.explanation));
});

test('generateEscalationRecommendationAndLog does NOT add humanSummary when not recommended', () => {
  const logPath = tempLogPath();
  const result = generateEscalationRecommendationAndLog(ESCALATION_CLASSIFICATION, FOUND_KB_RESULT, { logPath });

  assert.equal(result.recommended, false);
  assert.equal(result.logEntry.humanSummary, undefined);
});

// --- Multiple actions on one request chain into one trail -----------------

test('a classify-then-review sequence produces two chained records in order', () => {
  const logPath = tempLogPath();
  const classified = classifyAndLog("Can't log in, account is locked out.", { logPath });
  reviewAndLog(classified, { action: 'approve', reviewer: 'agent.jane' }, { logPath });

  const lines = readLines(logPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].entry.event, 'support_request_classified');
  assert.equal(lines[1].entry.event, 'classification_approved');
  assert.equal(lines[1].prevHash, lines[0].hash);
});

// --- Logging failure does not block the underlying action -----------------

test('a blocked audit write still returns the classification result, with auditResult.ok false', () => {
  const blocker = join(TMP_DIR, `blocker-${randomUUID()}`);
  writeFileSync(blocker, 'i am a file, not a directory', 'utf8');
  const logPath = join(blocker, 'audit-trail.log');

  const result = classifyAndLog("I can't log in.", { logPath });

  assert.equal(result.category, 'login_problem');
  assert.equal(result.auditResult.ok, false);
  assert.equal(result.auditResult.error, 'audit_log_write_failed');
});

// --- STORY-008: classification learning wrappers ------------------------------

const VALID_CORRECTION = {
  requestId: 'REQ-1',
  keyword: 'widget',
  wrongCategory: 'sql_database_issue',
  correctCategory: 'general_support_request',
  reviewer: 'agent.jane',
};

const VALID_SUGGESTION = {
  type: 'suggested_rule_change',
  keyword: 'widget',
  wrongCategory: 'sql_database_issue',
  correctCategory: 'general_support_request',
  timesSeen: 3,
  requestId: 'rule-suggestion-test1',
};

test('recordClassificationCorrectionAndLog persists the correction logEntry to the audit trail', () => {
  const logPath = tempLogPath();
  const correctionsPath = join(TMP_DIR, `corrections-${randomUUID()}.json`);
  const result = recordClassificationCorrectionAndLog(VALID_CORRECTION, { logPath, correctionsPath });

  assert.equal(result.ok, true);
  assert.equal(result.recorded, true);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.event, 'classification_correction_recorded');
});

test('checkForSuggestedRuleAndLog persists a logEntry whether or not a suggestion is created', () => {
  const logPath = tempLogPath();
  const correctionsPath = join(TMP_DIR, `corrections-${randomUUID()}.json`);
  const queueDir = join(TMP_DIR, `queue-${randomUUID()}`);

  const noSuggestionYet = checkForSuggestedRuleAndLog({ logPath, correctionsPath, queueDir });
  assert.equal(noSuggestionYet.suggested, false);
  assert.equal(noSuggestionYet.auditResult.ok, true);

  for (let i = 0; i < SUGGESTION_THRESHOLD; i++) {
    recordClassificationCorrectionAndLog({ ...VALID_CORRECTION, requestId: `REQ-${i}` }, { logPath, correctionsPath });
  }
  const withSuggestion = checkForSuggestedRuleAndLog({ logPath, correctionsPath, queueDir });
  assert.equal(withSuggestion.suggested, true);

  const lines = readLines(logPath);
  assert.ok(lines.some((line) => line.entry.event === 'rule_suggestion_created'));
});

test('reviewSuggestedRuleAndLog on reject logs the decision but does not call applyApprovedClassificationRule', () => {
  const logPath = tempLogPath();
  const decision = { action: 'reject', reviewer: 'agent.jane' };
  const result = reviewSuggestedRuleAndLog(VALID_SUGGESTION, decision, { logPath });

  assert.equal(result.outcome, 'rejected');
  assert.equal(result.auditResult.ok, true);
  assert.equal(result.applyResult, undefined);

  const lines = readLines(logPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].entry.event, 'rule_suggestion_rejected');
});

test('reviewSuggestedRuleAndLog on approve also applies the rule and logs a second, distinct entry', () => {
  const logPath = tempLogPath();
  const rulesPath = join(TMP_DIR, `rules-${randomUUID()}.json`);
  const decision = { action: 'approve', reviewer: 'agent.jane' };
  const result = reviewSuggestedRuleAndLog(VALID_SUGGESTION, decision, { logPath, rulesPath });

  assert.equal(result.outcome, 'approved');
  assert.equal(result.applyResult.ok, true);
  assert.equal(result.applyResult.applied, true);
  assert.equal(result.applyAuditResult.ok, true);

  const lines = readLines(logPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].entry.event, 'rule_suggestion_approved');
  assert.equal(lines[1].entry.event, 'approved_classification_rule_applied');
  assert.equal(lines[1].prevHash, lines[0].hash);
});

// --- reviewSuggestedRuleAndLog: decided suggestions are removed from the queue,
//     matching knowledgeBaseCorrections.js's behavior (fixed after initially
//     shipping without this — see PROGRESS.md's STORY-009 follow-up entry) ---

test('a rejected suggestion is removed from the ticket queue', () => {
  const logPath = tempLogPath();
  const queueDir = join(TMP_DIR, `queue-${randomUUID()}`);
  addTicketToQueue(VALID_SUGGESTION, { queueDir });

  reviewSuggestedRuleAndLog(VALID_SUGGESTION, { action: 'reject', reviewer: 'agent.jane' }, { logPath, queueDir });

  assert.equal(listQueuedTickets({ queueDir }).length, 0);
});

test('an approved suggestion is removed from the ticket queue once the rule write succeeds', () => {
  const logPath = tempLogPath();
  const rulesPath = join(TMP_DIR, `rules-${randomUUID()}.json`);
  const queueDir = join(TMP_DIR, `queue-${randomUUID()}`);
  addTicketToQueue(VALID_SUGGESTION, { queueDir });

  const result = reviewSuggestedRuleAndLog(VALID_SUGGESTION, { action: 'approve', reviewer: 'agent.jane' }, { logPath, rulesPath, queueDir });

  assert.equal(result.applyResult.applied, true);
  assert.equal(listQueuedTickets({ queueDir }).length, 0);
});

test('an approved suggestion is NOT removed from the queue if the rule write fails — nothing silently disappears', () => {
  const logPath = tempLogPath();
  const queueDir = join(TMP_DIR, `queue-${randomUUID()}`);
  // Point rulesPath at a directory (not a file) so the write inside applyApprovedClassificationRule fails.
  const blockerDir = join(TMP_DIR, `blocker-dir-${randomUUID()}`);
  mkdirSync(blockerDir, { recursive: true });
  const rulesPath = blockerDir; // existsSync(rulesPath) is true, but it's a directory, so writeFileSync fails.
  addTicketToQueue(VALID_SUGGESTION, { queueDir });

  const result = reviewSuggestedRuleAndLog(VALID_SUGGESTION, { action: 'approve', reviewer: 'agent.jane' }, { logPath, rulesPath, queueDir });

  assert.equal(result.applyResult.applied, false);
  assert.equal(listQueuedTickets({ queueDir }).length, 1, 'a suggestion whose apply failed must stay visible in the queue');
});

// --- STORY-008: full flow, tying classificationCorrections + reviewSuggestedRule
//     + classify.js together -----------------------------------------------------

test('a rejected suggestion does not change classifySupportRequest()\'s behavior for that keyword', () => {
  const logPath = tempLogPath();
  const correctionsPath = join(TMP_DIR, `corrections-${randomUUID()}.json`);
  const queueDir = join(TMP_DIR, `queue-${randomUUID()}`);
  const rulesPath = join(TMP_DIR, `rules-${randomUUID()}.json`);

  const before = classifySupportRequest('There is a gizmo problem today.', { rulesPath });
  assert.equal(before.category, 'general_support_request');

  for (let i = 0; i < SUGGESTION_THRESHOLD; i++) {
    recordClassificationCorrectionAndLog(
      { requestId: `REQ-${i}`, keyword: 'gizmo', wrongCategory: 'general_support_request', correctCategory: 'data_issue', reviewer: 'agent.jane' },
      { logPath, correctionsPath },
    );
  }
  const { suggestions } = checkForSuggestedRuleAndLog({ logPath, correctionsPath, queueDir });
  assert.equal(suggestions.length, 1);

  const rejectResult = reviewSuggestedRuleAndLog(suggestions[0], { action: 'reject', reviewer: 'agent.jane' }, { logPath, rulesPath });
  assert.equal(rejectResult.outcome, 'rejected');

  const after = classifySupportRequest('There is a gizmo problem today.', { rulesPath });
  assert.equal(after.category, 'general_support_request', 'a rejected suggestion must not change classify.js behavior');
});

test('an approved suggestion DOES change classifySupportRequest()\'s behavior for that keyword going forward', () => {
  const logPath = tempLogPath();
  const correctionsPath = join(TMP_DIR, `corrections-${randomUUID()}.json`);
  const queueDir = join(TMP_DIR, `queue-${randomUUID()}`);
  const rulesPath = join(TMP_DIR, `rules-${randomUUID()}.json`);

  const before = classifySupportRequest('There is a sprocket problem today.', { rulesPath });
  assert.equal(before.category, 'general_support_request');

  for (let i = 0; i < SUGGESTION_THRESHOLD; i++) {
    recordClassificationCorrectionAndLog(
      { requestId: `REQ-${i}`, keyword: 'sprocket', wrongCategory: 'general_support_request', correctCategory: 'data_issue', reviewer: 'agent.jane' },
      { logPath, correctionsPath },
    );
  }
  const { suggestions } = checkForSuggestedRuleAndLog({ logPath, correctionsPath, queueDir });

  const approveResult = reviewSuggestedRuleAndLog(suggestions[0], { action: 'approve', reviewer: 'agent.jane' }, { logPath, rulesPath });
  assert.equal(approveResult.outcome, 'approved');
  assert.equal(approveResult.applyResult.applied, true);

  const after = classifySupportRequest('There is a sprocket problem today.', { rulesPath });
  assert.equal(after.category, 'data_issue', 'an approved suggestion must change classify.js behavior going forward');
});

// --- STORY-010: revokeApprovedRuleAndLog ---------------------------------------

test('revokeApprovedRuleAndLog persists a distinct approved_classification_rule_revoked entry, not merged into the original _applied entry', () => {
  const logPath = tempLogPath();
  const rulesPath = join(TMP_DIR, `rules-${randomUUID()}.json`);

  const applyResult = applyApprovedClassificationRule({ keyword: 'widget', category: 'sql_database_issue' }, { rulesPath });
  assert.equal(applyResult.applied, true);

  const result = revokeApprovedRuleAndLog(
    { keyword: 'widget', reason: 'Too broad, causing misclassifications.', reviewer: 'agent.jane' },
    { logPath, rulesPath },
  );

  assert.equal(result.ok, true);
  assert.equal(result.revoked, true);
  assert.equal(result.auditResult.ok, true);

  // Only the revoke call itself was logged (the apply call above used a separate,
  // unlogged path) — one record, its own distinct event, not folded into anything else.
  const lines = readLines(logPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].entry.event, 'approved_classification_rule_revoked');
  assert.equal(lines[0].entry.context.keyword, 'widget');
  assert.equal(lines[0].entry.context.reviewer, 'agent.jane');
});

test('revokeApprovedRuleAndLog logs a distinct entry for an apply-then-revoke sequence, chained after the applied entry', () => {
  const logPath = tempLogPath();
  const rulesPath = join(TMP_DIR, `rules-${randomUUID()}.json`);
  const decision = { action: 'approve', reviewer: 'agent.jane' };

  const applyResult = reviewSuggestedRuleAndLog(VALID_SUGGESTION, decision, { logPath, rulesPath });
  assert.equal(applyResult.applyResult.applied, true);

  const revokeResult = revokeApprovedRuleAndLog(
    { keyword: VALID_SUGGESTION.keyword, reason: 'Superseded by a better rule.', reviewer: 'agent.jane' },
    { logPath, rulesPath },
  );
  assert.equal(revokeResult.revoked, true);

  const lines = readLines(logPath);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].entry.event, 'rule_suggestion_approved');
  assert.equal(lines[1].entry.event, 'approved_classification_rule_applied');
  assert.equal(lines[2].entry.event, 'approved_classification_rule_revoked');
  assert.equal(lines[2].prevHash, lines[1].hash);
});

test('revokeApprovedRuleAndLog still logs a failure entry for a keyword with no approved rule (fails closed)', () => {
  const logPath = tempLogPath();
  const rulesPath = join(TMP_DIR, `rules-${randomUUID()}.json`);

  const result = revokeApprovedRuleAndLog({ keyword: 'nonexistent', reason: 'irrelevant', reviewer: 'agent.jane' }, { logPath, rulesPath });

  assert.equal(result.ok, false);
  assert.equal(result.notFound, true);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.event, 'approved_classification_rule_revoke_failed');
  assert.equal(record.entry.error_class, 'RuleNotFoundError');
});

// --- STORY-009: knowledge base learning wrappers -------------------------------

const SEED_KB_ARTICLES = [{ id: 'KB-001', category: 'login_problem', tags: ['password'], title: 'Reset a password', steps: ['do it'] }];

function tempKbPath() {
  const kbPath = join(TMP_DIR, `kb-${randomUUID()}.json`);
  writeFileSync(kbPath, JSON.stringify({ articles: SEED_KB_ARTICLES }));
  return kbPath;
}

const VALID_KB_PROPOSAL = {
  sourceTicketId: 'TICKET-9001',
  proposedBy: 'agent.jane',
  category: 'sql_database_issue',
  tags: ['widget', 'sync error'],
  title: 'Widget fails to sync with the SQL backend',
  steps: ['Restart the sync worker.'],
};

test('proposeKnowledgeBaseArticleAndLog persists the proposal logEntry to the audit trail', () => {
  const logPath = tempLogPath();
  const kbPath = tempKbPath();
  const queueDir = join(TMP_DIR, `kb-queue-${randomUUID()}`);
  const result = proposeKnowledgeBaseArticleAndLog(VALID_KB_PROPOSAL, { logPath, kbPath, queueDir });

  assert.equal(result.ok, true);
  assert.equal(result.proposed, true);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.event, 'kb_article_proposed');
});

test('reviewKnowledgeBaseProposalAndLog on approve persists the decision logEntry and writes the article', () => {
  const logPath = tempLogPath();
  const kbPath = tempKbPath();
  const queueDir = join(TMP_DIR, `kb-queue-${randomUUID()}`);
  const summariesDir = join(TMP_DIR, `summaries-${randomUUID()}`);
  const { proposalId } = proposeKnowledgeBaseArticleAndLog(VALID_KB_PROPOSAL, { logPath, kbPath, queueDir });

  const result = reviewKnowledgeBaseProposalAndLog(
    proposalId,
    { action: 'approve', reviewer: 'agent.jane' },
    { logPath, kbPath, queueDir, summariesDir },
  );

  assert.equal(result.outcome, 'approved');
  assert.equal(result.auditResult.ok, true);
  const lines = readLines(logPath);
  assert.equal(lines[0].entry.event, 'kb_article_proposed');
  assert.equal(lines[1].entry.event, 'kb_proposal_approved');
  assert.equal(lines[1].prevHash, lines[0].hash);

  const onDisk = JSON.parse(readFileSync(kbPath, 'utf8'));
  assert.ok(onDisk.articles.some((a) => a.id === proposalId));
});

// --- Task 2: an approved KB proposal also gets a saved summary document -------

test('reviewKnowledgeBaseProposalAndLog on approve also saves a summary document, chained into the same audit trail', () => {
  const logPath = tempLogPath();
  const kbPath = tempKbPath();
  const queueDir = join(TMP_DIR, `kb-queue-${randomUUID()}`);
  const summariesDir = join(TMP_DIR, `summaries-${randomUUID()}`);
  const { proposalId } = proposeKnowledgeBaseArticleAndLog(VALID_KB_PROPOSAL, { logPath, kbPath, queueDir });

  const result = reviewKnowledgeBaseProposalAndLog(
    proposalId,
    { action: 'approve', reviewer: 'agent.jane' },
    { logPath, kbPath, queueDir, summariesDir },
  );

  assert.equal(result.summaryResult.ok, true);
  assert.equal(result.summaryResult.saved, true);
  assert.equal(result.summaryResult.auditResult.ok, true);

  const summaryOnDisk = JSON.parse(readFileSync(join(summariesDir, `${proposalId}.json`), 'utf8'));
  assert.match(summaryOnDisk.summaryText, /Knowledge Base Article Approved/);
  assert.match(summaryOnDisk.summaryText, new RegExp(VALID_KB_PROPOSAL.sourceTicketId));
  assert.match(summaryOnDisk.summaryText, new RegExp(VALID_KB_PROPOSAL.proposedBy));

  const lines = readLines(logPath);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].entry.event, 'kb_article_proposed');
  assert.equal(lines[1].entry.event, 'kb_proposal_approved');
  assert.equal(lines[2].entry.event, 'support_summary_saved');
  assert.equal(lines[2].prevHash, lines[1].hash);
});

test('reviewKnowledgeBaseProposalAndLog on reject saves no summary document — nothing changed', () => {
  const logPath = tempLogPath();
  const kbPath = tempKbPath();
  const queueDir = join(TMP_DIR, `kb-queue-${randomUUID()}`);
  const summariesDir = join(TMP_DIR, `summaries-${randomUUID()}`);
  const { proposalId } = proposeKnowledgeBaseArticleAndLog(VALID_KB_PROPOSAL, { logPath, kbPath, queueDir });

  const result = reviewKnowledgeBaseProposalAndLog(
    proposalId,
    { action: 'reject', reviewer: 'agent.jane' },
    { logPath, kbPath, queueDir, summariesDir },
  );

  assert.equal(result.summaryResult, undefined);
  assert.equal(existsSync(join(summariesDir, `${proposalId}.json`)), false);
});

test('reviewKnowledgeBaseProposalAndLog on reject logs the decision and never touches knowledgeBase.json', () => {
  const logPath = tempLogPath();
  const kbPath = tempKbPath();
  const queueDir = join(TMP_DIR, `kb-queue-${randomUUID()}`);
  const before = readFileSync(kbPath, 'utf8');
  const { proposalId } = proposeKnowledgeBaseArticleAndLog(VALID_KB_PROPOSAL, { logPath, kbPath, queueDir });

  const result = reviewKnowledgeBaseProposalAndLog(proposalId, { action: 'reject', reviewer: 'agent.jane' }, { logPath, kbPath, queueDir });

  assert.equal(result.outcome, 'rejected');
  assert.equal(readFileSync(kbPath, 'utf8'), before);
  const lines = readLines(logPath);
  assert.equal(lines[lines.length - 1].entry.event, 'kb_proposal_rejected');
});

// --- humanSummary: remaining audit log entry points ------------------------
// (classifyAndLog / reviewEscalationAndLog / generateSupportSummaryAndLog were
// covered in the same round as reviewAndLog/generateEscalationRecommendationAndLog
// above, but reviewEscalationAndLog was never given its own test — added here too,
// so every function in this file that sets humanSummary now has coverage.)

test('classifyAndLog adds a plain-English humanSummary naming the category and priority on success', () => {
  const logPath = tempLogPath();
  const result = classifyAndLog('Power BI dashboard is blank.', { logPath });

  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /classified/);
  assert.ok(result.logEntry.humanSummary.includes(result.category.replace(/_/g, ' ')));
  assert.ok(result.logEntry.humanSummary.includes(result.priority));
});

test('classifyAndLog does NOT add humanSummary on a failed classification (empty input)', () => {
  const logPath = tempLogPath();
  const result = classifyAndLog('', { logPath });

  assert.equal(result.logEntry.outcome, 'failure');
  assert.equal(result.logEntry.humanSummary, undefined);
});

test('reviewEscalationAndLog adds a plain-English humanSummary on approve', () => {
  const logPath = tempLogPath();
  const recommendation = generateEscalationRecommendationAndLog(ESCALATION_CLASSIFICATION, NOT_FOUND_KB_RESULT, { logPath: tempLogPath() });
  const result = reviewEscalationAndLog(recommendation, { action: 'approve', reviewer: 'agent.jane' }, { logPath });

  assert.equal(result.outcome, 'approved');
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /approved/i);
  assert.match(result.logEntry.humanSummary, /escalat/i);
});

test('reviewEscalationAndLog adds a plain-English humanSummary on reject, naming the real reason', () => {
  const logPath = tempLogPath();
  const recommendation = generateEscalationRecommendationAndLog(ESCALATION_CLASSIFICATION, NOT_FOUND_KB_RESULT, { logPath: tempLogPath() });
  const decision = { action: 'reject', reviewer: 'agent.jane', reason: 'Agent will handle this one directly' };
  const result = reviewEscalationAndLog(recommendation, decision, { logPath });

  assert.equal(result.outcome, 'rejected');
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /rejected/i);
  assert.ok(result.logEntry.humanSummary.includes('Agent will handle this one directly'));
});

test('reviewEscalationAndLog does NOT add humanSummary when the input is malformed (fails closed)', () => {
  const logPath = tempLogPath();
  const result = reviewEscalationAndLog({ recommended: false }, { action: 'approve', reviewer: 'agent.jane' }, { logPath });

  assert.equal(result.outcome, 'error');
  assert.equal(result.logEntry.humanSummary, undefined);
});

const VALID_DRAFT_RESPONSE = { generated: true };

function validClassificationReview(reviewer = 'agent.jane') {
  return { outcome: 'approved', logEntry: { context: { reviewer } } };
}

test('generateSupportSummaryAndLog adds a plain-English humanSummary stating a summary was generated, without escalation', () => {
  const logPath = tempLogPath();
  const workflow = {
    ticketId: 'TICKET-2001',
    requestText: 'Cannot log in.',
    classification: { category: 'login_problem', priority: 'high' },
    classificationReview: validClassificationReview(),
    draftResponse: VALID_DRAFT_RESPONSE,
  };
  const result = generateSupportSummaryAndLog(workflow, { logPath });

  assert.equal(result.generated, true);
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /summary was generated/);
  assert.match(result.logEntry.humanSummary, /without escalation/);
});

test('generateSupportSummaryAndLog\'s humanSummary mentions escalation when the ticket was escalated', () => {
  const logPath = tempLogPath();
  const escalationRecommendation = { recommended: true, explanation: 'No relevant knowledge base match was found.' };
  const escalationReview = {
    outcome: 'approved',
    recommendation: escalationRecommendation,
    logEntry: { context: { reviewer: 'agent.jane' } },
  };
  const workflow = {
    ticketId: 'TICKET-2002',
    requestText: 'Query is timing out.',
    classification: { category: 'sql_database_issue', priority: 'high' },
    classificationReview: validClassificationReview(),
    draftResponse: VALID_DRAFT_RESPONSE,
    escalationRecommendation,
    escalationReview,
  };
  const result = generateSupportSummaryAndLog(workflow, { logPath });

  assert.equal(result.generated, true);
  assert.match(result.logEntry.humanSummary, /summary was generated/);
  assert.match(result.logEntry.humanSummary, /escalated to a human specialist/);
});

test('generateSupportSummaryAndLog does NOT add humanSummary when the summary was not generated (invalid workflow)', () => {
  const logPath = tempLogPath();
  const result = generateSupportSummaryAndLog({ ticketId: '' }, { logPath });

  assert.equal(result.generated, false);
  assert.equal(result.logEntry.humanSummary, undefined);
});

test('saveSupportSummaryAndLog adds a plain-English humanSummary on a successful save', () => {
  const logPath = tempLogPath();
  const summariesDir = join(TMP_DIR, `summaries-${randomUUID()}`);
  const summary = { generated: true, ticketId: 'TICKET-3001', summaryText: 'Support Summary — Ticket TICKET-3001' };
  const result = saveSupportSummaryAndLog(summary, { logPath, summariesDir });

  assert.equal(result.saved, true);
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /saved/);
  assert.match(result.logEntry.humanSummary, /record-keeping/);
});

test('saveSupportSummaryAndLog does NOT add humanSummary when the summary is not savable (malformed)', () => {
  const logPath = tempLogPath();
  const summariesDir = join(TMP_DIR, `summaries-${randomUUID()}`);
  const result = saveSupportSummaryAndLog({ generated: false }, { logPath, summariesDir });

  assert.equal(result.saved, false);
  assert.equal(result.logEntry.humanSummary, undefined);
});

test('recordClassificationCorrectionAndLog adds a plain-English humanSummary naming both categories', () => {
  const logPath = tempLogPath();
  const correctionsPath = join(TMP_DIR, `corrections-${randomUUID()}.json`);
  const result = recordClassificationCorrectionAndLog(VALID_CORRECTION, { logPath, correctionsPath });

  assert.equal(result.recorded, true);
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /corrected/);
  assert.ok(result.logEntry.humanSummary.includes(VALID_CORRECTION.wrongCategory.replace(/_/g, ' ')));
  assert.ok(result.logEntry.humanSummary.includes(VALID_CORRECTION.correctCategory.replace(/_/g, ' ')));
});

test('recordClassificationCorrectionAndLog does NOT add humanSummary on a duplicate (no-op) correction', () => {
  const logPath = tempLogPath();
  const correctionsPath = join(TMP_DIR, `corrections-${randomUUID()}.json`);
  recordClassificationCorrectionAndLog(VALID_CORRECTION, { logPath, correctionsPath });
  const result = recordClassificationCorrectionAndLog(VALID_CORRECTION, { logPath, correctionsPath });

  assert.equal(result.recorded, false);
  assert.equal(result.duplicate, true);
  assert.equal(result.logEntry.humanSummary, undefined);
});

test('checkForSuggestedRuleAndLog adds a plain-English humanSummary when a suggestion is created', () => {
  const logPath = tempLogPath();
  const correctionsPath = join(TMP_DIR, `corrections-${randomUUID()}.json`);
  const queueDir = join(TMP_DIR, `queue-${randomUUID()}`);

  for (let i = 0; i < SUGGESTION_THRESHOLD; i++) {
    recordClassificationCorrectionAndLog({ ...VALID_CORRECTION, requestId: `REQ-${i}` }, { logPath, correctionsPath });
  }
  const result = checkForSuggestedRuleAndLog({ logPath, correctionsPath, queueDir });

  assert.equal(result.suggested, true);
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /repeated correction pattern/);
  assert.match(result.logEntry.humanSummary, /human approval/);
});

test('checkForSuggestedRuleAndLog does NOT add humanSummary when no suggestion is created', () => {
  const logPath = tempLogPath();
  const correctionsPath = join(TMP_DIR, `corrections-${randomUUID()}.json`);
  const queueDir = join(TMP_DIR, `queue-${randomUUID()}`);
  const result = checkForSuggestedRuleAndLog({ logPath, correctionsPath, queueDir });

  assert.equal(result.suggested, false);
  assert.equal(result.logEntry.humanSummary, undefined);
});

test('reviewSuggestedRuleAndLog adds a plain-English humanSummary on approve', () => {
  const logPath = tempLogPath();
  const rulesPath = join(TMP_DIR, `rules-${randomUUID()}.json`);
  const result = reviewSuggestedRuleAndLog(VALID_SUGGESTION, { action: 'approve', reviewer: 'agent.jane' }, { logPath, rulesPath });

  assert.equal(result.outcome, 'approved');
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /approved/i);
  assert.match(result.logEntry.humanSummary, /active/i);
});

test('reviewSuggestedRuleAndLog adds a plain-English humanSummary on reject, naming the real reason', () => {
  const logPath = tempLogPath();
  const decision = { action: 'reject', reviewer: 'agent.jane', reason: 'Too narrow a signal to generalize' };
  const result = reviewSuggestedRuleAndLog(VALID_SUGGESTION, decision, { logPath });

  assert.equal(result.outcome, 'rejected');
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /rejected/i);
  assert.ok(result.logEntry.humanSummary.includes('Too narrow a signal to generalize'));
});

test('reviewSuggestedRuleAndLog does NOT add humanSummary when the suggestion is malformed (fails closed)', () => {
  const logPath = tempLogPath();
  const result = reviewSuggestedRuleAndLog({ type: 'not_a_suggestion' }, { action: 'approve', reviewer: 'agent.jane' }, { logPath });

  assert.equal(result.outcome, 'error');
  assert.equal(result.logEntry.humanSummary, undefined);
});

test('revokeApprovedRuleAndLog adds a plain-English humanSummary naming the keyword and category', () => {
  const logPath = tempLogPath();
  const rulesPath = join(TMP_DIR, `rules-${randomUUID()}.json`);
  applyApprovedClassificationRule({ keyword: 'gadget', category: 'sql_database_issue' }, { rulesPath });

  const result = revokeApprovedRuleAndLog({ keyword: 'gadget', reason: 'Too broad.', reviewer: 'agent.jane' }, { logPath, rulesPath });

  assert.equal(result.revoked, true);
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.ok(result.logEntry.humanSummary.includes('gadget'));
  assert.ok(result.logEntry.humanSummary.includes('sql database issue'));
  assert.match(result.logEntry.humanSummary, /future classifications/);
  assert.match(result.logEntry.humanSummary, /unchanged/);
});

test('revokeApprovedRuleAndLog does NOT add humanSummary when the rule was already revoked (no-op)', () => {
  const logPath = tempLogPath();
  const rulesPath = join(TMP_DIR, `rules-${randomUUID()}.json`);
  applyApprovedClassificationRule({ keyword: 'sprocket-2', category: 'data_issue' }, { rulesPath });
  revokeApprovedRuleAndLog({ keyword: 'sprocket-2', reason: 'First revoke.', reviewer: 'agent.jane' }, { logPath, rulesPath });

  const result = revokeApprovedRuleAndLog({ keyword: 'sprocket-2', reason: 'Second revoke.', reviewer: 'agent.jane' }, { logPath, rulesPath });

  assert.equal(result.revoked, false);
  assert.equal(result.alreadyRevoked, true);
  assert.equal(result.logEntry.humanSummary, undefined);
});

test('revokeApprovedRuleAndLog does NOT add humanSummary when the rule is not found (failure)', () => {
  const logPath = tempLogPath();
  const rulesPath = join(TMP_DIR, `rules-${randomUUID()}.json`);
  const result = revokeApprovedRuleAndLog({ keyword: 'nonexistent-2', reason: 'irrelevant', reviewer: 'agent.jane' }, { logPath, rulesPath });

  assert.equal(result.ok, false);
  assert.equal(result.notFound, true);
  assert.equal(result.logEntry.humanSummary, undefined);
});

test('proposeKnowledgeBaseArticleAndLog adds a plain-English humanSummary on a successful proposal', () => {
  const logPath = tempLogPath();
  const kbPath = tempKbPath();
  const queueDir = join(TMP_DIR, `kb-queue-${randomUUID()}`);
  const result = proposeKnowledgeBaseArticleAndLog(VALID_KB_PROPOSAL, { logPath, kbPath, queueDir });

  assert.equal(result.proposed, true);
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /proposed/);
  assert.match(result.logEntry.humanSummary, /awaiting human approval/);
});

test('proposeKnowledgeBaseArticleAndLog does NOT add humanSummary on a duplicate (no-op) proposal', () => {
  const logPath = tempLogPath();
  const kbPath = tempKbPath();
  const queueDir = join(TMP_DIR, `kb-queue-${randomUUID()}`);
  proposeKnowledgeBaseArticleAndLog(VALID_KB_PROPOSAL, { logPath, kbPath, queueDir });

  const result = proposeKnowledgeBaseArticleAndLog(VALID_KB_PROPOSAL, { logPath, kbPath, queueDir });

  assert.equal(result.proposed, false);
  assert.equal(result.duplicate, true);
  assert.equal(result.logEntry.humanSummary, undefined);
});

test('reviewKnowledgeBaseProposalAndLog adds a plain-English humanSummary on approve', () => {
  const logPath = tempLogPath();
  const kbPath = tempKbPath();
  const queueDir = join(TMP_DIR, `kb-queue-${randomUUID()}`);
  const summariesDir = join(TMP_DIR, `summaries-${randomUUID()}`);
  const { proposalId } = proposeKnowledgeBaseArticleAndLog(VALID_KB_PROPOSAL, { logPath, kbPath, queueDir });

  const result = reviewKnowledgeBaseProposalAndLog(
    proposalId,
    { action: 'approve', reviewer: 'agent.jane' },
    { logPath, kbPath, queueDir, summariesDir },
  );

  assert.equal(result.outcome, 'approved');
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /approved/i);
  assert.match(result.logEntry.humanSummary, /added to the knowledge base/);
});

test('reviewKnowledgeBaseProposalAndLog adds a plain-English humanSummary on reject', () => {
  const logPath = tempLogPath();
  const kbPath = tempKbPath();
  const queueDir = join(TMP_DIR, `kb-queue-${randomUUID()}`);
  const { proposalId } = proposeKnowledgeBaseArticleAndLog(VALID_KB_PROPOSAL, { logPath, kbPath, queueDir });

  const result = reviewKnowledgeBaseProposalAndLog(proposalId, { action: 'reject', reviewer: 'agent.jane' }, { logPath, kbPath, queueDir });

  assert.equal(result.outcome, 'rejected');
  assert.equal(typeof result.logEntry.humanSummary, 'string');
  assert.match(result.logEntry.humanSummary, /rejected/i);
});

test('reviewKnowledgeBaseProposalAndLog does NOT add humanSummary when the input is malformed (fails closed)', () => {
  const logPath = tempLogPath();
  const result = reviewKnowledgeBaseProposalAndLog('', { action: 'approve', reviewer: 'agent.jane' }, { logPath });

  assert.equal(result.outcome, 'error');
  assert.equal(result.logEntry.humanSummary, undefined);
});
