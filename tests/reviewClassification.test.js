import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewClassification } from '../src/reviewClassification.js';
import { classifySupportRequest } from '../src/classify.js';

const VALID_CLASSIFICATION = {
  category: 'login_problem',
  priority: 'high',
  summary: "Can't log in, account is locked out.",
};

// --- Happy path: approve ------------------------------------------------------

test('approve returns ok, outcome approved, and echoes the classification', () => {
  const result = reviewClassification(VALID_CLASSIFICATION, {
    action: 'approve',
    reviewer: 'agent.jane',
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'approved');
  assert.deepEqual(result.classification, VALID_CLASSIFICATION);
});

test('approve logs a success entry with the reviewer and decision in context', () => {
  const result = reviewClassification(VALID_CLASSIFICATION, {
    action: 'approve',
    reviewer: 'agent.jane',
  });
  assert.equal(result.logEntry.service, 'reviewClassification');
  assert.equal(result.logEntry.event, 'classification_approved');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.level, 'info');
  assert.equal(result.logEntry.context.category, 'login_problem');
  assert.equal(result.logEntry.context.priority, 'high');
  assert.equal(result.logEntry.context.action, 'approve');
  assert.equal(result.logEntry.context.reviewer, 'agent.jane');
  assert.ok(!Number.isNaN(Date.parse(result.logEntry.timestamp)));
});

// --- Happy path: reject -------------------------------------------------------

test('reject returns ok, outcome rejected, and signals pending reclassification', () => {
  const result = reviewClassification(VALID_CLASSIFICATION, {
    action: 'reject',
    reviewer: 'agent.jane',
    reason: 'This is actually an access issue, not a login problem.',
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.status, 'pending_reclassification');
  assert.equal(result.reason, 'This is actually an access issue, not a login problem.');
});

test('reject without a reason still succeeds, with reason set to null', () => {
  const result = reviewClassification(VALID_CLASSIFICATION, {
    action: 'reject',
    reviewer: 'agent.jane',
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.reason, null);
});

test('reject logs a success entry (the review decision itself was recorded correctly)', () => {
  const result = reviewClassification(VALID_CLASSIFICATION, {
    action: 'reject',
    reviewer: 'agent.jane',
    reason: 'wrong category',
  });
  assert.equal(result.logEntry.event, 'classification_rejected');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.context.action, 'reject');
  assert.equal(result.logEntry.context.reviewer, 'agent.jane');
  assert.equal(result.logEntry.context.reason, 'wrong category');
});

// --- Acceptance: reject sends the request back for reclassification ----------

test('a rejected classification can be sent back through classifySupportRequest for reclassification', () => {
  const originalText = "I can't log in, it's locked out after too many attempts.";
  const firstPass = classifySupportRequest(originalText);

  const review = reviewClassification(firstPass, {
    action: 'reject',
    reviewer: 'agent.jane',
    reason: 'misclassified',
  });
  assert.equal(review.status, 'pending_reclassification');

  // The reclassification loop closes by re-running the existing, already-tested
  // classifier on the original request text — reviewClassification does not
  // duplicate that logic.
  const secondPass = classifySupportRequest(originalText);
  assert.equal(secondPass.category, firstPass.category);
  assert.equal(secondPass.priority, firstPass.priority);
});

// --- Failure path: malformed classification (fails closed) -------------------

test('malformed classification is rejected: missing category', () => {
  const result = reviewClassification(
    { priority: 'high' },
    { action: 'approve', reviewer: 'agent.jane' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'error');
  assert.equal(result.reason, 'invalid_classification');
});

test('malformed classification is rejected: missing priority', () => {
  const result = reviewClassification(
    { category: 'login_problem' },
    { action: 'approve', reviewer: 'agent.jane' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_classification');
});

test('malformed classification is rejected: null, non-object, and array inputs never throw', () => {
  const badInputs = [null, undefined, 'not an object', 42, [], []];
  for (const bad of badInputs) {
    const result = reviewClassification(bad, { action: 'approve', reviewer: 'agent.jane' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_classification');
  }
});

test('malformed-classification failures are still logged, with a failure outcome', () => {
  const result = reviewClassification(null, { action: 'approve', reviewer: 'agent.jane' });
  assert.equal(result.logEntry.event, 'classification_review_failed');
  assert.equal(result.logEntry.outcome, 'failure');
  assert.equal(result.logEntry.level, 'warn');
  assert.equal(result.logEntry.error_class, 'ValidationError');
});

// --- Failure path: malformed decision (fails closed) --------------------------

test('malformed decision is rejected: invalid action', () => {
  const result = reviewClassification(VALID_CLASSIFICATION, {
    action: 'auto_approve',
    reviewer: 'agent.jane',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_decision');
});

test('malformed decision is rejected: missing reviewer', () => {
  const result = reviewClassification(VALID_CLASSIFICATION, { action: 'approve' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_decision');
});

test('malformed decision is rejected: blank/whitespace-only reviewer', () => {
  const result = reviewClassification(VALID_CLASSIFICATION, { action: 'approve', reviewer: '   ' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_decision');
});

test('malformed decision is rejected: null or non-object decision, never throws', () => {
  for (const bad of [null, undefined, 'approve', 42]) {
    const result = reviewClassification(VALID_CLASSIFICATION, bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_decision');
  }
});

// --- Purity / idempotency ------------------------------------------------------

test('reviewClassification is pure: same input yields the same outcome on repeat calls', () => {
  const decision = { action: 'approve', reviewer: 'agent.jane' };
  const first = reviewClassification(VALID_CLASSIFICATION, decision);
  const second = reviewClassification(VALID_CLASSIFICATION, decision);
  assert.equal(first.ok, second.ok);
  assert.equal(first.outcome, second.outcome);
  assert.deepEqual(first.classification, second.classification);
});
