import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateEscalationRecommendation } from '../src/generateEscalationRecommendation.js';
import { generateEscalationRecommendationAndLog } from '../src/auditedActions.js';
import { validateAssistantOutput } from '../src/guardrail.js';
import { presentToAgent } from '../src/presentToAgent.js';

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `generateEscalationRecommendation-${randomUUID()}`);

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

const NOT_FOUND_KB_RESULT = {
  found: false,
  confidence: 'none',
  results: [],
  message: 'No relevant troubleshooting steps were found in the knowledge base for this request.',
};

const FOUND_KB_RESULT = {
  found: true,
  confidence: 'high',
  results: [
    { id: 'kb-1', title: 'Reporting DB timeout fix', category: 'sql_database_issue', steps: ['Restart the connector'], score: 4, confidence: 'high' },
  ],
};

// --- Happy path: escalation recommended (found: false) -----------------------

test('recommends escalation when the knowledge base found nothing', () => {
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, NOT_FOUND_KB_RESULT);
  assert.equal(result.ok, true);
  assert.equal(result.recommended, true);
  assert.equal(result.reason, 'no_knowledge_base_match');
});

test('a recommended escalation always carries a non-empty explanation', () => {
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, NOT_FOUND_KB_RESULT);
  assert.equal(typeof result.explanation, 'string');
  assert.ok(result.explanation.length > 0);
  assert.match(result.explanation, /sql\/database issue/i);
});

test('a recommended escalation builds a guardrail-shaped, human-approvable action', () => {
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, NOT_FOUND_KB_RESULT);
  assert.equal(result.action.type, 'escalate');
  assert.equal(result.action.requiresApproval, true);
  assert.equal(result.action.status, 'proposed');
  assert.equal(result.action.description, result.explanation);
});

test('escalation is also recommended when the KB search itself failed (found: false)', () => {
  const kbFailure = { found: false, confidence: 'none', results: [], message: 'Knowledge base search failed: timeout.' };
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, kbFailure);
  assert.equal(result.recommended, true);
  assert.equal(result.reason, 'no_knowledge_base_match');
});

test('logs a success entry with recommended:true in context', () => {
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, NOT_FOUND_KB_RESULT);
  assert.equal(result.logEntry.service, 'generateEscalationRecommendation');
  assert.equal(result.logEntry.event, 'escalation_recommended');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.level, 'info');
  assert.equal(result.logEntry.context.category, 'sql_database_issue');
  assert.equal(result.logEntry.context.recommended, true);
  assert.ok(!Number.isNaN(Date.parse(result.logEntry.timestamp)));
});

// --- Integration: the recommended action actually clears the R4 guardrail ----

test('the recommended action passes guardrail.js validateAssistantOutput', () => {
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, NOT_FOUND_KB_RESULT);
  const check = validateAssistantOutput({ summary: result.explanation, recommendedActions: [result.action] });
  assert.equal(check.safe, true);
  assert.deepEqual(check.violations, []);
});

test('the recommended action reaches presentToAgent as pendingApproval, not auto-executed', () => {
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, NOT_FOUND_KB_RESULT);
  const presented = presentToAgent({ summary: result.explanation, recommendedActions: [result.action] });
  assert.equal(presented.ok, true);
  assert.equal(presented.blocked, false);
  assert.deepEqual(presented.pendingApproval, [result.action]);
});

// --- Happy path: escalation NOT recommended (found: true) --------------------

test('does not recommend escalation when the knowledge base found a match', () => {
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, FOUND_KB_RESULT);
  assert.equal(result.ok, true);
  assert.equal(result.recommended, false);
  assert.equal(result.reason, 'resolved_by_knowledge_base');
  assert.equal(result.action, null);
});

test('a not-recommended result still carries a non-empty explanation', () => {
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, FOUND_KB_RESULT);
  assert.equal(typeof result.explanation, 'string');
  assert.ok(result.explanation.length > 0);
});

test('does not recommend escalation for a low-confidence-but-found match', () => {
  const lowConfidence = { found: true, confidence: 'low', results: [{ id: 'kb-2', title: 'Maybe related', category: 'sql_database_issue', steps: ['Try this'], score: 1, confidence: 'low' }], message: 'Low-confidence match.' };
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, lowConfidence);
  assert.equal(result.recommended, false);
});

// --- Failure path: malformed classification (fails closed) -------------------

test('malformed classification is rejected: missing category', () => {
  const result = generateEscalationRecommendation({ priority: 'high' }, NOT_FOUND_KB_RESULT);
  assert.equal(result.ok, false);
  assert.equal(result.recommended, false);
  assert.equal(result.reason, 'invalid_classification');
  assert.equal(result.action, null);
});

test('malformed classification is rejected: unrecognized category', () => {
  const result = generateEscalationRecommendation({ category: 'not_a_real_category' }, NOT_FOUND_KB_RESULT);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_classification');
});

test('malformed classification is rejected: null, non-object, and array inputs never throw', () => {
  const badInputs = [null, undefined, 'not an object', 42, [], []];
  for (const bad of badInputs) {
    const result = generateEscalationRecommendation(bad, NOT_FOUND_KB_RESULT);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_classification');
  }
});

test('malformed-classification failures are still logged, with a failure outcome', () => {
  const result = generateEscalationRecommendation(null, NOT_FOUND_KB_RESULT);
  assert.equal(result.logEntry.event, 'escalation_recommendation_failed');
  assert.equal(result.logEntry.outcome, 'failure');
  assert.equal(result.logEntry.level, 'warn');
  assert.equal(result.logEntry.error_class, 'ValidationError');
});

// --- Failure path: malformed kbSearchResult (fails closed) -------------------

test('malformed kbSearchResult is rejected: missing found field', () => {
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, { results: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_kb_search_result');
  assert.equal(result.action, null);
});

test('malformed kbSearchResult is rejected: null, non-object, and array inputs never throw', () => {
  const badInputs = [null, undefined, 'not an object', 42, [], []];
  for (const bad of badInputs) {
    const result = generateEscalationRecommendation(VALID_CLASSIFICATION, bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_kb_search_result');
  }
});

test('malformed-kbSearchResult failures are still logged, with a failure outcome', () => {
  const result = generateEscalationRecommendation(VALID_CLASSIFICATION, {});
  assert.equal(result.logEntry.event, 'escalation_recommendation_failed');
  assert.equal(result.logEntry.outcome, 'failure');
  assert.equal(result.logEntry.error_class, 'ValidationError');
});

// --- Trust: the escalation recommendation is persisted (STORY-006 acceptance) --

test('generateEscalationRecommendationAndLog persists the recommendation logEntry to the audit trail', () => {
  const logPath = tempPath('audit.log');
  const result = generateEscalationRecommendationAndLog(VALID_CLASSIFICATION, NOT_FOUND_KB_RESULT, { logPath });

  assert.equal(result.recommended, true);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLinesFrom(logPath);
  assert.equal(record.entry.event, 'escalation_recommended');
  assert.equal(record.entry.context.category, 'sql_database_issue');
});

test('generateEscalationRecommendationAndLog still logs a failure entry when the classification is malformed', () => {
  const logPath = tempPath('audit.log');
  const result = generateEscalationRecommendationAndLog({ category: 'nonsense' }, NOT_FOUND_KB_RESULT, { logPath });

  assert.equal(result.ok, false);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLinesFrom(logPath);
  assert.equal(record.entry.outcome, 'failure');
  assert.equal(record.entry.error_class, 'ValidationError');
});

// --- Purity / idempotency ------------------------------------------------------

test('generateEscalationRecommendation is pure: same input yields the same outcome on repeat calls', () => {
  const first = generateEscalationRecommendation(VALID_CLASSIFICATION, NOT_FOUND_KB_RESULT);
  const second = generateEscalationRecommendation(VALID_CLASSIFICATION, NOT_FOUND_KB_RESULT);
  assert.equal(first.ok, second.ok);
  assert.equal(first.recommended, second.recommended);
  assert.equal(first.explanation, second.explanation);
  assert.deepEqual(first.action, second.action);
});
