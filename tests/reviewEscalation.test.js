import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewEscalation } from '../src/reviewEscalation.js';
import { reviewEscalationAndLog } from '../src/auditedActions.js';
import { generateEscalationRecommendation } from '../src/generateEscalationRecommendation.js';

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `reviewEscalation-${randomUUID()}`);

function tempPath(name) {
  return join(TMP_DIR, `${name}-${randomUUID()}`);
}

function readLinesFrom(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

const VALID_CLASSIFICATION = {
  category: 'sql_database_issue',
  priority: 'high',
  summary: 'Query is timing out on the reporting database.',
};

const NOT_FOUND_KB_RESULT = { found: false, confidence: 'none', results: [], message: 'no match' };
const FOUND_KB_RESULT = {
  found: true,
  confidence: 'high',
  results: [{ id: 'kb-1', title: 'fix', category: 'sql_database_issue', steps: ['step'], score: 4, confidence: 'high' }],
};

const RECOMMENDED = generateEscalationRecommendation(VALID_CLASSIFICATION, NOT_FOUND_KB_RESULT);
const NOT_RECOMMENDED = generateEscalationRecommendation(VALID_CLASSIFICATION, FOUND_KB_RESULT);

// --- Happy path: approve -------------------------------------------------------

test('approve returns ok, outcome approved, and echoes the recommendation', () => {
  const result = reviewEscalation(RECOMMENDED, { action: 'approve', reviewer: 'agent.jane' });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'approved');
  assert.deepEqual(result.recommendation, RECOMMENDED);
});

test('approve does not add any execution/sent/completed flag to the recommendation', () => {
  const result = reviewEscalation(RECOMMENDED, { action: 'approve', reviewer: 'agent.jane' });
  assert.equal(result.recommendation.action.executed, undefined);
  assert.equal(result.recommendation.action.escalated, undefined);
  assert.equal(result.recommendation.action.status, 'proposed');
});

test('approve logs a success entry with the reviewer and decision in context', () => {
  const result = reviewEscalation(RECOMMENDED, { action: 'approve', reviewer: 'agent.jane' });
  assert.equal(result.logEntry.service, 'reviewEscalation');
  assert.equal(result.logEntry.event, 'escalation_approved');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.level, 'info');
  assert.equal(result.logEntry.context.escalationReason, 'no_knowledge_base_match');
  assert.equal(result.logEntry.context.action, 'approve');
  assert.equal(result.logEntry.context.reviewer, 'agent.jane');
  assert.ok(!Number.isNaN(Date.parse(result.logEntry.timestamp)));
});

// --- Happy path: reject --------------------------------------------------------

test('reject returns ok and outcome rejected', () => {
  const result = reviewEscalation(RECOMMENDED, {
    action: 'reject',
    reviewer: 'agent.jane',
    reason: 'Agent believes this can still be resolved without escalating.',
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.reason, 'Agent believes this can still be resolved without escalating.');
});

test('reject without a reason still succeeds, with reason set to null', () => {
  const result = reviewEscalation(RECOMMENDED, { action: 'reject', reviewer: 'agent.jane' });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.reason, null);
});

test('reject logs a success entry (the review decision itself was recorded correctly)', () => {
  const result = reviewEscalation(RECOMMENDED, { action: 'reject', reviewer: 'agent.jane', reason: 'not needed' });
  assert.equal(result.logEntry.event, 'escalation_rejected');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.context.action, 'reject');
  assert.equal(result.logEntry.context.reviewer, 'agent.jane');
  assert.equal(result.logEntry.context.reason, 'not needed');
});

// --- Failure path: malformed recommendation (fails closed) -------------------

test('rejected: a not-recommended result cannot be reviewed as an escalation', () => {
  const result = reviewEscalation(NOT_RECOMMENDED, { action: 'approve', reviewer: 'agent.jane' });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'error');
  assert.equal(result.reason, 'invalid_recommendation');
});

test('rejected: a recommendation missing its action is refused', () => {
  const result = reviewEscalation({ recommended: true, action: null }, { action: 'approve', reviewer: 'agent.jane' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_recommendation');
});

test('rejected: an action not shaped as guardrail requires (missing requiresApproval) is refused', () => {
  const tampered = {
    recommended: true,
    action: { type: 'escalate', status: 'proposed' }, // requiresApproval missing
  };
  const result = reviewEscalation(tampered, { action: 'approve', reviewer: 'agent.jane' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_recommendation');
});

test('rejected: null, non-object, and array recommendations never throw', () => {
  const badInputs = [null, undefined, 'not an object', 42, [], []];
  for (const bad of badInputs) {
    const result = reviewEscalation(bad, { action: 'approve', reviewer: 'agent.jane' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_recommendation');
  }
});

test('malformed-recommendation failures are still logged, with a failure outcome', () => {
  const result = reviewEscalation(null, { action: 'approve', reviewer: 'agent.jane' });
  assert.equal(result.logEntry.event, 'escalation_review_failed');
  assert.equal(result.logEntry.outcome, 'failure');
  assert.equal(result.logEntry.level, 'warn');
  assert.equal(result.logEntry.error_class, 'ValidationError');
});

// --- Failure path: malformed decision (fails closed) --------------------------

test('malformed decision is rejected: invalid action', () => {
  const result = reviewEscalation(RECOMMENDED, { action: 'auto_approve', reviewer: 'agent.jane' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_decision');
});

test('malformed decision is rejected: missing reviewer', () => {
  const result = reviewEscalation(RECOMMENDED, { action: 'approve' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_decision');
});

test('malformed decision is rejected: blank/whitespace-only reviewer', () => {
  const result = reviewEscalation(RECOMMENDED, { action: 'approve', reviewer: '   ' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_decision');
});

test('malformed decision is rejected: null or non-object decision, never throws', () => {
  for (const bad of [null, undefined, 'approve', 42]) {
    const result = reviewEscalation(RECOMMENDED, bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_decision');
  }
});

// --- Trust: the escalation decision is persisted (STORY-006 acceptance) --------

test('reviewEscalationAndLog persists the review logEntry to the audit trail', () => {
  const logPath = tempPath('audit.log');
  const result = reviewEscalationAndLog(RECOMMENDED, { action: 'approve', reviewer: 'agent.jane' }, { logPath });

  assert.equal(result.outcome, 'approved');
  assert.equal(result.auditResult.ok, true);
  const [record] = readLinesFrom(logPath);
  assert.equal(record.entry.event, 'escalation_approved');
  assert.equal(record.entry.context.reviewer, 'agent.jane');
});

test('reviewEscalationAndLog still logs a failure entry when the recommendation is malformed', () => {
  const logPath = tempPath('audit.log');
  const result = reviewEscalationAndLog(NOT_RECOMMENDED, { action: 'approve', reviewer: 'agent.jane' }, { logPath });

  assert.equal(result.ok, false);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLinesFrom(logPath);
  assert.equal(record.entry.outcome, 'failure');
  assert.equal(record.entry.error_class, 'ValidationError');
});

// --- Purity / idempotency ------------------------------------------------------

test('reviewEscalation is pure: same input yields the same outcome on repeat calls', () => {
  const decision = { action: 'approve', reviewer: 'agent.jane' };
  const first = reviewEscalation(RECOMMENDED, decision);
  const second = reviewEscalation(RECOMMENDED, decision);
  assert.equal(first.ok, second.ok);
  assert.equal(first.outcome, second.outcome);
  assert.deepEqual(first.recommendation, second.recommendation);
});
