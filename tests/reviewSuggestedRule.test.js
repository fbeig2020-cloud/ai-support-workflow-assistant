import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewSuggestedRule } from '../src/reviewSuggestedRule.js';

const VALID_SUGGESTION = {
  type: 'suggested_rule_change',
  keyword: 'widget',
  wrongCategory: 'sql_database_issue',
  correctCategory: 'general_support_request',
  timesSeen: 3,
};

// --- Happy path: approve -------------------------------------------------------

test('approve returns ok, outcome approved, and echoes the suggestion', () => {
  const result = reviewSuggestedRule(VALID_SUGGESTION, { action: 'approve', reviewer: 'agent.jane' });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'approved');
  assert.deepEqual(result.suggestion, VALID_SUGGESTION);
});

test('approve logs a success entry with the pattern and decision in context', () => {
  const result = reviewSuggestedRule(VALID_SUGGESTION, { action: 'approve', reviewer: 'agent.jane' });
  assert.equal(result.logEntry.service, 'reviewSuggestedRule');
  assert.equal(result.logEntry.event, 'rule_suggestion_approved');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.level, 'info');
  assert.equal(result.logEntry.context.keyword, 'widget');
  assert.equal(result.logEntry.context.correctCategory, 'general_support_request');
  assert.equal(result.logEntry.context.action, 'approve');
  assert.equal(result.logEntry.context.reviewer, 'agent.jane');
  assert.ok(!Number.isNaN(Date.parse(result.logEntry.timestamp)));
});

// --- Happy path: reject --------------------------------------------------------

test('reject returns ok and outcome rejected', () => {
  const result = reviewSuggestedRule(VALID_SUGGESTION, {
    action: 'reject',
    reviewer: 'agent.jane',
    reason: 'This keyword is too generic to hard-code a category for.',
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.reason, 'This keyword is too generic to hard-code a category for.');
  assert.deepEqual(result.suggestion, VALID_SUGGESTION);
});

test('reject with no reason defaults reason to null, not undefined', () => {
  const result = reviewSuggestedRule(VALID_SUGGESTION, { action: 'reject', reviewer: 'agent.jane' });
  assert.equal(result.reason, null);
});

test('reject logs a success entry (rejecting is a valid, logged decision, not a failure)', () => {
  const result = reviewSuggestedRule(VALID_SUGGESTION, { action: 'reject', reviewer: 'agent.jane' });
  assert.equal(result.logEntry.event, 'rule_suggestion_rejected');
  assert.equal(result.logEntry.outcome, 'success');
});

// --- Malformed suggestion (fail closed, never throw) ---------------------------

test('malformed suggestion shapes fail closed with invalid_suggestion, never throw', () => {
  const badSuggestions = [
    null,
    undefined,
    42,
    [],
    {},
    { ...VALID_SUGGESTION, type: 'ticket' },
    { ...VALID_SUGGESTION, type: undefined },
    { ...VALID_SUGGESTION, keyword: '' },
    { ...VALID_SUGGESTION, wrongCategory: '' },
    { ...VALID_SUGGESTION, correctCategory: '' },
    { ...VALID_SUGGESTION, timesSeen: 2 }, // below SUGGESTION_THRESHOLD
    { ...VALID_SUGGESTION, timesSeen: 'three' },
  ];

  for (const bad of badSuggestions) {
    const decision = { action: 'approve', reviewer: 'agent.jane' };
    assert.doesNotThrow(() => reviewSuggestedRule(bad, decision));
    const result = reviewSuggestedRule(bad, decision);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'error');
    assert.equal(result.reason, 'invalid_suggestion');
    assert.equal(result.logEntry.outcome, 'failure');
    assert.equal(result.logEntry.error_class, 'ValidationError');
  }
});

// --- Malformed decision (fail closed, never throw) -----------------------------

test('malformed decision shapes fail closed with invalid_decision, never throw', () => {
  const badDecisions = [
    null,
    undefined,
    42,
    [],
    {},
    { action: 'delete', reviewer: 'agent.jane' },
    { action: 'approve', reviewer: '' },
    { action: 'approve' },
  ];

  for (const bad of badDecisions) {
    assert.doesNotThrow(() => reviewSuggestedRule(VALID_SUGGESTION, bad));
    const result = reviewSuggestedRule(VALID_SUGGESTION, bad);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'error');
    assert.equal(result.reason, 'invalid_decision');
  }
});

// --- Purity / idempotency --------------------------------------------------------

test('review is pure: same input twice yields the same result', () => {
  const decision = { action: 'approve', reviewer: 'agent.jane' };
  const first = reviewSuggestedRule(VALID_SUGGESTION, decision);
  const second = reviewSuggestedRule(VALID_SUGGESTION, decision);
  assert.equal(first.outcome, second.outcome);
  assert.deepEqual(first.suggestion, second.suggestion);
});
