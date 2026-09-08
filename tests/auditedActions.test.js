import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyAndLog,
  reviewAndLog,
  recordClassificationCorrectionAndLog,
  checkForSuggestedRuleAndLog,
  reviewSuggestedRuleAndLog,
  proposeKnowledgeBaseArticleAndLog,
  reviewKnowledgeBaseProposalAndLog,
} from '../src/auditedActions.js';
import { classifySupportRequest } from '../src/classify.js';
import { SUGGESTION_THRESHOLD } from '../src/classificationCorrections.js';

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

test('reviewKnowledgeBaseProposalAndLog on approve persists one logEntry and writes the article', () => {
  const logPath = tempLogPath();
  const kbPath = tempKbPath();
  const queueDir = join(TMP_DIR, `kb-queue-${randomUUID()}`);
  const { proposalId } = proposeKnowledgeBaseArticleAndLog(VALID_KB_PROPOSAL, { logPath, kbPath, queueDir });

  const result = reviewKnowledgeBaseProposalAndLog(proposalId, { action: 'approve', reviewer: 'agent.jane' }, { logPath, kbPath, queueDir });

  assert.equal(result.outcome, 'approved');
  assert.equal(result.auditResult.ok, true);
  const lines = readLines(logPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].entry.event, 'kb_article_proposed');
  assert.equal(lines[1].entry.event, 'kb_proposal_approved');
  assert.equal(lines[1].prevHash, lines[0].hash);

  const onDisk = JSON.parse(readFileSync(kbPath, 'utf8'));
  assert.ok(onDisk.articles.some((a) => a.id === proposalId));
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
